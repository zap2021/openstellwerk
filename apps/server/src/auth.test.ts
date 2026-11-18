import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error ws ships no types and @types/ws is not a dependency; only the test uses it
import { WebSocket } from "ws";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import websocket from "@fastify/websocket";
import { afterAll, describe, expect, it } from "vitest";
import { exposureProblem, registerAuth, type AuthOptions } from "./auth.js";
import { readTls, tlsFilesFromEnv } from "./tls.js";

async function build(opts: AuthOptions, server: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify(server);
  await app.register(websocket);
  registerAuth(app, opts);
  app.get("/api/state", async () => ({ ok: true }));
  app.get("/api/camera/x/feed", async () => "img");
  app.get("/ws", { websocket: true }, (socket) => socket.close());
  app.get("/", async () => "page");
  await app.ready();
  return app;
}
const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

describe("exposure check", () => {
  it("only complains about an unprotected, network-reachable server", () => {
    expect(exposureProblem({ host: "127.0.0.1" })).toBeUndefined();
    expect(exposureProblem({ host: "0.0.0.0", password: "x" })).toBeUndefined();
    expect(exposureProblem({ host: "0.0.0.0", allowOpen: true })).toBeUndefined();
    expect(exposureProblem({ host: "0.0.0.0" })).toMatch(/OPENSTELLWERK_PASSWORD/);
    expect(exposureProblem({ host: "192.168.1.5" })).toBeTruthy();
  });
});

describe("without a password", () => {
  it("leaves everything open", async () => {
    const app = await build({});
    expect((await app.inject("/api/state")).statusCode).toBe(200);
    expect((await app.inject("/api/session")).json()).toEqual({ required: false, authenticated: true });
    await app.close();
  });
});

describe("with a password", () => {
  let app: FastifyInstance;
  afterAll(() => app.close());

  it("blocks API, camera feed and WebSocket, but not the page", async () => {
    app = await build({ password: "geheim" });
    for (const url of ["/api/state", "/api/camera/x/feed", "/api/state?x=1", "/ws"]) expect((await app.inject(url)).statusCode, url).toBe(401);
    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject("/api/session")).json()).toEqual({ required: true, authenticated: false });
  });

  it("rejects a wrong password and accepts the right one", async () => {
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { password: "falsch" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: {} })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "geheim" } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict/);
    expect(String(res.headers["set-cookie"])).not.toMatch(/Secure/);
    const cookie = cookieFrom(res);
    expect((await app.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/session", headers: { cookie } })).json().authenticated).toBe(true);
    expect((await app.inject({ url: "/api/state", headers: { cookie: "openstellwerk_session=erfunden" } })).statusCode).toBe(401);
    await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    expect((await app.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
  });

  it("does not let an absolute request target around the check", async () => {
    const a = await build({ password: "geheim" });
    await a.listen({ port: 0, host: "127.0.0.1" });
    const port = (a.server.address() as AddressInfo).port;
    const raw = (target: string) => new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let d = "";
      s.on("data", (c) => (d += c));
      s.on("close", () => resolve(d.split("\r\n")[0]!));
    });
    expect(await raw("/api/state")).toMatch(/ 401 /);
    for (const t of ["http://x/api/state", "http://x/api/state?x=1", "HTTP://x/api/state"]) expect(await raw(t), t).not.toMatch(/ 200 /);
    await a.close();
  });

  it("closes an open WebSocket when its session ends (logout), not only at the handshake", async () => {
    const a = Fastify();
    await a.register(websocket);
    const auth = registerAuth(a, { password: "geheim" });
    a.get("/ws", { websocket: true }, (socket, req) => { auth.trackSocket(req, socket); });
    await a.listen({ port: 0, host: "127.0.0.1" });
    const port = (a.server.address() as AddressInfo).port;
    const cookie = cookieFrom(await a.inject({ method: "POST", url: "/api/login", payload: { password: "geheim" } }));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => { ws.on("open", () => resolve()); ws.on("error", reject); });
    const closed = new Promise<number>((resolve) => ws.on("close", (code: number) => resolve(code)));
    await a.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    expect(await closed).toBe(4401);
    await a.close();
  });

  it("slows down guessing", async () => {
    const a = await build({ password: "geheim" });
    const tryIt = (password: string) => a.inject({ method: "POST", url: "/api/login", payload: { password }, remoteAddress: "10.0.0.9" });
    for (let i = 0; i < 5; i++) expect((await tryIt("x")).statusCode).toBe(401);
    const blocked = await tryIt("geheim");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await a.inject({ method: "POST", url: "/api/login", payload: { password: "geheim" }, remoteAddress: "10.0.0.10" })).statusCode).toBe(200);
    await a.close();
  });

  it("expires sessions", async () => {
    const a = await build({ password: "geheim", sessionTtlMs: 30 });
    const cookie = cookieFrom(await a.inject({ method: "POST", url: "/api/login", payload: { password: "geheim" } }));
    await new Promise((r) => setTimeout(r, 60));
    expect((await a.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
    await a.close();
  });

  it("can insist on HTTPS, also behind a proxy", async () => {
    const a = await build({ password: "geheim", requireHttps: true }, { trustProxy: true });
    const login = (headers: Record<string, string>, remoteAddress: string) => a.inject({ method: "POST", url: "/api/login", payload: { password: "geheim" }, headers, remoteAddress });
    expect((await login({}, "192.168.1.20")).statusCode).toBe(403);
    expect((await login({}, "127.0.0.1")).statusCode).toBe(200);
    const viaProxy = await login({ "x-forwarded-proto": "https", "x-forwarded-for": "192.168.1.20" }, "127.0.0.1");
    expect(viaProxy.statusCode).toBe(200);
    expect(String(viaProxy.headers["set-cookie"])).toMatch(/; Secure/);
    await a.close();
  });
});

describe("TLS", () => {
  it("needs both files", () => {
    expect(tlsFilesFromEnv({})).toBeUndefined();
    expect(() => tlsFilesFromEnv({ TLS_CERT: "a" })).toThrow();
    expect(tlsFilesFromEnv({ TLS_CERT: "a", TLS_KEY: "b" })).toEqual({ cert: "a", key: "b" });
  });

  let openssl = true;
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); } catch { openssl = false; }

  it.skipIf(!openssl)("serves HTTPS with the given certificate and marks the cookie Secure", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tls-"));
    const files = { cert: path.join(dir, "c.pem"), key: path.join(dir, "k.pem") };
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", files.key, "-out", files.cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const a = await build({ password: "geheim" }, { https: readTls(files) } as FastifyServerOptions);
    await a.listen({ port: 0, host: "127.0.0.1" });
    const port = (a.server.address() as AddressInfo).port;
    const res = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const body = JSON.stringify({ password: "geheim" });
      const r = https.request({ host: "127.0.0.1", port, path: "/api/login", method: "POST", rejectUnauthorized: false, headers: { "content-type": "application/json", "content-length": body.length } },
        (m) => { m.resume(); resolve({ status: m.statusCode!, cookie: String(m.headers["set-cookie"]) }); });
      r.on("error", reject);
      r.end(body);
    });
    expect(res.status).toBe(200);
    expect(res.cookie).toMatch(/; Secure/);
    await a.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
