import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { Layout } from "@z21/protocol";
import {
  LayoutRuleEngine, LayoutRuleStore, conditionsHold, locosInBlock, missingRefs, registerLayoutRuleRoutes, validateRules,
  type LayoutRule, type RuleActions,
} from "./layout-rules.js";

/** Two blocks on R-BUS module 1 (inputs 1 and 2), a turnout on address 5, a signal on address 7 and one route. */
const layout = {
  cols: 24, rows: 12,
  tiles: [
    { id: "t1", x: 0, y: 0, kind: "straight", rot: 0, feedback: { bus: "rbus", module: 1, input: 1 } },
    { id: "t2", x: 1, y: 0, kind: "straight", rot: 0, feedback: { bus: "rbus", module: 1, input: 2 } },
    { id: "w1", x: 2, y: 0, kind: "turnoutLeft", rot: 0, address: 5, label: "W1" },
    { id: "s1", x: 3, y: 0, kind: "signal", rot: 0, address: 7 },
    { id: "t3", x: 4, y: 0, kind: "straight", rot: 0, feedback: { bus: "loconet", feedbackAddress: 9 } },
  ],
  routes: [{ id: "r1", name: "Einfahrt", steps: [{ tileId: "w1", state: 1 }] }],
  blocks: [{ id: "b1", name: "Gleis 1", tileIds: ["t1"] }, { id: "b2", name: "Gleis 2", tileIds: ["t2"] }, { id: "b3", name: "Gleis 3", tileIds: ["t3"] }],
} as unknown as Layout;

const live = (b1?: boolean, b2?: boolean, o: { connected?: boolean; turnouts?: Record<number, string> } = {}) => ({
  connected: o.connected ?? true,
  turnouts: o.turnouts ?? {},
  extAccessories: {},
  rmbus: b1 === undefined && b2 === undefined ? [] : [{ module: 1, inputs: [b1, b2] as boolean[] }],
  loconetDetectors: [],
  canDetectors: [],
});

const rule = (o: Partial<LayoutRule> = {}): LayoutRule => ({
  id: "x", name: "Halt", enabled: true, trigger: { type: "block", blockId: "b1", occupied: true }, conditions: [], actions: [{ type: "tile", tileId: "s1", state: 0 }], ...o,
});

