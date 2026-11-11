import { describe, expect, it } from "vitest";
import { validateLayout, type Layout, type LayoutLiveState } from "@z21/protocol/layout";
import { Interlocking } from "./interlocking.js";

const fb = (input: number) => ({ bus: "rbus" as const, module: 1, input });
const layout: Layout = validateLayout({
  cols: 12, rows: 6,
  tiles: [
    { id: "w1", x: 0, y: 0, kind: "turnoutRight", rot: 0, address: 1 },
    { id: "w2", x: 1, y: 0, kind: "turnoutLeft", rot: 0, address: 2 },
    { id: "s1", x: 2, y: 0, kind: "signal", rot: 0, address: 30 },
    { id: "g1", x: 3, y: 0, kind: "straight", rot: 0, feedback: fb(1) },
    { id: "g2", x: 4, y: 0, kind: "straight", rot: 0, feedback: fb(2) },
    { id: "g3", x: 5, y: 0, kind: "straight", rot: 0, feedback: fb(3) },
    { id: "g4", x: 6, y: 0, kind: "straight", rot: 0, feedback: fb(4) },
  ],
  blocks: [
    { id: "b1", name: "Gleis 1", tileIds: ["g1"] },
    { id: "b2", name: "Gleis 2", tileIds: ["g2"] },
    { id: "b3", name: "Gleis 3", tileIds: ["g3"] },
    { id: "b4", name: "Gleis 4", tileIds: ["g4"] },
  ],
  routes: [
    { id: "r1", name: "1 nach 2", from: "b1", to: "b2", signal: "s1", steps: [{ tileId: "w1", state: 1 }, { tileId: "s1", state: 1 }], flank: [{ tileId: "w2", state: 0 }] },
    { id: "r2", name: "3 nach 2", from: "b3", to: "b2", steps: [{ tileId: "w1", state: 1 }] }, // shares b2 with r1
    { id: "r3", name: "3 nach 4", from: "b3", to: "b4", steps: [{ tileId: "w1", state: 0 }] }, // other position of w1
    { id: "r4", name: "ohne Block", steps: [{ tileId: "w2", state: 1 }] },
  ],
});

/** Live state with all four detectors free, then overrides. */
const live = (o: { occ?: number[]; unknown?: boolean; turnouts?: Record<number, string> } = {}): LayoutLiveState => ({
  turnouts: o.turnouts ?? {}, extAccessories: {},
  rmbus: o.unknown ? [] : [{ module: 1, inputs: [1, 2, 3, 4].map((i) => (o.occ ?? []).includes(i)) }],
  loconetDetectors: [], canDetectors: [],
});
const T = { 1: "p1", 2: "p0" } as Record<number, string>;
const settled = (extra: Record<number, string> = {}) => live({ turnouts: { ...T, ...extra } });

describe("requesting a route", () => {
  it("drives the turnouts first and holds the signal back", () => {
    const il = new Interlocking(layout);
    const r = il.request("r1", live(), 0);
    expect(r.ok).toBe(true);
    expect(r.commands).toEqual([{ type: "turnout", address: 1, output: 1 }, { type: "turnout", address: 2, output: 0 }]);
    expect(il.states()).toEqual([{ routeId: "r1", status: "setting", since: 0 }]);
    expect(il.step(live({ turnouts: { 1: "p1" } }), 100)).toEqual([]); // w2 not reported yet: signal stays at Halt
  });

  it("only sends commands for what is not in place already", () => {
    const il = new Interlocking(layout);
    expect(il.request("r1", live({ turnouts: { 1: "p1" } }), 0).commands).toEqual([{ type: "turnout", address: 2, output: 0 }]);
  });

  it("refuses unknown routes, routes without blocks and double requests", () => {
    const il = new Interlocking(layout);
    expect(il.request("nope", live(), 0).reason).toMatch(/unbekannt/);
    expect(il.request("r4", live(), 0).reason).toMatch(/keine Blöcke/);
    il.request("r1", live(), 0);
    expect(il.request("r1", live(), 0).reason).toMatch(/schon angefordert/);
  });

  it("refuses an occupied block and never treats an unreported one as free", () => {
    const il = new Interlocking(layout);
    expect(il.request("r1", live({ occ: [2] }), 0)).toMatchObject({ ok: false, reason: expect.stringMatching(/Gleis 2.*besetzt/) });
    expect(il.request("r1", live({ unknown: true }), 0)).toMatchObject({ ok: false, reason: expect.stringMatching(/nicht sicher frei/) });
    expect(il.states()).toEqual([]); // a refusal locks nothing
  });

  it("refuses a route that shares a block or needs a turnout in another position", () => {
    const il = new Interlocking(layout);
    il.request("r1", live(), 0);
    expect(il.request("r2", live(), 0).reason).toMatch(/Gleis 2.*„1 nach 2“/);
    expect(il.request("r3", live(), 0).reason).toMatch(/verriegelt/);
  });
});

