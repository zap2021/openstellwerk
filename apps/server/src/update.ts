import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";

/*
 * Update (Issue #1): holt neue Versionen von der Git-Plattform (Forgejo/Gitea, Standard git.wuelfi.ng) und spielt sie ein.
 *
 * Ablauf einer Installation, alles als Dienstbenutzer und ohne root:
 *   1. Archiv des Release-Tags laden und in einen Arbeitsordner entpacken
 *   2. dort `npm ci` und `npm run build`
 *   3. Probelauf: die neue Version startet auf einem freien Port mit leerem Datenordner und muss antworten
 *   4. die laufende Installation nach <Arbeitsordner>/previous sichern
 *   5. die neue Version über die Installation kopieren und den Prozess beenden; systemd startet ihn neu
 * Scheitert ein Schritt vor 5, bleibt die laufende Installation unberührt. Die Anwendungsdaten werden nie angefasst.
 */

export type UpdatePhase = "idle" | "downloading" | "installing" | "building" | "testing" | "switching" | "restarting" | "failed";

export interface UpdateView {
  current: string;
  latest?: string;
  notes?: string;
  available: boolean;
  checkedAt?: number;
  /** warum die Prüfung nicht ging */
  error?: string;
  phase: UpdatePhase;
  /** Fortschritt der laufenden oder letzten Installation */
  log: string[];
  /** warum gerade nicht installiert werden kann */
  blocked?: string;
  lastUpdate?: { from: string; to: string; at: number };
}

export interface UpdateConfig {
  /** Basis-URL der Git-Plattform, z. B. https://git.wuelfi.ng */
  baseUrl: string;
  /** "besitzer/repository" */
  repo: string;
  /** Zugriffstoken, wenn das Repository nicht öffentlich ist */
  token?: string;
  /** Verzeichnis der laufenden Installation (Projektstamm) */
  installDir: string;
  /** Arbeitsordner im Datenordner */
  workDir: string;
  current: string;
}

export interface UpdateDeps {
  fetch?: typeof fetch;
  /** Befehl ausführen; wirft bei Exit-Code ≠ 0 */
  run?: (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<void>;
  /** Probelauf der neuen Version im Verzeichnis; wirft, wenn sie nicht antwortet */
  smokeTest?: (dir: string) => Promise<void>;
  /** Prozess beenden, damit systemd neu startet */
  restart?: () => void;
  /** Grund, warum gerade nicht aktualisiert werden darf (z. B. angeforderte Fahrstraßen) */
  blocked?: () => string | undefined;
  log?: (text: string, ok: boolean) => void;
  now?: () => number;
}

const err = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** -1, 0, 1 für "1.2.3"-Versionen (ein führendes v und Zusätze wie -beta werden ignoriert). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, "").split(/[-+]/)[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const SAFE_TAG = /^v?\d+(\.\d+){1,3}([-+][A-Za-z0-9.]+)?$/;

/** Befehl ausführen und die letzten Zeilen der Ausgabe in die Fehlermeldung nehmen. */
function runCommand(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (d: Buffer) => { tail = (tail + d.toString("utf8")).slice(-600); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${cmd}: Zeit abgelaufen`)); }, opts.timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`${cmd}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0] ?? ""} endete mit Code ${code}: ${tail.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

/** Die neue Version auf einem freien Port mit leerem Datenordner starten; sie muss innerhalb der Frist antworten. */
async function smokeTest(dir: string, timeoutMs = 120_000): Promise<void> {
  const port = await freePort();
  const data = path.join(dir, ".smoke-data");
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: data, NODE_ENV: "production" };
  delete (env as Record<string, unknown>).OPENSTELLWERK_PASSWORD; delete (env as Record<string, unknown>).Z21_PASSWORD; // a fresh, local instance without accounts
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], { cwd: dir, env, stdio: "ignore" });
  let exited: number | null | undefined;
  child.on("exit", (code) => { exited = code; });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exited !== undefined) throw new Error(`Die neue Version ist beim Start abgestürzt (Code ${exited})`);
      if (Date.now() > deadline) throw new Error("Die neue Version hat beim Probelauf nicht geantwortet");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(data, { recursive: true, force: true });
  }
}

