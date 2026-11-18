import { describe, expect, it } from "vitest";
import type { Layout } from "@openstellwerk/protocol";
import type { Train } from "@openstellwerk/timetable";
import { JourneyRunner, findPath, type Journey } from "./journeys.js";

/** a → b → c and a → d → c; routes only lead one way. */
const layout = {
  cols: 8, rows: 2, tiles: [],
  blocks: ["a", "b", "c", "d", "island"].map((id) => ({ id, name: `Block ${id.toUpperCase()}`, tileIds: [] })),
  routes: [
    { id: "ab", name: "A–B", from: "a", to: "b", steps: [] },
    { id: "bc", name: "B–C", from: "b", to: "c", steps: [] },
    { id: "ad", name: "A–D", from: "a", to: "d", steps: [] },
    { id: "dc", name: "D–C", from: "d", to: "c", steps: [] },
    { id: "free", name: "ungesichert", steps: [] },
  ],
} as unknown as Layout;

function setup(o: { refuse?: Set<string> } = {}) {
  let t = 1_000_000;
  const trains: Train[] = [{ id: "t1", name: "Zug", address: 3, location: { blockId: "a", source: "manual", since: 0 } }];
  const calls: string[] = [];
  const active = new Map<string, string>();
  let connected = true;
  let busy = false;
  const runner = new JourneyRunner({
    layout: () => layout,
    trains: () => trains,
    connected: () => connected,
    requestRoute: (id) => {
      calls.push(`request ${id}`);
      if (o.refuse?.has(id)) return { ok: false, reason: "Block besetzt" };
      active.set(id, "set");
      return { ok: true };
    },
    releaseRoute: (id) => { calls.push(`release ${id}`); active.delete(id); },
    routeStatus: (id) => active.get(id),
    setCarried: (id, block) => { trains.find((x) => x.id === id)!.location = { blockId: block, source: "carried", since: t }; },
    busy: () => busy,
    drive: (j: Journey, routeId) => { calls.push(`drive ${routeId} ${j.drive}`); },
    stopDriving: (id, text) => { calls.push(`stop ${id} ${text}`); },
    now: () => t,
  });
  return { runner, trains, calls, active, tick: (ms: number) => { t += ms; runner.tick(); }, set: (x: { connected?: boolean; busy?: boolean }) => { connected = x.connected ?? connected; busy = x.busy ?? busy; } };
}

describe("findPath", () => {
  it("finds the chain with the fewest routes and none for an island", () => {
    expect(findPath(layout, "a", "b")).toEqual(["ab"]);
    expect(findPath(layout, "a", "c")).toEqual(["ab", "bc"]);
    expect(findPath(layout, "d", "c")).toEqual(["dc"]);
    expect(findPath(layout, "a", "a")).toEqual([]);
    expect(findPath(layout, "a", "island")).toBeUndefined();
    expect(findPath(layout, "c", "a")).toBeUndefined(); // routes have a direction
  });
});

