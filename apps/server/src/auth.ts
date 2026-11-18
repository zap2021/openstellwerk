import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { allowed, requiredRole } from "./roles.js";
import { toPublic, verifyPassword, type PublicUser, type UserStore } from "./users.js";

declare module "fastify" { interface FastifyRequest { user?: PublicUser } }

export interface AuthOptions {
  /** shared password; empty/undefined = no login (only sensible on loopback) */
  password?: string;
  /** refuse logins that arrive over plain HTTP from another machine */
  requireHttps?: boolean;
  sessionTtlMs?: number;
  /** Benutzerverwaltung: Anmeldung mit Name und Passwort, Rollen. Ohne sie gilt das eine gemeinsame Passwort. */
  users?: UserStore;
}

/** What the auth needs of a WebSocket: closing it when its session ends. */
export interface LiveSocket { close(code?: number, reason?: string): void; on(event: "close", cb: () => void): unknown }

const COOKIE = "openstellwerk_session";
const OPEN_PATHS = new Set(["/api/login", "/api/logout", "/api/session"]);

export const isLoopback = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || /^::ffff:127\./.test(host);

/** Returns an error text if the server would be reachable from the network without any protection. */
export function exposureProblem(o: { host: string; password?: string; allowOpen?: boolean }): string | undefined {
  if (isLoopback(o.host) || o.password || o.allowOpen) return undefined;
  return `Der Server soll an ${o.host} binden, aber es ist kein Passwort gesetzt. OPENSTELLWERK_PASSWORD setzen, oder bewusst ohne Schutz mit OPENSTELLWERK_ALLOW_OPEN=1 starten.`;
}

/**
 * Pfad einer Anfrage ohne Query. Ein HTTP-Client darf auch ein absolutes Ziel senden („GET http://host/api/x“);
 * Fastify ordnet es dem Pfad zu, `req.url` enthält aber das ganze Ziel. Ohne Normalisierung würde die Prüfung
 * „beginnt mit /api/“ ins Leere laufen. Nicht lesbare Ziele liefern `undefined` und werden abgewiesen.
 */
