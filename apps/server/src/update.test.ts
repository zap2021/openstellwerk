import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdateService, compareVersions, type UpdateDeps } from "./update.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "z21-update-")); mkdirSync(path.join(dir, "install")); mkdirSync(path.join(dir, "work")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake platform and fake commands: `tar` writes the package.json of the "release" into the staging folder. */
function setup(o: { release?: unknown; status?: number; archiveVersion?: string; fail?: string; token?: string; blocked?: () => string | undefined; smoke?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const requests: { url: string; auth?: string }[] = [];
  const logged: string[] = [];
  let restarted = false;
  const deps: UpdateDeps = {
    fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
      requests.push({ url, auth: init?.headers?.authorization });
      if (url.includes("/archive/")) return new Response("archive-bytes", { status: 200 });
      return json(o.status ?? 200, o.release ?? { tag_name: "v0.4.0", body: "Neu: alles" });
    }) as unknown as typeof fetch,
    run: async (cmd, args, opts) => {
      calls.push(`${cmd} ${args.filter((a) => !a.includes(dir)).join(" ")}`.trim());
      if (o.fail === `${cmd} ${args[0]}`) throw new Error(`${cmd} ${args[0]} endete mit Code 1`);
      if (cmd === "tar") writeFileSync(path.join(args[3]!, "package.json"), JSON.stringify({ version: o.archiveVersion ?? "0.4.0" }));
      void opts;
    },
    smokeTest: o.smoke ?? (async () => { calls.push("smoke"); }),
    restart: () => { restarted = true; },
    blocked: o.blocked,
    log: (text) => { logged.push(text); },
    now: () => 1_000,
  };
  const service = new UpdateService({ baseUrl: "https://git.example/", repo: "me/z21-web", token: o.token, installDir: path.join(dir, "install"), workDir: path.join(dir, "work"), current: "0.3.0" }, deps);
  const settle = async () => { for (let i = 0; i < 200 && !["idle", "failed", "restarting"].includes(service.view().phase); i++) await new Promise((r) => setTimeout(r, 5)); };
  return { service, calls, requests, logged, settle, restarted: () => restarted };
}

describe("compareVersions", () => {
  it("compares numerically and ignores a leading v and suffixes", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
    expect(compareVersions("0.3.0", "0.3.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(0);
  });
});

describe("UpdateService", () => {
  it("finds a newer release and sends the token", async () => {
    const { service, requests } = setup({ token: "geheim" });
    expect(service.view()).toMatchObject({ current: "0.3.0", available: false, phase: "idle" });
    const v = await service.check();
    expect(v).toMatchObject({ latest: "0.4.0", notes: "Neu: alles", available: true, checkedAt: 1000 });
    expect(v.error).toBeUndefined();
    expect(requests[0]).toEqual({ url: "https://git.example/api/v1/repos/me/z21-web/releases/latest", auth: "token geheim" });
    expect(service.summary()).toEqual({ current: "0.3.0", latest: "0.4.0", available: true });
  });

  it("reports why a check failed and offers nothing", async () => {
    expect((await setup({ status: 403 }).service.check()).error).toMatch(/nicht öffentlich.*Z21_UPDATE_TOKEN/);
    expect((await setup({ status: 401, token: "x" }).service.check()).error).toMatch(/lehnt das Zugriffstoken ab/);
    expect((await setup({ status: 404 }).service.check()).error).toMatch(/Kein veröffentlichtes Release/);
    expect((await setup({ status: 500 }).service.check()).error).toMatch(/HTTP 500/);
    expect((await setup({ release: { tag_name: "v1; rm -rf /" } }).service.check()).error).toMatch(/Unerwarteter Release-Name/);
    const same = setup({ release: { tag_name: "v0.3.0" } });
    expect((await same.service.check()).available).toBe(false);
    expect(() => same.service.install()).toThrow(/keine neuere Version/);
  });

  it("installs: download, npm ci, build, trial run, backup, switch, restart", async () => {
    const { service, calls, requests, logged, settle, restarted } = setup();
    writeFileSync(path.join(dir, "install", "package.json"), "{}");
    await service.check();
    expect(service.install().phase).toBe("downloading");
    expect(() => service.install()).toThrow(/läuft schon/);
    await settle();
    expect(service.view().phase).toBe("restarting");
    expect(calls).toEqual(["tar -xzf -C --strip-components=1", "npm ci", "npm run build", "smoke", "rsync -a --delete --exclude=/apps/server/data", "rsync -a --delete --exclude=/apps/server/data --exclude=.smoke-data"]);
    expect(requests[1]!.url).toBe("https://git.example/api/v1/repos/me/z21-web/archive/v0.4.0.tar.gz");
    expect(restarted()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, "work", "last.json"), "utf8"))).toEqual({ from: "0.3.0", to: "0.4.0", at: 1000 });
    expect(existsSync(path.join(dir, "work", "staging"))).toBe(false);
    expect(logged).toEqual(["Update von 0.3.0 auf 0.4.0 gestartet", "Version 0.4.0 eingespielt, Neustart"]);
    // after the restart the service knows what happened
    expect(setup().service.view().lastUpdate).toEqual({ from: "0.3.0", to: "0.4.0", at: 1000 });
  });

  it("leaves the installation alone when a step before the switch fails", async () => {
    for (const [o, text] of [
      [{ fail: "npm ci" }, /npm ci endete mit Code 1/],
      [{ fail: "npm run" }, /npm run endete/],
      [{ archiveVersion: "9.9.9" }, /enthält Version „9.9.9“ statt 0.4.0/],
      [{ smoke: async () => { throw new Error("Die neue Version ist beim Start abgestürzt (Code 1)"); } }, /abgestürzt/],
    ] as const) {
      const { service, calls, settle, restarted, logged } = setup(o);
      await service.check();
      service.install();
      await settle();
      const v = service.view();
      expect(v.phase).toBe("failed");
      expect(v.log.at(-1)).toMatch(text);
      expect(calls.some((c) => c.startsWith("rsync"))).toBe(false); // nothing was replaced
      expect(restarted()).toBe(false);
      expect(logged.at(-1)).toMatch(/abgebrochen/);
      expect(service.install().phase).toBe("downloading"); // a failed update can be tried again
      await settle();
    }
  });

  it("refuses while something blocks it and never overwrites a development checkout", async () => {
    let reason: string | undefined = "Es sind noch Fahrstraßen angefordert";
    const a = setup({ blocked: () => reason });
    await a.service.check();
    expect(a.service.view().blocked).toBe("Es sind noch Fahrstraßen angefordert");
    expect(() => a.service.install()).toThrow(/Fahrstraßen/);
    reason = undefined;
    expect(a.service.install().phase).toBe("downloading");
    await a.settle();

    const b = setup();
    mkdirSync(path.join(dir, "install", ".git"));
    await b.service.check();
    expect(() => b.service.install()).toThrow(/Entwicklungs-Checkout/);
  });
});