describe("JourneyRunner", () => {
  it("sets the routes leg by leg, carries the train along and drives when asked", () => {
    const { runner, trains, calls, active } = setup();
    const j = runner.start({ trainId: "t1", targetBlockId: "c", drive: "forward" });
    expect(j).toMatchObject({ routeIds: ["ab", "bc"], leg: 0, status: "set", drive: "forward" });
    expect(calls).toEqual(["request ab", "drive ab forward"]);
    active.delete("ab");
    runner.onEnded({ routeId: "ab", reason: "completed" });
    expect(trains[0]!.location).toMatchObject({ blockId: "b", source: "carried" });
    expect(j).toMatchObject({ leg: 1, status: "set" });
    expect(calls.slice(2)).toEqual(["request bc", "drive bc forward"]);
    active.delete("bc");
    runner.onEnded({ routeId: "bc", reason: "completed" });
    expect(j.status).toBe("done");
    expect(trains[0]!.location!.blockId).toBe("c");
  });

  it("without drive only the routes are set", () => {
    const { runner, calls } = setup();
    runner.start({ trainId: "t1", targetBlockId: "b" });
    expect(calls).toEqual(["request ab"]);
  });

  it("asks again while a route is refused and gives up after the wait limit", () => {
    const refuse = new Set(["ab"]);
    const { runner, calls, tick } = setup({ refuse });
    const j = runner.start({ trainId: "t1", targetBlockId: "b" });
    expect(j).toMatchObject({ status: "waiting", reason: "Block besetzt" });
    tick(1000);
    expect(calls).toHaveLength(1); // not before the retry interval
    tick(1500);
    expect(calls).toHaveLength(2);
    refuse.clear();
    tick(2500);
    expect(j.status).toBe("set");

    const other = setup({ refuse: new Set(["ab"]) });
    const k = other.runner.start({ trainId: "t1", targetBlockId: "b" });
    other.tick(5 * 60_000 + 1);
    expect(k).toMatchObject({ status: "failed", reason: "Fahrstraße nicht frei geworden: Block besetzt" });
  });

  it("fails when the route is released or faults, and stops a driven loco", () => {
    const { runner, calls, active } = setup();
    const j = runner.start({ trainId: "t1", targetBlockId: "c", drive: "reverse" });
    runner.onEnded({ routeId: "ab", reason: "forced" });
    expect(j).toMatchObject({ status: "failed", reason: "Notauflösung" });
    expect(calls).toContain("stop t1 Fahrstraße aufgelöst");

    const b = setup();
    const k = b.runner.start({ trainId: "t1", targetBlockId: "b", drive: "forward" });
    b.active.set("ab", "fault");
    b.tick(1000);
    expect(k).toMatchObject({ status: "failed", reason: "Störung der Fahrstraße" });
    expect(active.size).toBe(1);
  });

  it("cancel releases an unused route and stops the loco; finished journeys disappear after a while", () => {
    const { runner, calls, tick } = setup();
    const j = runner.start({ trainId: "t1", targetBlockId: "b", drive: "forward" });
    runner.cancel(j.id);
    expect(calls.slice(2)).toEqual(["stop t1 Zielfahrt abgebrochen", "release ab"]);
    expect(j.status).toBe("cancelled");
    expect(() => runner.cancel(j.id)).toThrow(/schon beendet/);
    expect(() => runner.cancel("nope")).toThrow(/nicht gefunden/);
    expect(runner.isActive("t1")).toBe(false);
    tick(59_000);
    expect(runner.list()).toHaveLength(1);
    tick(2000);
    expect(runner.list()).toEqual([]);
  });

  it("refuses what cannot work", () => {
    const { runner, trains, set } = setup();
    expect(() => runner.start({ trainId: "nope", targetBlockId: "b" })).toThrow(/Zug nicht gefunden/);
    expect(() => runner.start({ trainId: "t1", targetBlockId: "nope" })).toThrow(/Zielblock/);
    expect(() => runner.start({ trainId: "t1", targetBlockId: "a" })).toThrow(/schon im Zielblock/);
    expect(() => runner.start({ trainId: "t1", targetBlockId: "island" })).toThrow(/Keine Fahrstraßen von „Block A“ nach „Block ISLAND“/);
    expect(() => runner.start({ trainId: "t1", targetBlockId: "b", drive: "sideways" })).toThrow(/forward/);
    set({ busy: true });
    expect(() => runner.start({ trainId: "t1", targetBlockId: "b" })).toThrow(/Fahrplan/);
    set({ busy: false, connected: false });
    expect(() => runner.start({ trainId: "t1", targetBlockId: "b" })).toThrow(/Verbindung/);
    set({ connected: true });
    trains[0]!.location = { blockId: "a", source: "manual", since: 0, uncertain: true };
    expect(() => runner.start({ trainId: "t1", targetBlockId: "b" })).toThrow(/unsicher/);
    delete trains[0]!.location;
    expect(() => runner.start({ trainId: "t1", targetBlockId: "b" })).toThrow(/keinen Standort/);
    trains[0]!.location = { blockId: "a", source: "manual", since: 0 };
    runner.start({ trainId: "t1", targetBlockId: "b" });
    expect(() => runner.start({ trainId: "t1", targetBlockId: "d" })).toThrow(/schon auf einer Zielfahrt/);
  });
  it("does not request a section while the timetable has the train, nor from a block it no longer stands in", () => {
    const { runner, trains, calls, tick, set } = setup({ refuse: new Set(["ab"]) });
    runner.start({ trainId: "t1", targetBlockId: "c" });
    const j = runner.list()[0]!;
    expect(calls).toEqual(["request ab"]);
    set({ busy: true }); // a timetable departure took the train over
    tick(3000);
    expect(calls).toEqual(["request ab"]);
    expect(j.status).toBe("waiting");
    expect(j.reason).toMatch(/Fahrplan/);
    set({ busy: false });
    trains[0]!.location = { blockId: "d", source: "manual", since: 0 }; // moved elsewhere meanwhile
    tick(3000);
    expect(calls).toEqual(["request ab"]);
    expect(j.status).toBe("failed");
    expect(j.reason).toMatch(/nicht mehr im Startblock/);
  });
});
