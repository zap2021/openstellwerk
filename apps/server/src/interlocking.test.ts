import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Z21Simulator } from "@z21/simulator";
import type { Layout } from "@z21/protocol";
import { registerLayoutRoutes, SignalBox } from "./layout.js";
import { Station } from "./station.js";

const dir = mkdtempSync(path.join(tmpdir(), "interlocking-"));
const sim = new Z21Simulator();
const station = new Station();
const box = new SignalBox(station, path.join(dir, "layout.json"), 20);
const app = Fastify();

const fb = (input: number) => ({ bus: "rbus" as const, module: 1, input });
const layout: Layout = {
  cols: 12, rows: 5,
  tiles: [
    { id: "w1", x: 0, y: 0, kind: "turnoutRight", rot: 0, address: 11 },
    { id: "s1", x: 1, y: 0, kind: "signal", rot: 0, signalMode: "ext", address: 5, aspects: [{ name: "Hp0", value: 0 }, { name: "Hp1", value: 16 }] },
    { id: "g1", x: 2, y: 0, kind: "straight", rot: 0, feedback: fb(1) },
    { id: "g2", x: 3, y: 0, kind: "straight", rot: 0, feedback: fb(2) },
    { id: "g3", x: 4, y: 0, kind: "straight", rot: 0, feedback: fb(3) },
  ],
  blocks: [{ id: "b1", name: "Gleis 1", tileIds: ["g1"] }, { id: "b2", name: "Gleis 2", tileIds: ["g2"] }, { id: "b3", name: "Gleis 3", tileIds: ["g3"] }],
  routes: [
    { id: "r1", name: "1 nach 2", from: "b1", to: "b2", signal: "s1", steps: [{ tileId: "w1", state: 1 }, { tileId: "s1", state: 1 }] },
    { id: "r2", name: "3 nach 2", from: "b3", to: "b2", steps: [{ tileId: "w1", state: 1 }] },
  ],
};

beforeAll(async () => {
  await sim.listen(21570, "127.0.0.1");
  registerLayoutRoutes(app, box);
  await app.ready();
  await app.inject({ method: "PUT", url: "/api/layout", payload: layout });
  await station.connect("127.0.0.1", 21570);
});
afterAll(async () => { station.client.disconnect(); sim.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); });

const until = async (cond: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};
const status = (id: string) => station.snapshot().interlocking?.find((s) => s.routeId === id)?.status;
const post = (url: string, payload?: object) => app.inject({ method: "POST", url, payload });

it("sets a route: turnouts first, signal last, then locks everything", async () => {
  await until(() => station.snapshot().rmbus.some((m) => m.module === 1)); // detectors must have reported
  expect((await post("/api/interlocking/r1/request")).statusCode).toBe(200);
  await until(() => status("r1") === "set");
  expect(sim.turnouts.get(11)).toBe(2);
  await until(() => station.snapshot().extAccessories[5] === 16); // the signal command follows the status change

  // locked against hand switching, free switching and the conflicting route
  const manual = await post("/api/layout/tile/w1/set", { state: 0 });
  expect(manual.statusCode).toBe(409);
  expect(manual.json().message).toMatch(/verriegelt/);
  expect((await post("/api/layout/route/r2/run")).statusCode).toBe(409);
  const conflict = await post("/api/interlocking/r2/request");
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().message).toMatch(/Gleis 2/);
  // and the diagram cannot be replaced under a running route
  expect((await app.inject({ method: "PUT", url: "/api/layout", payload: layout })).statusCode).toBe(409);
});

it("puts the signal back to Halt when the train enters and releases after it left", async () => {
  sim.extras.setRmBus(1, 1, true); // train in block 1
  await until(() => status("r1") === "running");
  await until(() => station.snapshot().extAccessories[5] === 0);
  expect((await post("/api/interlocking/r1/release")).statusCode).toBe(409); // needs force while a train is inside

  sim.extras.setRmBus(1, 2, true); // moves on to block 2 ...
  sim.extras.setRmBus(1, 1, false);
  await new Promise((r) => setTimeout(r, 150));
  expect(status("r1")).toBe("running");
  sim.extras.setRmBus(1, 2, false); // ... and leaves
  await until(() => status("r1") === undefined);
  expect((await post("/api/layout/tile/w1/set", { state: 0 })).statusCode).toBe(200); // unlocked again
  expect(box.drainEnded()).toEqual([{ routeId: "r1", reason: "completed" }]);
  expect(box.drainEnded()).toEqual([]);
});

it("refuses a route when its block is occupied, and lets the operator force-release", async () => {
  sim.extras.setRmBus(1, 3, true);
  await until(() => station.snapshot().rmbus.find((m) => m.module === 1)?.inputs[2] === true);
  const busy = await post("/api/interlocking/r2/request");
  expect(busy.statusCode).toBe(409);
  expect(busy.json().message).toMatch(/besetzt/);
  sim.extras.setRmBus(1, 3, false);
  await until(() => station.snapshot().rmbus.find((m) => m.module === 1)?.inputs[2] === false);

  expect((await post("/api/interlocking/r2/request")).statusCode).toBe(200);
  await until(() => status("r2") === "set");
  expect((await post("/api/interlocking/r2/release")).statusCode).toBe(200); // unused route: plain cancel
  expect(status("r2")).toBeUndefined();
  expect((await post("/api/interlocking/r2/release")).statusCode).toBe(409);
  expect((await post("/api/interlocking/nope/request")).statusCode).toBe(409);
});

