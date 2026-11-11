import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Z21Simulator } from "@z21/simulator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Demo, registerDemoRoutes } from "./demo.js";
import { registerLayoutRoutes, SignalBox } from "./layout.js";
import { Station } from "./station.js";

const dir = mkdtempSync(path.join(tmpdir(), "demo-"));
const station = new Station();
const box = new SignalBox(station, path.join(dir, "layout.json"), 10);
const demo = new Demo(station, box, 20); // 20x faster than real time
const app = Fastify();

beforeAll(async () => { registerLayoutRoutes(app, box); registerDemoRoutes(app, demo); await app.ready(); });
afterAll(async () => { await demo.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); });

const until = async (cond: () => boolean, ms = 8000) => {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};
const post = (url: string, payload?: object) => app.inject({ method: "POST", url, payload });
const status = (id: string) => station.snapshot().interlocking?.find((s) => s.routeId === id)?.status;

it("starts without hardware, loads the example diagram and reports itself as demo", async () => {
  expect((await app.inject({ method: "GET", url: "/api/demo" })).json()).toEqual({ active: false });
  expect(station.snapshot().demo).toBeUndefined();
  expect((await post("/api/demo", { on: true })).json()).toEqual({ active: true });
  expect(station.snapshot()).toMatchObject({ connected: true, demo: true });
  expect(box.get().blocks).toHaveLength(3);
  await until(() => station.snapshot().rmbus.some((m) => m.module === 1)); // detectors report
});

it("drives a virtual train through a route: set, entered, released", async () => {
  expect((await post("/api/interlocking/r1/request")).statusCode).toBe(200);
  await until(() => status("r1") === "set");
  await until(() => status("r1") === "running"); // the train enters the start block ...
  await until(() => status("r1") === undefined); // ... and has left the target block again
  expect(station.snapshot().interlocking).toEqual([]);
});

it("stops cleanly, and refuses to start while a real station is connected", async () => {
  expect((await post("/api/demo", { on: false })).json()).toEqual({ active: false });
  expect(station.snapshot()).toMatchObject({ connected: false });
  expect(station.snapshot().demo).toBeUndefined();
  expect((await post("/api/demo", { on: false })).statusCode).toBe(200); // idempotent

  const real = new Z21Simulator(); // stands in for real hardware
  await real.listen(21571, "127.0.0.1");
  await station.connect("127.0.0.1", 21571);
  const refused = await post("/api/demo", { on: true });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().message).toMatch(/trennen/);
  expect(station.snapshot().connected).toBe(true); // the real connection is untouched
  station.client.disconnect();
  real.close();
});