export class UpdateService {
  private latest?: { version: string; tag: string; notes: string };
  private checkedAt?: number;
  private error?: string;
  private phase: UpdatePhase = "idle";
  private log: string[] = [];
  private lastUpdate?: UpdateView["lastUpdate"];
  private timer?: NodeJS.Timeout;
  private fetch: typeof fetch;
  private run: NonNullable<UpdateDeps["run"]>;
  private now: () => number;

  constructor(private cfg: UpdateConfig, private deps: UpdateDeps = {}) {
    this.fetch = deps.fetch ?? fetch;
    this.run = deps.run ?? runCommand;
    this.now = deps.now ?? Date.now;
    try {
      const last = JSON.parse(readFileSync(path.join(cfg.workDir, "last.json"), "utf8")) as { from?: unknown; to?: unknown; at?: unknown };
      if (typeof last.from === "string" && typeof last.to === "string" && typeof last.at === "number") this.lastUpdate = { from: last.from, to: last.to, at: last.at };
    } catch { /* no update yet */ }
  }

  /** Regelmäßig nach neuen Versionen sehen (erste Prüfung kurz nach dem Start). */
  startChecking(everyMs = 12 * 3600_000, firstMs = 30_000) {
    if (this.timer) return;
    const check = () => { void this.check().catch(() => undefined); };
    setTimeout(check, firstMs).unref();
    this.timer = setInterval(check, everyMs);
    this.timer.unref();
  }

  view(): UpdateView {
    const available = !!this.latest && compareVersions(this.latest.version, this.cfg.current) > 0;
    return {
      current: this.cfg.current, latest: this.latest?.version, notes: this.latest?.notes, available, checkedAt: this.checkedAt, error: this.error,
      phase: this.phase, log: this.log, blocked: available ? this.blockedReason() : undefined, lastUpdate: this.lastUpdate,
    };
  }

  /** Kurzfassung für alle angemeldeten Browser. */
  summary(): { current: string; latest?: string; available: boolean } {
    const v = this.view();
    return { current: v.current, latest: v.latest, available: v.available };
  }

  private headers(): Record<string, string> {
    return { accept: "application/json", ...(this.cfg.token ? { authorization: `token ${this.cfg.token}` } : {}) };
  }