function setup(rules: LayoutRule[], over: Partial<RuleActions> = {}) {
  const calls: string[] = [];
  const act: RuleActions = {
    setTile: async (id, state) => { calls.push(`tile ${id} ${state}`); },
    requestRoute: (id) => { calls.push(`request ${id}`); return { ok: true }; },
    releaseRoute: (id) => { calls.push(`release ${id}`); },
    activeRoutes: () => [],
    locosIn: () => [3],
    stopLoco: (a) => { calls.push(`stop ${a}`); },
    ...over,
  };
  const store = new LayoutRuleStore();
  store.replaceAll(rules);
  let t = 1_000_000;
  const engine = new LayoutRuleEngine(store, () => layout, act, () => t);
  return { calls, store, engine, tick: (ms: number) => { t += ms; vi.advanceTimersByTime(ms); } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("validateRules", () => {
  it("normalises a rule and drops empty delays", () => {
    const [r] = validateRules([{ id: " a ", name: "", trigger: { type: "block", blockId: "b1", occupied: true, holdMs: 0 }, actions: [{ type: "stopLoco", delayMs: 500 }] }]);
    expect(r).toEqual({ id: "a", name: "Regel 1", enabled: true, trigger: { type: "block", blockId: "b1", occupied: true }, conditions: [], actions: [{ type: "stopLoco", delayMs: 500 }] });
  });
  it("refuses bad input", () => {
    expect(() => validateRules({})).toThrow(/Liste/);
    expect(() => validateRules([rule(), rule()])).toThrow(/doppelt/);
    expect(() => validateRules([rule({ actions: [] })])).toThrow(/mindestens eine Aktion/);
    expect(() => validateRules([{ ...rule(), trigger: { type: "clock" } }])).toThrow(/unbekannter Auslöser/);
    expect(() => validateRules([{ ...rule(), actions: [{ type: "power" }] }])).toThrow(/unbekannte Aktion/);
    expect(() => validateRules([{ ...rule(), actions: [{ type: "route", routeId: "r1", do: "force" }] }])).toThrow(/request/);
    expect(() => validateRules([{ ...rule(), actions: [{ type: "tile", tileId: "s1", state: 0, delayMs: 70_000 }] }])).toThrow(/Verzögerung/);
    expect(() => validateRules([{ ...rule(), conditions: [{ type: "weather" }] }])).toThrow(/unbekannte Bedingung/);
    expect(() => validateRules(Array.from({ length: 101 }, (_, i) => rule({ id: `r${i}` })))).toThrow(/Höchstens/);
  });
});

describe("missingRefs and conditions", () => {
  it("names what the diagram does not have", () => {
    expect(missingRefs(rule(), layout)).toEqual([]);
    expect(missingRefs(rule({ trigger: { type: "block", blockId: "gone", occupied: true } }), layout)).toEqual(["Block fehlt im Gleisbild"]);
    expect(missingRefs(rule({ actions: [{ type: "tile", tileId: "w1", state: 3 }, { type: "route", routeId: "nope", do: "request" }] }), layout))
      .toEqual(["Lage gibt es bei diesem Feld nicht", "Fahrstraße fehlt im Gleisbild"]);
  });
  it("needs every condition; unknown states satisfy none", () => {
    const r = rule({ conditions: [{ type: "block", blockId: "b2", occupied: false }, { type: "tile", tileId: "w1", state: 1 }, { type: "route", routeId: "r1", active: false }] });
    expect(conditionsHold(r, layout, live(true, false, { turnouts: { 5: "p1" } }), new Set())).toBe(true);
    expect(conditionsHold(r, layout, live(true, true, { turnouts: { 5: "p1" } }), new Set())).toBe(false);
    expect(conditionsHold(r, layout, live(true, false), new Set())).toBe(false); // turnout position unknown
    expect(conditionsHold(r, layout, live(true, false, { turnouts: { 5: "p1" } }), new Set(["r1"]))).toBe(false);
  });
});

describe("LayoutRuleEngine", () => {
  it("does not fire on the first reading, fires on the change, and only for the matching direction", async () => {
    const { calls, engine } = setup([rule(), rule({ id: "y", trigger: { type: "block", blockId: "b1", occupied: false }, actions: [{ type: "tile", tileId: "s1", state: 1 }] })]);
    engine.onState(live(true, false));
    expect(calls).toEqual([]);
    engine.onState(live(false, false));
    expect(calls).toEqual(["tile s1 1"]);
    engine.onState(live(true, false));
    expect(calls).toEqual(["tile s1 1", "tile s1 0"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.view()[0]!.last!.results).toEqual([{ text: "Signal → Halt", ok: true }]);
  });

  it("skips unknown readings: occupied, unknown, occupied is no change", () => {
    const { calls, engine } = setup([rule()]);
    engine.onState(live(false, false));
    engine.onState(live(true, false));
    engine.onState(live()); // detector gone
    engine.onState(live(true, false));
    expect(calls).toEqual(["tile s1 0"]);
  });

  it("forgets everything while disconnected", () => {
    const { calls, engine } = setup([rule()]);
    engine.onState(live(false, false));
    engine.onState(live(false, false, { connected: false }));
    engine.onState(live(true, false)); // first reading after the connect
    expect(calls).toEqual([]);
  });

  it("waits for the hold time and gives up when the block flickers", () => {
    const { calls, engine, tick } = setup([rule({ trigger: { type: "block", blockId: "b1", occupied: true, holdMs: 1000 } })]);
    engine.onState(live(false, false));
    engine.onState(live(true, false));
    tick(500);
    engine.onState(live(false, false));
    engine.onState(live(true, false));
    tick(600); // the first timer ends here: the block is occupied again, but not without interruption
    expect(calls).toEqual([]);
    tick(400);
    expect(calls).toEqual(["tile s1 0"]);
  });

  it("keeps a minimum distance per rule", () => {
    const { calls, engine, tick } = setup([rule()]);
    engine.onState(live(false, false));
    engine.onState(live(true, false));
    engine.onState(live(false, false));
    tick(500);
    engine.onState(live(true, false));
    expect(calls).toHaveLength(1);
    engine.onState(live(false, false));
    tick(2000);
    engine.onState(live(true, false));
    expect(calls).toHaveLength(2);
  });

  it("checks the conditions and says so when they do not hold", () => {
    const { calls, engine } = setup([rule({ conditions: [{ type: "block", blockId: "b2", occupied: false }] })]);
    engine.onState(live(false, true));
    engine.onState(live(true, true));
    expect(calls).toEqual([]);
    expect(engine.view()[0]!.last!.results).toEqual([{ text: "Bedingungen nicht erfüllt", ok: false }]);
  });

  it("delays actions, and saving the rules drops what is still waiting", () => {
    const { calls, engine, store, tick } = setup([rule({ actions: [{ type: "route", routeId: "r1", do: "request", delayMs: 3000 }, { type: "stopLoco" }] })]);
    engine.onState(live(false, false));
    engine.onState(live(true, false));
    expect(calls).toEqual(["stop 3"]);
    tick(3000);
    expect(calls).toEqual(["stop 3", "request r1"]);

    engine.onState(live(false, false));
    tick(2000);
    engine.onState(live(true, false));
    store.replaceAll(store.list());
    engine.cancelPending();
    tick(5000);
    expect(calls).toEqual(["stop 3", "request r1", "stop 3"]);
  });

  it("reports a locked tile, a refused route and a block without a known loco", async () => {
    const { engine } = setup(
      [rule({ actions: [{ type: "tile", tileId: "w1", state: 1 }, { type: "route", routeId: "r1", do: "request" }, { type: "route", routeId: "r1", do: "release" }, { type: "stopLoco" }] })],
      {
        setTile: async () => { throw new Error("Feld ist durch Fahrstraße „Einfahrt“ verriegelt"); },
        requestRoute: () => ({ ok: false, reason: "Block belegt" }),
        releaseRoute: () => { throw new Error("Auflösen nicht möglich"); },
        locosIn: () => [],
      },
    );
    engine.onState(live(false, false));
    engine.onState(live(true, false));
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.view()[0]!.last!.results.map((r) => r.text).sort()).toEqual([
      "Auflösen nicht möglich", "Fahrstraße „Einfahrt“ abgelehnt: Block belegt", "Feld ist durch Fahrstraße „Einfahrt“ verriegelt", "Keine Lok im Block erkannt",
    ]);
    expect(engine.view()[0]!.last!.results.every((r) => !r.ok)).toBe(true);
  });

  it("does not run disabled rules or rules that point to something missing, and marks the latter", () => {
    const { calls, engine } = setup([rule({ enabled: false }), rule({ id: "broken", actions: [{ type: "tile", tileId: "gone", state: 0 }] })]);
    engine.onState(live(false, false));
    engine.onState(live(true, false));
    expect(calls).toEqual([]);
    expect(engine.view().map((r) => r.broken)).toEqual([[], ["Weiche/Signal fehlt im Gleisbild"]]);
  });
});

describe("locosInBlock", () => {
  it("collects locos from detectors and from train locations", () => {
    const state = { loconetDetectors: [{ feedbackAddress: 9, occupied: true, locoAddress: 44 }], canDetectors: [] };
    expect(locosInBlock(layout, state, [{ address: 12, location: { blockId: "b3" } }, { address: 8, location: { blockId: "b1" } }], "b3")).toEqual([12, 44]);
    expect(locosInBlock(layout, { ...state, loconetDetectors: [{ feedbackAddress: 9, occupied: false, locoAddress: 44 }] }, [], "b3")).toEqual([]);
    expect(locosInBlock(layout, state, [], "nope")).toEqual([]);
  });
});

describe("routes and store", () => {
  it("stores the rules and returns them with their marks", async () => {
    vi.useRealTimers();
    const store = new LayoutRuleStore();
    const engine = new LayoutRuleEngine(store, () => layout, {} as RuleActions);
    const app = Fastify();
    registerLayoutRuleRoutes(app, store, engine);
    const put = await app.inject({ method: "PUT", url: "/api/layout-rules", payload: [rule({ trigger: { type: "block", blockId: "gone", occupied: true } })] });
    expect(put.statusCode).toBe(200);
    expect(put.json()[0].broken).toEqual(["Block fehlt im Gleisbild"]);
    expect((await app.inject({ method: "GET", url: "/api/layout-rules" })).json()).toHaveLength(1);
    const bad = await app.inject({ method: "PUT", url: "/api/layout-rules", payload: [{ id: "a" }] });
    expect(bad.statusCode).toBe(400);
    expect(store.list()).toHaveLength(1);
    await app.close();
  });
});
