import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface AuthOptions {
  /** shared password; empty/undefined = no login (only sensible on loopback) */
  password?: string;
  /** refuse logins that arrive over plain HTTP from another machine */
  requireHttps?: boolean;
  sessionTtlMs?: number;
}

const COOKIE = "z21_session";
const OPEN_PATHS = new Set(["/api/login", "/api/logout", "/api/session"]);

export const isLoopback = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || /^::ffff:127\./.test(host);

/** Returns an error text if the server would be reachable from the network without any protection. */
export function exposureProblem(o: { host: string; password?: string; allowOpen?: boolean }): string | undefined {
  if (isLoopback(o.host) || o.password || o.allowOpen) return undefined;
  return `Der Server soll an ${o.host} binden, aber es ist kein Passwort gesetzt. Z21_PASSWORD setzen, oder bewusst ohne Schutz mit Z21_ALLOW_OPEN=1 starten.`;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

function cookieOf(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * One shared password, session cookie. A cookie (not a header) so that the WebSocket and <img> camera requests
 * are covered without any client changes; SameSite=Strict keeps other sites from riding on the session.
 */
export function registerAuth(app: FastifyInstance, opts: AuthOptions) {
  const enabled = !!opts.password;
  const ttl = opts.sessionTtlMs ?? 30 * 24 * 3600_000;
  const sessions = new Map<string, number>();
  const fails = new Map<string, { count: number; until: number }>();
  const want = enabled ? digest(opts.password!) : undefined;

  const valid = (req: FastifyRequest) => {
    const t = cookieOf(req);
    const exp = t ? sessions.get(t) : undefined;
    if (!t || !exp) return false;
    if (exp < Date.now()) { sessions.delete(t); return false; }
    return true;
  };
  const cookie = (req: FastifyRequest, value: string, maxAgeS: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${req.protocol === "https" ? "; Secure" : ""}`;

  app.addHook("onRequest", async (req, reply) => {
    if (!enabled) return;
    const url = req.url.split("?")[0]!;
    if (!(url.startsWith("/api/") || url === "/ws") || OPEN_PATHS.has(url)) return;
    if (!valid(req)) return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Anmeldung erforderlich" });
  });

  app.get("/api/session", async (req) => ({ required: enabled, authenticated: !enabled || valid(req) }));

  app.post<{ Body: { password?: string } }>("/api/login", async (req, reply) => {
    if (!enabled) return { ok: true };
    if (opts.requireHttps && req.protocol !== "https" && !isLoopback(req.ip)) {
      return reply.code(403).send({ statusCode: 403, error: "Forbidden", message: "Anmeldung nur über HTTPS erlaubt" });
    }
    const now = Date.now();
    const f = fails.get(req.ip);
    if (f && f.until > now) {
      return reply.code(429).header("retry-after", Math.ceil((f.until - now) / 1000)).send({ statusCode: 429, error: "Too Many Requests", message: "Zu viele Fehlversuche, bitte kurz warten" });
    }
    if (!timingSafeEqual(digest(String(req.body?.password ?? "")), want!)) {
      const count = (f?.count ?? 0) + 1;
      // free tries first, then 5 s, 10 s, 20 s … capped at 5 min
      fails.set(req.ip, { count, until: count >= 5 ? now + Math.min(300_000, 5000 * 2 ** (count - 5)) : 0 });
      if (fails.size > 2000) fails.clear();
      return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Falsches Passwort" });
    }
    fails.delete(req.ip);
    for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
    if (sessions.size > 500) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, now + ttl);
    reply.header("set-cookie", cookie(req, token, Math.floor(ttl / 1000)));
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    const t = cookieOf(req);
    if (t) sessions.delete(t);
    reply.header("set-cookie", cookie(req, "", 0));
    return { ok: true };
  });
}