it("refuses switching a locked address by hand, also for the direct endpoints", async () => {
  box.assertAddressFree("turnout", 11); // nothing locked yet
  expect((await post("/api/interlocking/r1/request")).statusCode).toBe(200);
  await until(() => status("r1") === "set");
  expect(() => box.assertAddressFree("turnout", 11)).toThrow(/Adresse 11.*„1 nach 2“.*verriegelt/);
  expect(() => box.assertAddressFree("ext", 5)).toThrow(/verriegelt/); // the start signal
  expect(() => box.assertAddressFree("turnout", 99)).not.toThrow();
  expect(() => box.assertAddressFree("ext", 6)).not.toThrow();
  expect((await post("/api/interlocking/r1/release")).statusCode).toBe(200);
  expect(() => box.assertAddressFree("turnout", 11)).not.toThrow();
});

it("stops its timer when the last route is released by hand", async () => {
  expect((await post("/api/interlocking/r1/request")).statusCode).toBe(200);
  expect((box as unknown as { ticker?: unknown }).ticker).toBeDefined();
  await until(() => status("r1") === "set");
  await post("/api/interlocking/r1/release");
  expect((box as unknown as { ticker?: unknown }).ticker).toBeUndefined();
});

it("lets signal Halt overtake a long switching job", async () => {
  await until(() => !(box as unknown as { draining: boolean }).draining); // earlier tests may still be sending
  const sent: number[] = [];
  const orig = station.setTurnout.bind(station);
  station.setTurnout = (addr: number, out: 0 | 1) => { sent.push(addr); orig(addr, out); };
  const q = box as unknown as { enqueue(c: { type: "turnout"; address: number; output: 0 | 1 }[], onStep?: undefined, urgent?: boolean): Promise<void> };
  const t = (address: number) => ({ type: "turnout" as const, address, output: 1 as const });
  const slow = q.enqueue([t(101), t(102), t(103), t(104), t(105), t(106)]);
  for (let i = 0; i < 400 && !sent.includes(101); i++) await new Promise((r) => setTimeout(r, 1)); // 101 is out, 102 is next
  const urgent = q.enqueue([t(900)], undefined, true);
  await Promise.all([slow, urgent]);
  station.setTurnout = orig;
  expect(sent.filter((a) => a >= 100)).toEqual([101, 900, 102, 103, 104, 105, 106]); // one at a time, Halt right after the one in flight
});

it("tryRequestRoute reports instead of throwing", async () => {
  await until(() => !(box as unknown as { draining: boolean }).draining);
  expect(box.tryRequestRoute("r1")).toEqual({ ok: true });
  const again = box.tryRequestRoute("r1");
  expect(again.ok).toBe(false);
  expect(again.ok === false && again.reason).toMatch(/schon angefordert/);
  expect(box.tryRequestRoute("nope").ok).toBe(false);
  box.releaseRoute("r1");
  await until(() => !(box as unknown as { draining: boolean }).draining);
});

it("keeps a completed end event across a layout save before it was drained", async () => {
  await until(() => !(box as unknown as { draining: boolean }).draining);
  box.drainEnded();
  expect((await post("/api/interlocking/r1/request")).statusCode).toBe(200);
  await until(() => status("r1") === "set");
  const rm = (i: number) => station.snapshot().rmbus.find((m) => m.module === 1)?.inputs[i - 1];
  const occupy = async (i: number, on: boolean) => { sim.extras.setRmBus(1, i, on); await until(() => rm(i) === on); };
  await occupy(1, true);
  await until(() => status("r1") === "running");
  await occupy(2, true);
  await occupy(1, false);
  await occupy(2, false);
  await until(() => status("r1") === undefined);
  box.save(layout); // replaces the interlocking before anyone drained
  expect(box.drainEnded()).toEqual([{ routeId: "r1", reason: "completed" }]);
  expect(box.drainEnded()).toEqual([]);
  await until(() => !(box as unknown as { draining: boolean }).draining);
});

it("puts the route signals to Halt on the first connect only", async () => {
  const sim2 = new Z21Simulator();
  await sim2.listen(21573, "127.0.0.1");
  const file = path.join(dir, "layout2.json");
  writeFileSync(file, JSON.stringify(layout));
  const st = new Station();
  const box2 = new SignalBox(st, file, 5);
  try {
    sim2.extras.extAccessories.set(5, 16);
    await st.connect("127.0.0.1", 21573);
    await until(() => sim2.extras.extAccessories.get(5) === 0);
    sim2.extras.extAccessories.set(5, 16);
    st.client.disconnect();
    await st.connect("127.0.0.1", 21573);
    await new Promise((r) => setTimeout(r, 300));
    expect(sim2.extras.extAccessories.get(5)).toBe(16);
  } finally { st.client.disconnect(); sim2.close(); void box2; }
});
