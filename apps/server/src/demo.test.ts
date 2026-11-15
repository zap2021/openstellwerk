import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Z21Simulator } from "@openstellwerk/simulator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Demo, registerDemoRoutes } from "./demo.js";
import { registerLayoutRoutes, SignalBox } from "./layout.js";
import { Station } from "./station.js";
import { TimetableRunner } from "./timetable.js";
import { TrainStore } from "./trains.js";

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
  await until(() => status("r1") === undefined); // ... and has arrived in the target block
  expect(station.snapshot().interlocking).toEqual([]);
  await until(() => station.snapshot().rmbus.find((m) => m.module === 1)!.inputs.every((i) => !i)); // the virtual train then disappears
});

it("ends the train when its route is released before it left", async () => {
  const free = () => station.snapshot().rmbus.find((m) => m.module === 1)!.inputs.every((i) => !i);
  expect((await post("/api/interlocking/r1/request")).statusCode).toBe(200);
  await until(() => (demo as unknown as { running: Set<string> }).running.has("r1")); // the train is on its way ...
  expect((await post("/api/interlocking/r1/release")).statusCode).toBe(200); // ... but the route is cancelled
  await new Promise((r) => setTimeout(r, 400));
  expect(free()).toBe(true); // no ghost train occupied a detector
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

/** A fresh station with the example loaded through the demo, wired to a timetable runner. */
function rig(layoutFile = "layout.json") {
  const d = mkdtempSync(path.join(tmpdir(), "demo-tt-"));
  const st = new Station();
  const bx = new SignalBox(st, path.join(d, layoutFile), 10);
  const trains = new TrainStore(path.join(d, "trains.json"));
  const runner = new TimetableRunner(st, bx, trains, path.join(d, "timetable.json"), { tickMs: 50 });
  const dm = new Demo(st, bx, 20, runner);
  runner.start();
  const done = async () => { runner.stop(); await dm.stop(); rmSync(d, { recursive: true, force: true }); };
  return { st, bx, trains, runner, dm, done };
}

it("demo start loads the example timetable, runs the clock and the first trip arrives", async () => {
  const { st, trains, runner, dm, done } = rig();
  try {
    await dm.start();
    expect(trains.list().map((t) => [t.id, t.location?.blockId, t.location?.source])).toEqual([["re1", "zufahrt", "manual"], ["s2", "zufahrt", "manual"]]);
    expect(runner.get().trips).toHaveLength(4);
    expect(runner.get().lateLimit).toBe(5);
    expect(runner.get().clock).toMatchObject({ running: true, factor: 20 });
    runner.clockAction({ action: "set", time: "05:59", factor: 120 }); // keep the test short
    const inst = () => st.snapshot().timetable?.instances.find((i) => i.tripId === "re-out");
    await until(() => inst()?.status === "done", 20000);
    expect(trains.list().find((t) => t.id === "re1")?.location).toMatchObject({ blockId: "g1", source: "carried" });
  } finally { await done(); }
}, 30000);

it("loadExample does nothing when trains or trips already exist", async () => {
  const { trains, runner, dm, done } = rig();
  try {
    await dm.start();
    const before = JSON.stringify([trains.list(), runner.get().trips]);
    expect(runner.loadExample()).toBe(false);
    expect(JSON.stringify([trains.list(), runner.get().trips])).toBe(before);
  } finally { await done(); }
});

it("loadExample loads nothing when the layout lacks the example routes", async () => {
  const { bx, trains, runner, dm, done } = rig();
  try {
    bx.save({ cols: 4, rows: 4, tiles: [{ id: "k", x: 1, y: 1, kind: "straight", rot: 0 }], routes: [] });
    expect(runner.loadExample()).toBe(false);
    await dm.start(false);
    expect(trains.list()).toEqual([]);
    expect(runner.get().trips).toEqual([]);
  } finally { await done(); }
});
