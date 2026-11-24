import type { FastifyInstance } from "fastify";

/**
 * Problem melden (Issue #24): legt aus der Oberfläche heraus ein Issue auf GitHub an.
 * Es nutzt dasselbe Repository und dasselbe Zugriffstoken wie das Update (OPENSTELLWERK_UPDATE_*); das Token braucht das Recht „Issues: Lesen und Schreiben“.
 * Das Token verlässt den Server nie. Der Text kommt fertig aus der Oberfläche, der Server ergänzt nichts.
 */

export interface FeedbackConfig {
  /** "besitzer/repository" auf GitHub */
  repo: string;
  token?: string;
  /** Basis-URL der GitHub-API, nur für Tests und GitHub Enterprise */
  apiUrl?: string;
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

  private get api() { return (this.cfg.apiUrl ?? "https://api.github.com").replace(/\/+$/, ""); }

  /** Für die Oberfläche: ob gesendet werden kann und wohin (ohne das Token). */
  status() {
    return { enabled: !!this.cfg.token, repo: this.cfg.repo, baseUrl: "https://github.com" };
  }

  private headers() {
    return { accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "OpenStellwerk-Feedback", "x-github-api-version": "2022-11-28", authorization: `Bearer ${this.cfg.token}` };
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

    let res: Response;
    try {
      res = await this.fetchFn(`${this.api}/repos/${this.cfg.repo}/issues`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ title, body, labels: [LABEL_NAME[kind]] }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      this.last.delete(who);
      throw httpError(502, "GitHub ist nicht erreichbar");
    }
    if (res.status === 401) { this.last.delete(who); throw httpError(502, "GitHub lehnt das Zugriffstoken ab (OPENSTELLWERK_UPDATE_TOKEN prüfen)"); }
    if (res.status === 403) { this.last.delete(who); throw httpError(502, "Das Zugriffstoken darf keine Issues anlegen: beim Token die Berechtigung „Issues“ auf „Lesen und Schreiben“ stellen"); }
    if (res.status === 404) { this.last.delete(who); throw httpError(502, `Repository „${this.cfg.repo}“ nicht gefunden (OPENSTELLWERK_UPDATE_REPO prüfen)`); }
    const json = await res.json().catch(() => ({})) as { number?: number; html_url?: string; message?: string };
    if (!res.ok || typeof json.number !== "number") {
      this.last.delete(who);
      throw httpError(502, `GitHub hat die Meldung abgelehnt (HTTP ${res.status}${json.message ? `: ${String(json.message).slice(0, 160)}` : ""})`);
    }
    return { number: json.number, url: typeof json.html_url === "string" ? json.html_url : `https://github.com/${this.cfg.repo}/issues/${json.number}` };
  }
}

export function registerFeedbackRoutes(app: FastifyInstance, service: FeedbackService) {
  app.get("/api/feedback", async () => service.status());
  app.post<{ Body: { kind?: unknown; title?: unknown; body?: unknown } }>("/api/feedback", async (req) =>
    service.submit({ kind: req.body?.kind, title: req.body?.title, body: req.body?.body, by: req.user?.id ?? "offen" }));
}
