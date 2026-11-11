import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Z21Simulator } from "@z21/simulator";
import type { Layout } from "@z21/protocol";
import type { Instance } from "@z21/timetable";
import { SignalBox } from "./layout.js";
import { Station } from "./station.js";
import { registerTrainRoutes, TrainStore } from "./trains.js";
import { registerTimetableRoutes, TimetableRunner } from "./timetable.js";

const dir = mkdtempSync(path.join(tmpdir(), "timetable-"));
const files = { layout: path.join(dir, "layout.json"), trains: path.join(dir, "trains.json"), timetable: path.join(dir, "timetable.json") };
const sim = new Z21Simulator();
const station = new Station();
const box = new SignalBox(station, files.layout, 20);
const trains = new TrainStore(files.trains);
const runner = new TimetableRunner(station, box, trains, files.timetable, { tickMs: 20 });
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
    { id: "g4", x: 5, y: 0, kind: "straight", rot: 0, feedback: { bus: "loconet", feedbackAddress: 7 } },
  ],
  blocks: [
    { id: "b1", name: "Gleis 1", tileIds: ["g1"] }, { id: "b2", name: "Gleis 2", tileIds: ["g2"] },
    { id: "b3", name: "Gleis 3", tileIds: ["g3"] }, { id: "b4", name: "Gleis 4", tileIds: ["g4"] },
  ],
  routes: [
    { id: "r1", name: "1 nach 2", from: "b1", to: "b2", signal: "s1", steps: [{ tileId: "w1", state: 1 }, { tileId: "s1", state: 1 }] },
    { id: "r2", name: "3 nach 2", from: "b3", to: "b2", steps: [{ tileId: "w1", state: 1 }] },
  ],
};

let t1 = "", t2 = "";

beforeAll(async () => {
  await sim.listen(21572, "127.0.0.1");
  registerTrainRoutes(app, trains, { blockIds: () => new Set((box.get().blocks ?? []).map((b) => b.id)), onRemove: (id) => runner.removeTripsOf(id) });
  registerTimetableRoutes(app, runner);
  await app.ready();
  box.save(layout);
  await station.connect("127.0.0.1", 21572);
  runner.start();
  runner.setSettings({ lateLimit: 120 }); // 2 real minutes at factor 60: nothing fails by lateness in these tests
  t1 = trains.save({ name: "RE 1", address: 3 }).id;
  t2 = trains.save({ name: "RB 2", address: 4 }).id;
  await until(() => station.snapshot().rmbus.some((m) => m.module === 1)); // detectors must have reported
});
afterAll(async () => { runner.stop(); station.client.disconnect(); sim.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); });