describe("running a route", () => {
  it("clears the signal after the positions are confirmed, then releases after the train has passed", () => {
    const il = new Interlocking(layout);
    il.request("r1", live(), 0);
    expect(il.step(settled(), 200)).toEqual([{ type: "turnout", address: 30, output: 1 }]); // signal to Fahrt, last
    expect(il.states()[0]!.status).toBe("set");
    expect(il.step(settled(), 300)).toEqual([]);

    expect(il.step(settled(), 400)).toEqual([]);
    const enter = il.step({ ...settled(), rmbus: [{ module: 1, inputs: [true, false, false, false] }] }, 500);
    expect(enter).toEqual([{ type: "turnout", address: 30, output: 0 }]); // signal back to Halt behind the train
    expect(il.states()[0]!.status).toBe("running");

    il.step({ ...settled(), rmbus: [{ module: 1, inputs: [false, true, false, false] }] }, 600); // train moves on
    expect(il.states()[0]!.status).toBe("running");
    il.step({ ...settled(), rmbus: [{ module: 1, inputs: [false, false, false, false] }] }, 700); // and leaves
    expect(il.states()).toEqual([]);
    expect(il.request("r2", live(), 800).ok).toBe(true); // b2 is free again
  });

  it("stays locked while a detector goes silent during the run", () => {
    const il = new Interlocking(layout);
    il.request("r1", live(), 0);
    il.step(settled(), 100);
    il.step({ ...settled(), rmbus: [{ module: 1, inputs: [true, false, false, false] }] }, 200);
    il.step({ ...settled(), rmbus: [] }, 300);
    expect(il.states()[0]!.status).toBe("running");
  });

  it("goes to fault, sets Halt and keeps the locks when a locked turnout is moved by hand", () => {
    const il = new Interlocking(layout);
    il.request("r1", live(), 0);
    il.step(settled(), 100);
    expect(il.step(settled({ 1: "p0" }), 200)).toEqual([{ type: "turnout", address: 30, output: 0 }]);
    expect(il.states()[0]).toMatchObject({ status: "fault", message: expect.stringMatching(/verstellt/) });
    expect(il.request("r3", live(), 300).ok).toBe(false); // still locked
  });

  it("faults when a block is taken while the route is still being set, and when positions never arrive", () => {
    const a = new Interlocking(layout);
    a.request("r1", live(), 0);
    a.step(live({ occ: [1] }), 50);
    expect(a.states()[0]).toMatchObject({ status: "fault", message: expect.stringMatching(/besetzt/) });

    const b = new Interlocking(layout, { settleTimeout: 1000 });
    b.request("r1", live(), 0);
    b.step(live(), 999);
    expect(b.states()[0]!.status).toBe("setting");
    b.step(live(), 1001);
    expect(b.states()[0]).toMatchObject({ status: "fault", message: expect.stringMatching(/rechtzeitig/) });

    const c = new Interlocking(layout);
    c.request("r1", live(), 0);
    c.step(live({ unknown: true }), 50);
    expect(c.states()[0]).toMatchObject({ status: "fault", message: expect.stringMatching(/Melder/) });
  });
});

describe("releasing", () => {
  it("lets the operator cancel a route that has not been used and halts its signal", () => {
    const il = new Interlocking(layout);
    il.request("r1", live(), 0);
    il.step(settled(), 100);
    expect(il.release("r1")).toEqual({ ok: true, commands: [{ type: "turnout", address: 30, output: 0 }] });
    expect(il.states()).toEqual([]);
    expect(il.release("r1").ok).toBe(false);
  });

  it("refuses to release a route with a train in it unless forced", () => {
    const il = new Interlocking(layout);
    il.request("r1", live(), 0);
    il.step(settled(), 100);
    il.step({ ...settled(), rmbus: [{ module: 1, inputs: [true, false, false, false] }] }, 200);
    expect(il.release("r1").reason).toMatch(/Notauflösung/);
    expect(il.release("r1", true).ok).toBe(true);
    expect(il.states()).toEqual([]);
  });

  it("reports which route locks a tile", () => {
    const il = new Interlocking(layout);
    il.request("r1", live(), 0);
    expect(il.lockedBy("w1")).toBe("r1");
    expect(il.lockedBy("w2")).toBe("r1"); // flank protection counts
    expect(il.lockedBy("g4")).toBeUndefined();
    expect([...il.lockedBlocks()].sort()).toEqual(["b1", "b2"]);
  });
});
