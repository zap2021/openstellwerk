import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Z21Simulator } from "@openstellwerk/simulator";
import { routeIsSet, tileState, type Layout } from "@openstellwerk/protocol";
import { registerLayoutRoutes, SignalBox } from "./layout.js";
import { Station } from "./station.js";

const dir = mkdtempSync(path.join(tmpdir(), "layout-"));
const file = path.join(dir, "layout.json");
const sim = new Z21Simulator();
const station = new Station();
const box = new SignalBox(station, file, 40);
const app = Fastify();
const wire: string[] = [];

const layout: Layout = {
  cols: 10, rows: 5,
  tiles: [
    { id: "w1", x: 0, y: 0, kind: "turnoutRight", rot: 0, address: 11 },
    { id: "w2", x: 1, y: 0, kind: "turnoutLeft", rot: 0, address: 12, invert: true },
    { id: "s1", x: 2, y: 0, kind: "signal", rot: 0, signalMode: "ext", address: 5, aspects: [{ name: "Hp0", value: 0 }, { name: "Hp1", value: 16 }] },
    { id: "g1", x: 3, y: 0, kind: "straight", rot: 0, feedback: { bus: "rbus", module: 1, input: 1 } },
    { id: "leer", x: 4, y: 0, kind: "turnoutLeft", rot: 0 },
  ],
  routes: [{ id: "r1", name: "Einfahrt", steps: [{ tileId: "w1", state: 1 }, { tileId: "w2", state: 1 }, { tileId: "s1", state: 1 }] }],
};

beforeAll(async () => {
  await sim.listen(21557, "127.0.0.1");
  registerLayoutRoutes(app, box);
  await app.ready();
  station.client.on("wire", (w) => { if (w.dir === "tx") wire.push(w.hex); });
});
afterAll(async () => { station.client.disconnect(); sim.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); });

const until = async (cond: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};
const live = () => station.snapshot();
const tile = (id: string) => box.get().tiles.find((t) => t.id === id)!;

it("stores a validated diagram, rejects a broken one, and shares it in the snapshot", async () => {
  expect((await app.inject({ method: "PUT", url: "/api/layout", payload: { cols: 1, rows: 1, tiles: [] } })).statusCode).toBe(400);
  const res = await app.inject({ method: "PUT", url: "/api/layout", payload: layout });
  expect(res.statusCode).toBe(200);
  expect(res.json().tiles).toHaveLength(5);
  expect(live().layout?.routes[0]?.name).toBe("Einfahrt");
  await new Promise((r) => setTimeout(r, 350));
  expect(JSON.parse(readFileSync(file, "utf8")).tiles).toHaveLength(5);
  expect(new SignalBox(new Station(), file).get().tiles).toHaveLength(5);
});

it("refuses to switch while disconnected", async () => {
  expect((await app.inject({ method: "POST", url: "/api/layout/tile/w1/set", payload: { state: 1 } })).statusCode).toBe(409);
});

it("reads the positions of all linked turnouts after connecting", async () => {
  sim.turnouts.set(11, 2); // already diverging before we connect
  await station.connect("127.0.0.1", 21557);
  await until(() => tileState(tile("w1"), live()) === 1);
  await until(() => live().turnouts[12] !== undefined);
});

it("switches a turnout from the diagram and shows the reported position", async () => {
  expect((await app.inject({ method: "POST", url: "/api/layout/tile/w1/set", payload: { state: 0 } })).statusCode).toBe(200);
  await until(() => tileState(tile("w1"), live()) === 0);
  expect(sim.turnouts.get(11)).toBe(1);
  // inverted turnout: "diverging" in the diagram is output 0 on the wire
  await app.inject({ method: "POST", url: "/api/layout/tile/w2/set", payload: { state: 1 } });
  await until(() => tileState(tile("w2"), live()) === 1);
  expect(sim.turnouts.get(12)).toBe(1);
});

it("answers clearly for bad requests", async () => {
  expect((await app.inject({ method: "POST", url: "/api/layout/tile/nope/set", payload: { state: 0 } })).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: "/api/layout/tile/w1/set", payload: { state: 7 } })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/api/layout/tile/leer/set", payload: { state: 1 } })).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url: "/api/layout/route/nope/run" })).statusCode).toBe(404);
});

it("sets a route step by step, one command at a time", async () => {
  await app.inject({ method: "POST", url: "/api/layout/tile/w2/set", payload: { state: 0 } });
  await until(() => tileState(tile("w2"), live()) === 0);
  wire.length = 0;
  const t0 = Date.now();
  const res = await app.inject({ method: "POST", url: "/api/layout/route/r1/run" });
  expect(res.json()).toEqual({ ok: true, total: 3 });
  expect(live().routeRun).toMatchObject({ routeId: "r1", running: true, total: 3 });
  expect((await app.inject({ method: "POST", url: "/api/layout/route/r1/run" })).statusCode).toBe(409);
  await until(() => live().routeRun?.running === false);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 40 - 5);
  expect(live().routeRun?.done).toBe(3);
  expect(live().routeRun?.error).toBeUndefined();
  await until(() => routeIsSet(box.get(), box.get().routes[0]!, live()));
  expect(live().extAccessories[5]).toBe(16);
});

it("keeps the detectors of the diagram subscribed and reads them", async () => {
  await until(() => live().rmbus.some((m) => m.module === 1));
  station.setMonitors({ rmbus: false }); // closing the R-BUS tab must not blind the diagram
  expect(station.client.flags & 0x02).toBe(0x02);
});
