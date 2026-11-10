import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import type { FastifyInstance } from "fastify";

/** mjpeg = endless multipart stream, snapshot = one JPEG per request (page polls), iframe = embed a web page directly */
export type CameraKind = "mjpeg" | "snapshot" | "iframe";

export interface Camera {
  id: string;
  name: string;
  kind: CameraKind;
  url: string;
  username?: string;
  password?: string;
  /** snapshot refresh interval in ms */
  refreshMs?: number;
  /** accept self-signed HTTPS certificates (most cameras ship one) */
  insecureTls?: boolean;
}

/** What the browser gets: never the password. */
export type PublicCamera = Omit<Camera, "password"> & { hasPassword: boolean };

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function checkUrl(raw: unknown, kind: CameraKind) {
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw bad("Ungültige URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw bad(u.protocol === "rtsp:" ? "RTSP kann der Browser nicht anzeigen – bitte einen MJPEG- oder Snapshot-Link verwenden (z. B. über go2rtc oder ffmpeg)" : "Nur http:// und https:// sind erlaubt");
  }
  if (kind !== "iframe" && (u.username || u.password)) throw bad("Zugangsdaten bitte in den Feldern Benutzer/Passwort eintragen, nicht in der URL");
  return String(raw).trim(); // keep {user}/{password} placeholders as typed
}

/** Small JSON-file store for configured cameras. Without a file it lives in memory (tests). */
export class CameraStore {
  private map = new Map<string, Camera>();
  private timer?: NodeJS.Timeout;

  constructor(private file?: string) {
    if (!file) return;
    try {
      for (const c of JSON.parse(readFileSync(file, "utf8")) as Camera[]) if (c?.id && c.url) this.map.set(c.id, c);
    } catch { /* none yet */ }
  }

  list(): Camera[] { return [...this.map.values()]; }
  get(id: string) { return this.map.get(id); }
  publicList(): PublicCamera[] { return this.list().map(toPublic); }

  /** Create (no id) or update. `password` undefined keeps the stored one, "" removes it. */
  save(input: Partial<Camera> & { id?: string }): Camera {
    const cur = input.id ? this.map.get(input.id) : undefined;
    if (input.id && !cur) throw Object.assign(new Error("Kamera nicht gefunden"), { statusCode: 404 });
    const kind = (input.kind ?? cur?.kind ?? "mjpeg") as CameraKind;
    if (!["mjpeg", "snapshot", "iframe"].includes(kind)) throw bad("Unbekannter Typ");
    const name = String(input.name ?? cur?.name ?? "").trim().slice(0, 40);
    if (!name) throw bad("Bitte einen Namen angeben");
    const url = checkUrl(input.url ?? cur?.url, kind);
    const refresh = input.refreshMs ?? cur?.refreshMs;
    const next: Camera = {
      id: cur?.id ?? randomBytes(4).toString("hex"),
      name, kind, url,
      username: (input.username ?? cur?.username)?.trim().slice(0, 80) || undefined,
      password: input.password === undefined ? cur?.password : input.password.slice(0, 120) || undefined,
      insecureTls: (input.insecureTls ?? cur?.insecureTls) ? true : undefined,
      refreshMs: kind === "snapshot" ? Math.min(60_000, Math.max(200, Math.round(Number(refresh) || 1000))) : undefined,
    };
    this.map.set(next.id, next);
    this.persist();
    return next;
  }

  remove(id: string) {
    const ok = this.map.delete(id);
    if (ok) this.persist();
    return ok;
  }

  private persist() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        mkdirSync(path.dirname(this.file!), { recursive: true });
        writeFileSync(this.file!, JSON.stringify(this.list(), null, 2), { mode: 0o600 });
      } catch (e) { console.error("cameras: could not save", (e as Error).message); }
    }, 200);
    this.timer.unref();
  }
}

export const toPublic = ({ password, ...rest }: Camera): PublicCamera => ({ ...rest, hasPassword: !!password });

/**
 * Routes for configuring cameras and for the image proxy. Only cameras the user configured can be fetched,
 * and only image data is passed on, so the proxy cannot be used to read arbitrary pages through this server.
 */
export function registerCameraRoutes(app: FastifyInstance, store: CameraStore, opts: { connectTimeoutMs?: number } = {}) {
  app.get("/api/cameras", async () => store.publicList());
  app.post<{ Body: Partial<Camera> }>("/api/cameras", async (req) => toPublic(store.save({ ...req.body, id: undefined })));
  app.put<{ Params: { id: string }; Body: Partial<Camera> }>("/api/cameras/:id", async (req) => toPublic(store.save({ ...req.body, id: req.params.id })));
  app.delete<{ Params: { id: string } }>("/api/cameras/:id", async (req) => ({ removed: store.remove(req.params.id) }));

  app.get<{ Params: { id: string } }>("/api/camera/:id/feed", async (req, reply) => {
    const cam = store.get(req.params.id);
    if (!cam) throw Object.assign(new Error("Kamera nicht gefunden"), { statusCode: 404 });
    if (cam.kind === "iframe") throw bad("Dieser Kameratyp wird direkt eingebettet");

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.connectTimeoutMs ?? 8000);
    reply.raw.on("close", () => ctl.abort()); // the response closing = the viewer left (req "close" fires early)

    // Placeholders let APIs that want credentials in the query string (e.g. Reolink) keep them out of the stored URL.
    const usesTokens = /\{(user|password)\}/.test(cam.url);
    const target = new URL(cam.url.replace(/\{user\}/g, encodeURIComponent(cam.username ?? "")).replace(/\{password\}/g, encodeURIComponent(cam.password ?? "")));
    const headers: Record<string, string> = {};
    if (cam.username && !usesTokens) headers.authorization = "Basic " + Buffer.from(`${cam.username}:${cam.password ?? ""}`).toString("base64");

    let res: http.IncomingMessage;
    try {
      res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const r = (target.protocol === "https:" ? https : http).request(target, { headers, signal: ctl.signal, rejectUnauthorized: !cam.insecureTls }, resolve);
        r.on("error", reject);
        r.end();
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const why = err.name === "AbortError" ? "Zeitüberschreitung" : /SELF.SIGNED|CERT|UNABLE_TO_VERIFY/i.test(err.code ?? "") ? "Zertifikat nicht vertrauenswürdig – „selbstsigniertes Zertifikat zulassen“ aktivieren" : err.message;
      throw Object.assign(new Error(`Kamera nicht erreichbar (${why})`), { statusCode: 502 });
    } finally {
      clearTimeout(timer);
    }
    const status = res.statusCode ?? 0;
    if (status === 401 || status === 403) { res.destroy(); throw Object.assign(new Error("Kamera lehnt die Zugangsdaten ab (Benutzer/Passwort prüfen)"), { statusCode: 502 }); }
    const type = String(res.headers["content-type"] ?? "");
    if (status < 200 || status >= 300 || !/^(image\/(jpeg|png|gif|webp|bmp)|multipart\/x-mixed-replace)/i.test(type)) {
      res.destroy();
      throw Object.assign(new Error(status >= 200 && status < 300 ? `Die URL liefert kein Bild (${type || "unbekannter Typ"}) – bei Kameras mit Login: Zugangsdaten eintragen` : `Kamera antwortet mit HTTP ${status}`), { statusCode: 502 });
    }
    reply.header("content-type", type).header("cache-control", "no-store").header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; sandbox");
    return reply.send(res);
  });
}