const until = async (cond: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tt = () => station.snapshot().timetable!;
const inst = (id: string): Instance | undefined => tt().instances.find((i) => i.id === id);
const route = (id: string) => box.routeStates().find((s) => s.routeId === id)?.status;
const rm = (input: number) => station.snapshot().rmbus.find((m) => m.module === 1)?.inputs[input - 1];
const occupy = async (input: number, on: boolean) => { sim.extras.setRmBus(1, input, on); await until(() => rm(input) === on); };
const at = (time: string, start = true) => {
  runner.clockAction({ action: "stop" });
  runner.clockAction({ action: "set", time, factor: 60 });
  if (start) runner.clockAction({ action: "start" });
};
const settle = async () => until(() => !(box as unknown as { draining: boolean }).draining);

it("(a) runs a trip: waiting, set, running, done; the train is carried to the target block", async () => {
  trains.setLocation(t1, "b1");
  at("09:00", false);
  const trip = runner.saveTrip({ trainId: t1, routeId: "r1", departure: 600, destination: "Hamburg" });
  const id = `${trip.id}#0`;
  const seen: string[] = [];
  const orig = box.tryRequestRoute.bind(box);
  box.tryRequestRoute = (routeId: string) => {
    seen.push(`${routeId}:${(runner as unknown as { dispatcher: { find(i: string): Instance | undefined } }).dispatcher.find(id)?.status}`);
    return orig(routeId);
  };
  await until(() => inst(id)?.status === "planned");
  at("10:00");
  await until(() => inst(id)?.status === "set");
  box.tryRequestRoute = orig;
  expect(seen[0]).toBe("r1:waiting"); // the request is made from waiting
  await until(() => route("r1") === "set");

  await occupy(1, true);
  await until(() => inst(id)?.status === "running");
  await occupy(2, true);
  await occupy(1, false);
  await occupy(2, false);
  await until(() => inst(id)?.status === "done");
  expect(trains.get(t1)?.location).toMatchObject({ blockId: "b2", source: "carried" });
  expect(tt().trains.find((t) => t.id === t1)?.location?.blockId).toBe("b2");
  await settle();
});

it("(b) a refused route keeps the instance waiting without bypassing the interlocking", async () => {
  trains.setLocation(t2, "b3");
  await occupy(2, true); // target block occupied
  at("11:00", false);
  const trip = runner.saveTrip({ trainId: t2, routeId: "r2", departure: 661 });
  const id = `${trip.id}#0`;
  at("11:01");
  await until(() => inst(id)?.status === "waiting" && /besetzt/.test(inst(id)?.reason ?? ""));
  for (let i = 0; i < 5; i++) {
    await sleep(30);
    expect(inst(id)?.status).toBe("waiting");
    expect(inst(id)?.reason).toMatch(/besetzt/); // retried every tick, never "no answer"
    expect(route("r2")).toBeUndefined(); // nothing locked while waiting
  }
  await occupy(2, false);
  await until(() => inst(id)?.status === "set");
  expect(route("r2")).toBeDefined();
  await until(() => route("r2") === "set");
  box.releaseRoute("r2"); // operator cancels the unused route
  await until(() => inst(id)?.status === "cancelled");
  await settle();
});

it("(d) a route deleted after the trip was created fails the instance", async () => {
  at("12:00", false);
  const trip = runner.saveTrip({ trainId: t2, routeId: "r2", departure: 721 });
  const id = `${trip.id}#0`;
  box.save({ ...layout, routes: layout.routes.filter((r) => r.id !== "r2") });
  at("12:01");
  await until(() => inst(id)?.status === "failed");
  expect(inst(id)?.reason).toBe("Fahrstraße nicht mehr vorhanden");
  expect(runner.removeTrip(trip.id)).toBe(true);
  box.save(layout);
});

it("(e) detection moves an idle train, but not one on a trip", async () => {
  trains.setLocation(t1, "b2");
  sim.setLocoNetOccupancy(7, true, 3);
  await until(() => trains.get(t1)?.location?.source === "detected");
  expect(trains.get(t1)?.location?.blockId).toBe("b4");

  sim.setLocoNetOccupancy(7, false, 3);
  await until(() => station.snapshot().loconetDetectors.find((d) => d.feedbackAddress === 7)?.occupied === false);
  trains.setLocation(t1, "b1");
  at("13:00", false);
  const trip = runner.saveTrip({ trainId: t1, routeId: "r1", departure: 781 });
  const id = `${trip.id}#0`;
  at("13:01");
  await until(() => inst(id)?.status === "set");
  sim.setLocoNetOccupancy(7, true, 3);
  await until(() => station.snapshot().loconetDetectors.find((d) => d.feedbackAddress === 7)?.occupied === true);
  await sleep(150);
  expect(trains.get(t1)?.location).toMatchObject({ blockId: "b1", source: "manual" }); // ignored during the trip

  await until(() => route("r1") === "set");
  box.releaseRoute("r1");
  await until(() => inst(id)?.status === "cancelled");
  await until(() => trains.get(t1)?.location?.blockId === "b4"); // after the trip it applies again
  sim.setLocoNetOccupancy(7, false, 3);
  await settle();
});

it("(g) HTTP: validation, conflicts and the snapshot limit", async () => {
  const req = (method: "POST" | "PUT" | "DELETE" | "GET", url: string, payload?: object) => app.inject({ method, url, payload });
  expect((await req("POST", "/api/trips", { trainId: "nope", routeId: "r1", departure: 600 })).statusCode).toBe(400);
  expect((await req("POST", "/api/trips", { trainId: t1, routeId: "nope", departure: 600 })).statusCode).toBe(400);
  expect((await req("PUT", "/api/trips/unknown", { trainId: t1, routeId: "r1", departure: 600 })).statusCode).toBe(404);
  expect((await req("PUT", "/api/timetable/settings", { lateLimit: 0 })).statusCode).toBe(400);
  expect((await req("PUT", "/api/timetable/settings", { lateLimit: 120 })).json()).toEqual({ lateLimit: 120 });
  expect((await req("POST", "/api/timetable/instances/x/cancel")).statusCode).toBe(404);
  expect((await req("POST", "/api/timetable/clock", { action: "set", time: "25:00" })).statusCode).toBe(400);
  expect((await req("POST", "/api/timetable/clock", { action: "jump" })).statusCode).toBe(400);

  // waiting: the train is not in the start block
  trains.setLocation(t2, "b1");
  at("14:00", false);
  const created = await req("POST", "/api/trips", { trainId: t2, routeId: "r2", departure: 840 });
  expect(created.statusCode).toBe(200);
  const waitId = created.json().id as string;
  await until(() => inst(`${waitId}#0`)?.status === "waiting");
  expect(inst(`${waitId}#0`)?.reason).toMatch(/nicht im Startblock/);
  expect((await req("PUT", `/api/trips/${waitId}`, { trainId: t2, routeId: "r2", departure: 841 })).statusCode).toBe(409);
  expect((await req("DELETE", `/api/trips/${waitId}`)).statusCode).toBe(409);
  expect((await req("POST", `/api/timetable/instances/${encodeURIComponent(`${waitId}#0`)}/cancel`)).statusCode).toBe(200);
  expect(inst(`${waitId}#0`)?.status).toBe("cancelled");
  expect((await req("DELETE", `/api/trips/${waitId}`)).json()).toEqual({ removed: true });

  // running: cancel is refused
  trains.setLocation(t1, "b1");
  const run = (await req("POST", "/api/trips", { trainId: t1, routeId: "r1", departure: 841 })).json() as { id: string };
  const runId = `${run.id}#0`;
  at("14:01");
  await until(() => inst(runId)?.status === "set");
  await until(() => route("r1") === "set");
  expect((await req("PUT", `/api/trips/${run.id}`, { trainId: t1, routeId: "r1", departure: 842 })).statusCode).toBe(409);
  await occupy(1, true);
  await until(() => inst(runId)?.status === "running");
  expect((await req("POST", `/api/timetable/instances/${encodeURIComponent(runId)}/cancel`)).statusCode).toBe(409);
  expect((await req("DELETE", `/api/trips/${run.id}`)).statusCode).toBe(409);
  expect(() => runner.replaceAll({ trips: [], lateLimit: 5 })).toThrow(expect.objectContaining({ statusCode: 409 }));
  await occupy(2, true);
  await occupy(1, false);
  await occupy(2, false);
  await until(() => inst(runId)?.status === "done");
  expect((await req("DELETE", `/api/trips/${run.id}`)).statusCode).toBe(200);
  await settle();

  // a repeat every minute: 190 departures, at most 40 in the snapshot, ordered by departure
  at("15:00", false);
  const many = (await req("POST", "/api/trips", { trainId: t2, routeId: "r2", departure: 900, repeat: { every: 1, until: 1089 } })).json() as { id: string };
  await until(() => tt().instances.filter((i) => i.tripId === many.id).length > 0);
  const list = tt().instances;
  expect(list.length).toBe(40);
  const keys = list.map((i) => i.day * 86400 + i.due);
  expect(keys).toEqual([...keys].sort((a, b) => a - b));
  expect(list.filter((i) => ["done", "failed", "cancelled"].includes(i.status)).length).toBeLessThanOrEqual(5);
  const got = (await req("GET", "/api/timetable")).json() as { trips: { id: string }[]; lateLimit: number; clock: { running: boolean; factor: number } };
  expect(got.trips.map((t) => t.id)).toContain(many.id);
  expect(got).toMatchObject({ lateLimit: 120, clock: { running: false, factor: 60 } });
  await req("POST", `/api/timetable/instances/${encodeURIComponent(`${many.id}#0`)}/cancel`);
  expect((await req("DELETE", `/api/trips/${many.id}`)).statusCode).toBe(200);
});

it("(c) a lost connection stops the clock; it stays stopped after reconnecting", async () => {
  at("16:00");
  expect(tt().clock.running).toBe(true);
  station.client.disconnect();
  await until(() => tt().clock.running === false);
  expect(() => runner.clockAction({ action: "start" })).toThrow(expect.objectContaining({ statusCode: 409, message: "Keine Verbindung zur Zentrale" }));
  runner.clockAction({ action: "set", time: "16:30" }); // allowed offline
  await station.connect("127.0.0.1", 21572);
  await sleep(100);
  expect(tt().clock.running).toBe(false);
});

it("(f) a restart: clock stopped, locations uncertain, no instances, trips kept", async () => {
  const trip = runner.saveTrip({ trainId: t1, routeId: "r1", departure: 1200 });
  at("17:00");
  trains.setLocation(t1, "b1");
  await sleep(400); // debounced writes
  const station2 = new Station();
  const box2 = new SignalBox(station2, files.layout, 20);
  const trains2 = new TrainStore(files.trains);
  const runner2 = new TimetableRunner(station2, box2, trains2, files.timetable, { tickMs: 20 });
  runner2.start();
  await sleep(60);
  const s = station2.snapshot().timetable!;
  runner2.stop();
  expect(s.clock.running).toBe(false);
  expect(s.clock.factor).toBe(60);
  expect(s.instances).toEqual([]);
  expect(s.lateLimit).toBe(120);
  expect(s.trains.find((t) => t.id === t1)?.location).toMatchObject({ blockId: "b1", uncertain: true });
  expect(runner2.get().trips.map((t) => t.id)).toContain(trip.id);
});

it("removeTripsOf drops every trip of a train, also via DELETE /api/trains/:id", async () => {
  runner.saveTrip({ trainId: t2, routeId: "r2", departure: 1300 });
  runner.saveTrip({ trainId: t2, routeId: "r2", departure: 1310 });
  expect((await app.inject({ method: "DELETE", url: `/api/trains/${t2}` })).json()).toEqual({ removed: true });
  expect(runner.get().trips.some((t) => t.trainId === t2)).toBe(false);
});
