import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CameraStore, registerCameraRoutes } from "./cameras.js";

const dir = mkdtempSync(path.join(tmpdir(), "cams-"));
const file = path.join(dir, "cameras.json");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
let seenAuth: string | undefined;

const upstream = http.createServer((req, res) => {
  seenAuth = req.headers.authorization;
  if (req.url === "/snap.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(JPEG); }
  else if (req.url === "/svg") { res.writeHead(200, { "content-type": "image/svg+xml" }); res.end("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"); }
  else if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); res.end("<script>alert(1)</script>"); }
  else if (req.url === "/locked") { res.writeHead(401); res.end(); }
  else { res.writeHead(404); res.end(); }
});
let base = "";
const store = new CameraStore(file);
const app = Fastify();
beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  registerCameraRoutes(app, store, { connectTimeoutMs: 500 });
  await app.ready();
});
afterAll(async () => { await app.close(); upstream.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

it("creates a camera and never returns the password", async () => {
  const res = await post("/api/cameras", { name: " Bahnhof ", kind: "snapshot", url: `${base}/snap.jpg`, username: "admin", password: "geheim", refreshMs: 50 });
  expect(res.statusCode).toBe(200);
  const cam = res.json();
  expect(cam).toMatchObject({ name: "Bahnhof", kind: "snapshot", hasPassword: true, refreshMs: 200 });
  expect(cam.password).toBeUndefined();
  expect(JSON.stringify((await app.inject("/api/cameras")).json())).not.toContain("geheim");
});

it("keeps the stored password on update unless a new one is sent, and writes the file", async () => {
  const id = store.list()[0]!.id;
  await app.inject({ method: "PUT", url: `/api/cameras/${id}`, payload: { name: "Bahnhof Nord" } });
  expect(store.get(id)).toMatchObject({ name: "Bahnhof Nord", password: "geheim" });
  await app.inject({ method: "PUT", url: `/api/cameras/${id}`, payload: { password: "" } });
  expect(store.get(id)?.password).toBeUndefined();
  await new Promise((r) => setTimeout(r, 350));
  expect(JSON.parse(readFileSync(file, "utf8"))[0].name).toBe("Bahnhof Nord");
});

it("rejects unusable input", async () => {
  expect((await post("/api/cameras", { name: "x", url: "ftp://a/b" })).statusCode).toBe(400);
  expect((await post("/api/cameras", { name: "x", url: "rtsp://cam/stream" })).json().message).toMatch(/RTSP/);
  expect((await post("/api/cameras", { name: "x", url: "http://u:p@cam/x.jpg" })).statusCode).toBe(400);
  expect((await post("/api/cameras", { name: "", url: base })).statusCode).toBe(400);
  expect((await app.inject({ method: "PUT", url: "/api/cameras/nope", payload: { name: "a" } })).statusCode).toBe(404);
});

it("proxies images with Basic auth", async () => {
  const cam = (await post("/api/cameras", { name: "Proxy", kind: "snapshot", url: `${base}/snap.jpg`, username: "u", password: "p" })).json();
  const res = await app.inject(`/api/camera/${cam.id}/feed`);
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("image/jpeg");
  expect(res.rawPayload.equals(JPEG)).toBe(true);
  expect(res.headers["content-security-policy"]).toContain("sandbox");
  expect(seenAuth).toBe("Basic " + Buffer.from("u:p").toString("base64"));
});

it("does not pass on anything but images, and explains failures", async () => {
  const html = (await post("/api/cameras", { name: "Seite", url: `${base}/page` })).json();
  const r1 = await app.inject(`/api/camera/${html.id}/feed`);
  expect(r1.statusCode).toBe(502);
  expect(r1.json().message).toMatch(/kein Bild/);
  const svg = (await post("/api/cameras", { name: "Svg", url: `${base}/svg` })).json();
  expect((await app.inject(`/api/camera/${svg.id}/feed`)).statusCode).toBe(502);
  const locked = (await post("/api/cameras", { name: "Zu", url: `${base}/locked` })).json();
  expect((await app.inject(`/api/camera/${locked.id}/feed`)).json().message).toMatch(/Zugangsdaten/);
  const dead = (await post("/api/cameras", { name: "Tot", url: "http://127.0.0.1:1/x" })).json();
  expect((await app.inject(`/api/camera/${dead.id}/feed`)).statusCode).toBe(502);
  expect((await app.inject("/api/camera/unknown/feed")).statusCode).toBe(404);
});

it("deletes cameras", async () => {
  const id = store.list()[0]!.id;
  expect((await app.inject({ method: "DELETE", url: `/api/cameras/${id}` })).json()).toEqual({ removed: true });
  expect(store.get(id)).toBeUndefined();
});

it("fills {user}/{password} placeholders into the request and skips Basic auth then", async () => {
  let seenUrl = "";
  const srv = http.createServer((req, res) => { seenUrl = req.url ?? ""; seenAuth = req.headers.authorization; res.writeHead(200, { "content-type": "image/jpeg" }); res.end(JPEG); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/snap?user={user}&password={password}`;
  const cam = (await post("/api/cameras", { name: "Token", kind: "snapshot", url, username: "a b", password: "p&w" })).json();
  expect(cam.url).toBe(url);
  seenAuth = undefined;
  expect((await app.inject(`/api/camera/${cam.id}/feed`)).statusCode).toBe(200);
  expect(seenUrl).toBe("/snap?user=a%20b&password=p%26w");
  expect(seenAuth).toBeUndefined();
  srv.close();
});