  /** Neueste veröffentlichte Version abfragen. Fehler stehen danach in view().error; die Methode wirft nicht. */
  async check(): Promise<UpdateView> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/api/v1/repos/${this.cfg.repo}/releases/latest`;
    this.checkedAt = this.now();
    try {
      const res = await this.fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 || res.status === 403) throw new Error(this.cfg.token ? "Die Git-Plattform lehnt das Zugriffstoken ab (OPENSTELLWERK_UPDATE_TOKEN prüfen)" : "Das Repository ist nicht öffentlich: Zugriffstoken als OPENSTELLWERK_UPDATE_TOKEN in /etc/openstellwerk.env eintragen");
      if (res.status === 404) throw new Error("Kein veröffentlichtes Release gefunden");
      if (!res.ok) throw new Error(`Die Git-Plattform antwortet mit HTTP ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; body?: unknown };
      const tag = typeof body.tag_name === "string" ? body.tag_name : "";
      if (!SAFE_TAG.test(tag)) throw new Error(`Unerwarteter Release-Name „${tag.slice(0, 40)}“`);
      this.latest = { version: tag.replace(/^v/i, ""), tag, notes: typeof body.body === "string" ? body.body.slice(0, 4000) : "" };
      this.error = undefined;
    } catch (e) {
      const m = (e as Error).message;
      this.error = /fetch failed|timeout|aborted|ENOTFOUND|ECONN/i.test(m) ? "Die Git-Plattform ist nicht erreichbar" : m;
    }
    return this.view();
  }

  private blockedReason(): string | undefined {
    if (existsSync(path.join(this.cfg.installDir, ".git"))) return "Diese Installation ist ein Entwicklungs-Checkout (.git vorhanden) und wird nicht überschrieben";
    return this.deps.blocked?.();
  }

  /** Installation starten; läuft im Hintergrund weiter, der Fortschritt steht in view(). */
  install(): UpdateView {
    if (this.phase !== "idle" && this.phase !== "failed") throw err("Es läuft schon ein Update", 409);
    const target = this.latest;
    if (!target || compareVersions(target.version, this.cfg.current) <= 0) throw err("Es gibt keine neuere Version", 409);
    const blocked = this.blockedReason();
    if (blocked) throw err(blocked, 409);
    this.log = [];
    this.phase = "downloading";
    void this.perform(target).catch((e: Error) => {
      this.phase = "failed";
      this.step(`Abgebrochen: ${e.message}`);
      this.deps.log?.(`Update auf ${target.version} abgebrochen: ${e.message}`, false);
    });
    return this.view();
  }

  private step(text: string) { this.log.push(text); if (this.log.length > 40) this.log.shift(); }

  private async perform(target: { version: string; tag: string }) {
    const { workDir, installDir } = this.cfg;
    const staging = path.join(workDir, "staging");
    const archive = path.join(workDir, "release.tar.gz");
    const previous = path.join(workDir, "previous");
    const nodeDir = path.dirname(process.execPath);
    const env = { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, NODE_OPTIONS: "--max-old-space-size=384" };
    this.deps.log?.(`Update von ${this.cfg.current} auf ${target.version} gestartet`, true);

    this.step(`Lade Version ${target.version} …`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const res = await this.fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/api/v1/repos/${this.cfg.repo}/archive/${encodeURIComponent(target.tag)}.tar.gz`, { headers: { ...this.headers(), accept: "application/gzip" }, signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Archiv nicht ladbar (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(archive));
    await this.run("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"], { timeoutMs: 5 * 60_000 });
    let version = "";
    try { version = String((JSON.parse(readFileSync(path.join(staging, "package.json"), "utf8")) as { version?: unknown }).version ?? ""); } catch { /* checked below */ }
    if (version !== target.version) throw new Error(`Das Archiv enthält Version „${version || "?"}“ statt ${target.version}`);

    this.phase = "installing";
    this.step("Installiere Abhängigkeiten (npm ci), das dauert auf einem Raspberry Pi einige Minuten …");
    await this.run("npm", ["ci"], { cwd: staging, env, timeoutMs: 30 * 60_000 });
    this.phase = "building";
    this.step("Baue die Oberfläche …");
    await this.run("npm", ["run", "build"], { cwd: staging, env, timeoutMs: 20 * 60_000 });

    this.phase = "testing";
    this.step("Probelauf der neuen Version …");
    await (this.deps.smokeTest ?? smokeTest)(staging);

    this.phase = "switching";
    const blocked = this.blockedReason(); // minutes have passed: check again before anything is replaced
    if (blocked) throw new Error(blocked);
    this.step("Sichere die bisherige Version …");
    mkdirSync(previous, { recursive: true });
    // A data folder inside the installation (the default without DATA_DIR) is neither copied nor ever deleted.
    await this.run("rsync", ["-a", "--delete", "--exclude=/apps/server/data", `${installDir}/`, `${previous}/`], { timeoutMs: 20 * 60_000 });
    this.step("Spiele die neue Version ein …");
    await this.run("rsync", ["-a", "--delete", "--exclude=/apps/server/data", "--exclude=.smoke-data", `${staging}/`, `${installDir}/`], { timeoutMs: 20 * 60_000 });
    writeFileSync(path.join(workDir, "last.json"), JSON.stringify({ from: this.cfg.current, to: target.version, at: this.now() }));
    rmSync(staging, { recursive: true, force: true });
    rmSync(archive, { force: true });

    this.phase = "restarting";
    this.step("Starte neu …");
    this.deps.log?.(`Version ${target.version} eingespielt, Neustart`, true);
    (this.deps.restart ?? (() => { setTimeout(() => process.exit(75), 1500); }))(); // non-zero: systemd (Restart=on-failure) starts the new version
  }
}

export function registerUpdateRoutes(app: FastifyInstance, service: UpdateService) {
  app.get("/api/update", async () => service.view());
  app.post("/api/update/check", async () => service.check());
  app.post("/api/update/install", async () => service.install());
}
