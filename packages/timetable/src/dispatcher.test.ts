import { describe, expect, it } from "vitest";
import { Dispatcher, type DispatchInput } from "./dispatcher.js";
import { DAY } from "./clock.js";
import type { Train, Trip } from "./types.js";

const H = 3600;
const M = 60;

const train = (o: Partial<Train> = {}): Train => ({
  id: "z1",
  name: "Z1",
  address: 3,
  location: { blockId: "b1", source: "manual", since: 0 },
  ...o,
});

const trip = (o: Partial<Trip> = {}): Trip => ({ id: "t1", trainId: "z1", routeId: "r1", departure: 600, dwell: 0, ...o });

/** `t` is model seconds; the clock runs with factor 1 from model 0 at real 0. */
function input(t: number, o: Partial<DispatchInput> = {}): DispatchInput {
  return {
    now: t * 1000,
    clock: { running: true, factor: 1, baseModel: 0, baseReal: 0 },
    lateLimit: 5,
    trips: [trip()],
    trains: [train()],
    routes: new Map([["r1", { from: "b1", to: "b2" }]]),
    connected: true,
    interlocking: [],
    ended: [],
    results: [],
    ...o,
  };
}

const T10 = 10 * H;

function status(d: Dispatcher, id = "t1#0") {
  return d.find(id)?.status;
}

/** Drives t1#0 from 10:00 to `set`. */
function toSet(d: Dispatcher, base: Partial<DispatchInput> = {}) {
  d.step(input(T10, base));
  return d.step(input(T10 + 1, { ...base, results: [{ instanceId: "t1#0", ok: true }] }));
}