export function requestPath(url: string): string | undefined {
  if (url.startsWith("/")) return url.split(/[?#]/)[0]!;
  try { return new URL(url).pathname; } catch { return undefined; }
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
export function registerAuth(app: FastifyInstance, opts: AuthOptions): { trackSocket(req: FastifyRequest, socket: LiveSocket): void } {
  const users = opts.users;
  /** Mit Benutzern ist die Anmeldung auch ohne gemeinsames Passwort Pflicht. */
  const enabled = () => !!opts.password || (users?.count() ?? 0) > 0;
  const ttl = opts.sessionTtlMs ?? 30 * 24 * 3600_000;
  const sessions = new Map<string, { exp: number; userId?: string }>();
  /** Open WebSockets per session: the session is only checked at the handshake, so ending it has to close them. */
  const sockets = new Map<string, Set<LiveSocket>>();
  const revoke = (t: string) => {
    sessions.delete(t);
    for (const sock of sockets.get(t) ?? []) { try { sock.close(4401, "Sitzung beendet"); } catch { /* already closed */ } }
    sockets.delete(t);
  };
  const fails = new Map<string, { count: number; until: number }>();
  const want = opts.password ? digest(opts.password) : undefined;

  /** Gültige Sitzung → der Benutzer (mit Benutzerverwaltung) bzw. `true` (gemeinsames Passwort). Das Konto wird bei jeder Anfrage neu gelesen. */
  const validToken = (t: string | undefined): PublicUser | true | false => {
    const s = t ? sessions.get(t) : undefined;
    if (!t || !s) return false;
    if (s.exp < Date.now()) { revoke(t); return false; }
    if (!users || !s.userId) return users ? false : true;
    const u = users.get(s.userId);
    if (!u || !u.active) { revoke(t); return false; }
    return toPublic(u);
  };
  const valid = (req: FastifyRequest) => validToken(cookieOf(req));

  /** Ends WebSockets whose session has meanwhile expired, been dropped or lost its account (also by a restore of the users). */
  const sweep = setInterval(() => { for (const t of [...sockets.keys()]) if (!validToken(t)) revoke(t); }, 30_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));
  const dropSessionsOf = (userId: string, except?: string) => { for (const [t, s] of sessions) if (s.userId === userId && t !== except) revoke(t); };
  const cookie = (req: FastifyRequest, value: string, maxAgeS: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${req.protocol === "https" ? "; Secure" : ""}`;

  app.addHook("onRequest", async (req, reply) => {
    if (!enabled()) return;
    const url = requestPath(req.url);
    if (url === undefined) return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "Ungültiges Anfrageziel" });
    if (!(url.startsWith("/api/") || url === "/ws") || OPEN_PATHS.has(url)) return;
    const who = valid(req);
    if (!who) return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Anmeldung erforderlich" });
    if (who !== true) {
      req.user = who;
      if (!allowed(who.role, requiredRole(req.method, url))) return reply.code(403).send({ statusCode: 403, error: "Forbidden", message: "Dafür sind Administratorrechte nötig" });
    }
  });

  app.get("/api/session", async (req) => {
    const who = valid(req);
    return { required: enabled(), ...(users && users.count() > 0 ? { users: true } : {}), authenticated: !enabled() || !!who, ...(who && who !== true ? { user: who } : {}) };
  });

  app.post<{ Body: { name?: string; password?: string } }>("/api/login", async (req, reply) => {
    if (!enabled()) return { ok: true };
    if (opts.requireHttps && req.protocol !== "https" && !isLoopback(req.ip)) {
      return reply.code(403).send({ statusCode: 403, error: "Forbidden", message: "Anmeldung nur über HTTPS erlaubt" });
    }
    const now = Date.now();
    const f = fails.get(req.ip);
    if (f && f.until > now) {
      return reply.code(429).header("retry-after", Math.ceil((f.until - now) / 1000)).send({ statusCode: 429, error: "Too Many Requests", message: "Zu viele Fehlversuche, bitte kurz warten" });
    }
    const password = String(req.body?.password ?? "");
    const user = users ? users.authenticate(String(req.body?.name ?? ""), password) : undefined;
    const good = users ? !!user : !!want && timingSafeEqual(digest(password), want);
    if (!good) {
      const count = (f?.count ?? 0) + 1;
      // free tries first, then 5 s, 10 s, 20 s … capped at 5 min
      fails.set(req.ip, { count, until: count >= 5 ? now + Math.min(300_000, 5000 * 2 ** (count - 5)) : 0 });
      if (fails.size > 2000) fails.clear();
      return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: users ? "Name oder Passwort falsch" : "Falsches Passwort" });
    }
    fails.delete(req.ip);
    for (const [t, v] of sessions) if (v.exp < now) revoke(t);
    if (sessions.size > 500) revoke(sessions.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, { exp: now + ttl, userId: user?.id });
    reply.header("set-cookie", cookie(req, token, Math.floor(ttl / 1000)));
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    const t = cookieOf(req);
    if (t) revoke(t);
    reply.header("set-cookie", cookie(req, "", 0));
    return { ok: true };
  });

  if (users) {
    const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
    const me = (req: FastifyRequest) => req.user ?? (() => { throw err(400, "Nur mit Benutzerkonto möglich"); })();
    app.get("/api/me", async (req) => me(req));
    app.put<{ Body: { displayName?: string } }>("/api/me", async (req) => users.update(me(req).id, { displayName: req.body?.displayName }));
    app.post<{ Body: { current?: string; password?: string } }>("/api/me/password", async (req) => {
      const u = users.get(me(req).id)!;
      if (!verifyPassword(String(req.body?.current ?? ""), u.hash)) throw err(403, "Das bisherige Passwort stimmt nicht");
      users.setPassword(u.id, req.body?.password);
      dropSessionsOf(u.id, cookieOf(req)); // alle anderen Geräte müssen sich neu anmelden
      return { ok: true };
    });
    app.get("/api/users", async () => users.list());
    app.post<{ Body: Record<string, unknown> }>("/api/users", async (req) => users.create(req.body ?? {}));
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/users/:id", async (req) => {
      const r = users.update(req.params.id, req.body ?? {});
      if (!r.active) dropSessionsOf(r.id);
      return r;
    });
    app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/users/:id/password", async (req) => {
      users.setPassword(req.params.id, req.body?.password);
      dropSessionsOf(req.params.id);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>("/api/users/:id", async (req) => {
      if (req.user?.id === req.params.id) throw err(409, "Das eigene Konto lässt sich nicht löschen");
      const removed = users.remove(req.params.id);
      dropSessionsOf(req.params.id);
      return { removed };
    });
  }

  return {
    /** Remember an open WebSocket so that ending its session closes it. */
    trackSocket(req, socket) {
      const t = cookieOf(req);
      if (!t || !enabled()) return;
      let set = sockets.get(t);
      if (!set) sockets.set(t, (set = new Set()));
      set.add(socket);
      socket.on("close", () => { set.delete(socket); if (!set.size && sockets.get(t) === set) sockets.delete(t); });
    },
  };
}
