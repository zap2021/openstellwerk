import type { FastifyInstance } from "fastify";

/**
 * Problem melden (Issue #24): legt aus der Oberfläche heraus ein Issue auf der Git-Plattform an.
 * Es nutzt dieselbe Plattform, dasselbe Repository und dasselbe Zugriffstoken wie das Update (OPENSTELLWERK_UPDATE_*).
 * Das Token verlässt den Server nie. Der Text kommt fertig aus der Oberfläche, der Server ergänzt nichts.
 */

export interface FeedbackConfig {
  /** Basis-URL der Git-Plattform (Forgejo/Gitea) */
  baseUrl: string;
  /** "besitzer/repository" */
  repo: string;
  token?: string;
}

export interface FeedbackDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export const TITLE_MAX = 140;
export const BODY_MAX = 20_000;
/** Mindestabstand zwischen zwei Meldungen derselben Person */
export const MIN_GAP_MS = 20_000;

export type FeedbackKind = "bug" | "idea";
const LABEL_NAME: Record<FeedbackKind, string> = { bug: "bug", idea: "enhancement" };

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export class FeedbackService {
  private last = new Map<string, number>();
  private fetchFn: typeof fetch;
  private now: () => number;

  constructor(private cfg: FeedbackConfig, deps: FeedbackDeps = {}) {
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private get base() { return this.cfg.baseUrl.replace(/\/+$/, ""); }

  /** Für die Oberfläche: ob gesendet werden kann und wohin (ohne das Token). */
  status() {
    return { enabled: !!this.cfg.token, repo: this.cfg.repo, baseUrl: this.base };
  }

  private headers() {
    return { accept: "application/json", "content-type": "application/json", authorization: `token ${this.cfg.token}` };
  }

  /** Label-Nummer zum Namen, falls das Repository das Label kennt; Fehler dabei sind unkritisch. */
  private async labelId(kind: FeedbackKind): Promise<number | undefined> {
    try {
      const res = await this.fetchFn(`${this.base}/api/v1/repos/${this.cfg.repo}/labels?limit=100`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return undefined;
      const list = await res.json() as { id?: number; name?: string }[];
      return list.find((l) => l.name === LABEL_NAME[kind])?.id;
    } catch { return undefined; }
  }

  async submit(input: { kind?: unknown; title?: unknown; body?: unknown; by?: string }): Promise<{ number: number; url: string }> {
    if (!this.cfg.token) throw httpError(409, "Kein Zugriffstoken hinterlegt: OPENSTELLWERK_UPDATE_TOKEN in der Umgebungsdatei eintragen (siehe README)");
    const kind: FeedbackKind = input.kind === "idea" ? "idea" : "bug";
    const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (title.length < 5) throw httpError(400, "Der Titel ist zu kurz (mindestens 5 Zeichen)");
    if (title.length > TITLE_MAX) throw httpError(400, `Der Titel ist zu lang (höchstens ${TITLE_MAX} Zeichen)`);
    if (body.length < 1) throw httpError(400, "Die Beschreibung fehlt");
    if (body.length > BODY_MAX) throw httpError(400, `Der Text ist zu lang (höchstens ${BODY_MAX} Zeichen)`);

    const who = input.by ?? "-";
    const t = this.now();
    const prev = this.last.get(who);
    if (prev !== undefined && t - prev < MIN_GAP_MS) throw httpError(429, `Bitte kurz warten: höchstens eine Meldung alle ${MIN_GAP_MS / 1000} Sekunden`);
    this.last.set(who, t);

    const labelId = await this.labelId(kind);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/api/v1/repos/${this.cfg.repo}/issues`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ title, body, ...(labelId ? { labels: [labelId] } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      this.last.delete(who);
      throw httpError(502, "Die Git-Plattform ist nicht erreichbar");
    }
    if (res.status === 401) { this.last.delete(who); throw httpError(502, "Die Git-Plattform lehnt das Zugriffstoken ab (OPENSTELLWERK_UPDATE_TOKEN prüfen)"); }
    if (res.status === 403) { this.last.delete(who); throw httpError(502, "Das Zugriffstoken darf keine Issues anlegen: beim Token die Berechtigung „Issue“ auf „Lesen und Schreiben“ stellen"); }
    if (res.status === 404) { this.last.delete(who); throw httpError(502, `Repository „${this.cfg.repo}“ nicht gefunden (OPENSTELLWERK_UPDATE_REPO prüfen)`); }
    const json = await res.json().catch(() => ({})) as { number?: number; html_url?: string; message?: string };
    if (!res.ok || typeof json.number !== "number") {
      this.last.delete(who);
      throw httpError(502, `Die Git-Plattform hat die Meldung abgelehnt (HTTP ${res.status}${json.message ? `: ${String(json.message).slice(0, 160)}` : ""})`);
    }
    return { number: json.number, url: typeof json.html_url === "string" ? json.html_url : `${this.base}/${this.cfg.repo}/issues/${json.number}` };
  }
}

export function registerFeedbackRoutes(app: FastifyInstance, service: FeedbackService) {
  app.get("/api/feedback", async () => service.status());
  app.post<{ Body: { kind?: unknown; title?: unknown; body?: unknown } }>("/api/feedback", async (req) =>
    service.submit({ kind: req.body?.kind, title: req.body?.title, body: req.body?.body, by: req.user?.id ?? "offen" }));
}