describe("Dispatcher", () => {
  it("(a) planned before due, waiting at due with exactly one request, no second without result", () => {
    const d = new Dispatcher();
    let r = d.step(input(T10 - 10));
    expect(r.instances).toHaveLength(1);
    expect(r.instances[0]).toMatchObject({ id: "t1#0", tripId: "t1", day: 0, due: T10, status: "planned" });
    expect(r.actions).toEqual([]);
    r = d.step(input(T10));
    expect(r.instances[0]).toMatchObject({ status: "waiting", since: T10 });
    expect(r.actions).toEqual([{ type: "request", instanceId: "t1#0", routeId: "r1" }]);
    r = d.step(input(T10 + 1));
    expect(r.actions).toEqual([]);
    expect(r.instances[0].status).toBe("waiting");
  });

  it("(b) ok result → set", () => {
    const d = new Dispatcher();
    const r = toSet(d);
    expect(r.instances[0]).toMatchObject({ status: "set", since: T10 + 1 });
    expect(r.instances[0].reason).toBeUndefined();
    expect(r.actions).toEqual([]);
  });

  it("(c) interlocking running → running; completed → done + location b2", () => {
    const d = new Dispatcher();
    toSet(d);
    let r = d.step(input(T10 + 2, { interlocking: [{ routeId: "r1", status: "running" }] }));
    expect(r.instances[0].status).toBe("running");
    r = d.step(input(T10 + 30, { ended: [{ routeId: "r1", reason: "completed" }] }));
    expect(r.instances[0]).toMatchObject({ status: "done", since: T10 + 30 });
    expect(r.actions).toEqual([{ type: "location", trainId: "z1", blockId: "b2" }]);
  });

  it("(d) rejection keeps waiting with reason, retries, fails after the late limit", () => {
    const d = new Dispatcher();
    d.step(input(T10));
    const reason = "Block „Gleis 2“ ist besetzt";
    let r = d.step(input(T10 + 1, { results: [{ instanceId: "t1#0", ok: false, reason }] }));
    expect(r.instances[0]).toMatchObject({ status: "waiting", reason });
    expect(r.actions).toEqual([{ type: "request", instanceId: "t1#0", routeId: "r1" }]);
    r = d.step(input(T10 + 2, { results: [{ instanceId: "t1#0", ok: false, reason }] }));
    expect(r.actions).toHaveLength(1);
    r = d.step(input(T10 + 5 * M, { results: [{ instanceId: "t1#0", ok: false, reason }] }));
    expect(r.instances[0].status).toBe("waiting");
    r = d.step(input(T10 + 5 * M + 1, { results: [{ instanceId: "t1#0", ok: false, reason }] }));
    expect(r.instances[0].status).toBe("failed");
    expect(r.instances[0].reason).toBe(`Verspätungsgrenze überschritten: ${reason}`);
    expect(r.actions).toEqual([]);
    r = d.step(input(T10 + 6 * M));
    expect(r.instances[0].status).toBe("failed");
    expect(r.actions).toEqual([]);
  });

  it("(e) train in the wrong block or without a location → reason, no request", () => {
    let d = new Dispatcher();
    let r = d.step(input(T10, { trains: [train({ location: { blockId: "b3", source: "manual", since: 0 } })] }));
    expect(r.instances[0].status).toBe("waiting");
    expect(r.instances[0].reason).toContain("nicht im Startblock");
    expect(r.instances[0].reason).toContain("b3");
    expect(r.instances[0].reason).toBe("Zug nicht im Startblock (bekannt: b3)");
    expect(r.actions).toEqual([]);
    d = new Dispatcher();
    r = d.step(input(T10, { trains: [train({ location: undefined })] }));
    expect(r.instances[0].reason).toContain("keinen Standort");
    expect(r.actions).toEqual([]);
  });

  it("(f) clock started only at 10:30 → cancelled „verpasst“", () => {
    const d = new Dispatcher();
    const r = d.step(input(T10 + 30 * M));
    expect(r.instances[0]).toMatchObject({ status: "cancelled", reason: "verpasst" });
    expect(r.actions).toEqual([]);
  });

  it("(g) second trip of the same train waits for the first to end plus its dwell", () => {
    const trips = [trip({ dwell: 2 }), trip({ id: "t2", departure: 601, routeId: "r2" })];
    const routes = new Map([
      ["r1", { from: "b1", to: "b2" }],
      ["r2", { from: "b2", to: "b1" }],
    ]);
    const base = { trips, routes, lateLimit: 10 };
    const at2 = { ...base, trains: [train({ location: { blockId: "b2", source: "carried", since: 0 } })] };
    const d = new Dispatcher();
    toSet(d, base);
    d.step(input(T10 + 2, { ...base, interlocking: [{ routeId: "r1", status: "running" }] }));
    let r = d.step(input(T10 + M, { ...base, interlocking: [{ routeId: "r1", status: "running" }] }));
    expect(status(d, "t2#0")).toBe("waiting");
    expect(r.actions).toEqual([]);
    r = d.step(input(T10 + 90, { ...base, ended: [{ routeId: "r1", reason: "completed" }] }));
    expect(status(d)).toBe("done");
    expect(r.actions).toEqual([{ type: "location", trainId: "z1", blockId: "b2" }]);
    // dwell of trip 1: 2 minutes after 10:01:30
    r = d.step(input(T10 + 91, at2));
    expect(status(d, "t2#0")).toBe("waiting");
    expect(r.actions).toEqual([]);
    r = d.step(input(T10 + 90 + 2 * M - 1, at2));
    expect(r.actions).toEqual([]);
    r = d.step(input(T10 + 90 + 2 * M, at2));
    expect(r.actions).toEqual([{ type: "request", instanceId: "t2#0", routeId: "r2" }]);
  });

  it("(h) cancel only in planned/waiting", () => {
    const d = new Dispatcher();
    d.step(input(T10 - 10, { trips: [trip(), trip({ id: "t2", departure: 610 })] }));
    expect(d.cancel("t2#0")).toBe(true);
    expect(d.find("t2#0")).toMatchObject({ status: "cancelled", reason: "vom Bediener" });
    expect(d.cancel("t2#0")).toBe(false);
    expect(d.cancel("nope#0")).toBe(false);

    const w = new Dispatcher();
    w.step(input(T10, { trains: [train({ location: undefined })] }));
    expect(status(w)).toBe("waiting");
    expect(w.hasActive("t1")).toBe(true);
    expect(w.cancel("t1#0")).toBe(true);
    expect(status(w)).toBe("cancelled");
    expect(w.hasActive("t1")).toBe(false);

    const r = new Dispatcher();
    toSet(r);
    r.step(input(T10 + 2, { interlocking: [{ routeId: "r1", status: "running" }] }));
    expect(status(r)).toBe("running");
    expect(r.cancel("t1#0")).toBe(false);
    expect(status(r)).toBe("running");
    expect(r.hasActive("t1")).toBe(true);
  });

  it("(i) released while set → cancelled; forced while running → failed + uncertain", () => {
    const d = new Dispatcher();
    toSet(d);
    let r = d.step(input(T10 + 2, { ended: [{ routeId: "r1", reason: "released" }] }));
    expect(r.instances[0].status).toBe("cancelled");
    expect(r.actions).toEqual([]);

    const e = new Dispatcher();
    toSet(e);
    e.step(input(T10 + 2, { interlocking: [{ routeId: "r1", status: "running" }] }));
    r = e.step(input(T10 + 3, { ended: [{ routeId: "r1", reason: "forced" }] }));
    expect(r.instances[0].status).toBe("failed");
    expect(r.actions).toEqual([{ type: "uncertain", trainId: "z1" }]);
  });

  it("(j) connected: false → no actions, status unchanged", () => {
    const d = new Dispatcher();
    d.step(input(T10 - 10));
    let r = d.step(input(T10, { connected: false }));
    expect(r.actions).toEqual([]);
    expect(r.instances[0].status).toBe("planned");
    toSet(d);
    r = d.step(input(T10 + 5, { connected: false, ended: [{ routeId: "r1", reason: "completed" }] }));
    expect(r.actions).toEqual([]);
    expect(r.instances[0].status).toBe("set");
  });

  it("(k) midnight: new day's instances planned, a running instance stays running", () => {
    const trips = [trip({ departure: 23 * 60 + 58 }), trip({ id: "t2", departure: 360 })];
    const clock = { running: true, factor: 60, baseModel: 23 * H + 58 * M, baseReal: 0 };
    const d = new Dispatcher();
    d.step(input(0, { trips, clock }));
    d.step({ ...input(0, { trips, clock }), now: 1000, results: [{ instanceId: "t1#0", ok: true }] });
    const c2 = { ...clock, baseModel: 23 * H + 59 * M + 30 };
    d.step({ ...input(0, { trips, clock: c2 }), interlocking: [{ routeId: "r1", status: "running" }] });
    expect(status(d)).toBe("running");
    const r = d.step({ ...input(0, { trips, clock: c2 }), now: 1000, interlocking: [{ routeId: "r1", status: "running" }] });
    const old = r.instances.find((i) => i.day === 0);
    expect(old).toMatchObject({ id: "t1#0", status: "running" });
    const fresh = r.instances.filter((i) => i.day === 1);
    expect(fresh.map((i) => [i.id, i.status])).toEqual([
      ["t2#0", "planned"],
      ["t1#0", "planned"],
    ]);
    expect(r.instances).toHaveLength(3);
    expect(r.instances[0]).toBe(old);
  });

  it("(l) trip with a missing route → failed „Fahrstraße nicht mehr vorhanden“, no exception", () => {
    const d = new Dispatcher();
    const o = { trips: [trip({ routeId: "gone" })] };
    expect(() => d.step(input(T10 - 1, o))).not.toThrow();
    const r = d.step(input(T10, o));
    expect(r.instances[0]).toMatchObject({ status: "failed", reason: "Fahrstraße nicht mehr vorhanden" });
    expect(r.actions).toEqual([]);
    const z = new Dispatcher();
    const s = z.step(input(T10, { trains: [] }));
    expect(s.instances[0]).toMatchObject({ status: "failed", reason: "Zug nicht mehr vorhanden" });
  });

  it("(m) repeat creates instances t1#0..t1#3", () => {
    const d = new Dispatcher();
    const r = d.step(input(T10 - 10, { trips: [trip({ repeat: { every: 15, until: 645 } })] }));
    expect(r.instances.map((i) => [i.id, i.due])).toEqual([
      ["t1#0", T10],
      ["t1#1", T10 + 15 * M],
      ["t1#2", T10 + 30 * M],
      ["t1#3", T10 + 45 * M],
    ]);
  });

  it("(n) clock set back: done stays done, a triggered instance does not request again", () => {
    const trips = [trip(), trip({ id: "t2", departure: 605, trainId: "z2", routeId: "r2" })];
    const trains = [train(), train({ id: "z2", location: { blockId: "b5", source: "manual", since: 0 } })];
    const routes = new Map([
      ["r1", { from: "b1", to: "b2" }],
      ["r2", { from: "b5", to: "b6" }],
    ]);
    const base = { trips, trains, routes };
    const d = new Dispatcher();
    const requests: string[] = [];
    const run = (t: number, o: Partial<DispatchInput> = {}) => {
      const r = d.step(input(t, { ...base, ...o }));
      for (const a of r.actions) if (a.type === "request") requests.push(a.instanceId);
      return r;
    };
    run(T10);
    run(T10 + 1, { results: [{ instanceId: "t1#0", ok: true }] });
    run(T10 + 2, { interlocking: [{ routeId: "r1", status: "running" }] });
    run(T10 + 60, { ended: [{ routeId: "r1", reason: "completed" }] });
    run(T10 + 5 * M);
    run(T10 + 5 * M + 1, { results: [{ instanceId: "t2#0", ok: true }] });
    expect(status(d)).toBe("done");
    expect(status(d, "t2#0")).toBe("set");
    // back to 09:59, then forward through 10:00 and 10:05 again
    for (const t of [T10 - 60, T10, T10 + 1, T10 + 5 * M, T10 + 5 * M + 1]) run(t, { interlocking: [{ routeId: "r2", status: "set" }] });
    expect(status(d)).toBe("done");
    expect(status(d, "t2#0")).toBe("set");
    expect(requests).toEqual(["t1#0", "t2#0"]);
  });

  it("floors fractional model time and derives the day from it", () => {
    const d = new Dispatcher();
    const r = d.step({ ...input(0), now: (DAY + T10) * 1000 - 1 });
    expect(r.instances[0]).toMatchObject({ day: 1, status: "planned" });
  });

  it("results for unknown instances are ignored; removed trips drop non-active instances", () => {
    const d = new Dispatcher();
    d.step(input(T10 - 10, { trips: [trip(), trip({ id: "t2", departure: 700 })] }));
    const r = d.step(input(T10 - 9, { results: [{ instanceId: "x#0", ok: true }] }));
    expect(r.instances).toHaveLength(1);
    expect(r.instances[0].id).toBe("t1#0");
    expect(r.actions).toEqual([]);
  });

  it("a set instance survives removal of its trip and still ends", () => {
    const d = new Dispatcher();
    toSet(d, { trips: [trip(), trip({ id: "t2", departure: 700 })] });
    let r = d.step(input(T10 + 2, { trips: [] }));
    expect(r.instances.map((i) => [i.id, i.status])).toEqual([["t1#0", "set"]]);
    r = d.step(input(T10 + 3, { trips: [], ended: [{ routeId: "r1", reason: "completed" }] }));
    expect(r.instances[0].status).toBe("done");
    expect(r.actions).toEqual([{ type: "location", trainId: "z1", blockId: "b2" }]);
  });

  it("two waiting trips of one train in the same second: only the earlier requests", () => {
    const d = new Dispatcher();
    const r = d.step(input(T10, { trips: [trip({ id: "t2" }), trip()] }));
    expect(r.actions).toEqual([{ type: "request", instanceId: "t1#0", routeId: "r1" }]);
    expect(d.find("t2#0")?.reason).toBe("Zug ist noch auf einer anderen Fahrt");
  });
});
