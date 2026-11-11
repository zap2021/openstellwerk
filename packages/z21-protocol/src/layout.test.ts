import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activePaths, blockOccupied, feedbackBuses, routeCommands, routeIsSet, stateCount, tileCommands, tileOccupied, tilePaths, tileState,
  turnoutAddresses, validateLayout, type Layout, type LayoutLiveState, type Tile,
} from "./layout.js";

const live = (o: Partial<LayoutLiveState> = {}): LayoutLiveState => ({ turnouts: {}, extAccessories: {}, rmbus: [], loconetDetectors: [], canDetectors: [], ...o });
const tile = (o: Partial<Tile>): Tile => ({ id: "t", x: 0, y: 0, kind: "straight", rot: 0, ...o });

describe("geometry", () => {
  it("rotates paths in 45° steps and keeps the centre", () => {
    expect(tilePaths({ kind: "straight", rot: 0 })).toEqual([[4, 0]]);
    expect(tilePaths({ kind: "straight", rot: 1 })).toEqual([[5, 1]]);
    expect(tilePaths({ kind: "curve", rot: 3 })).toEqual([[7, 4]]); // the mirrored bend needs no extra tile
    expect(tilePaths({ kind: "bufferStop", rot: 6 })).toEqual([[2, -1]]);
  });
  it("highlights only the set branch", () => {
    const t = tile({ kind: "turnoutRight" });
    expect(activePaths(t, 0)).toEqual([0]);
    expect(activePaths(t, 1)).toEqual([1]);
    expect(activePaths(t, undefined)).toEqual([]);
    expect(activePaths(tile({}), undefined)).toEqual([0]);
  });
});

describe("turnouts", () => {
  it("maps positions and honours invert in both directions", () => {
    const t = tile({ kind: "turnoutLeft", address: 5 });
    expect(tileState(t, live())).toBeUndefined();
    expect(tileState(t, live({ turnouts: { 5: "p1" } }))).toBe(1);
    expect(tileCommands(t, 1)).toEqual([{ type: "turnout", address: 5, output: 1 }]);
    const inv = { ...t, invert: true };
    expect(tileState(inv, live({ turnouts: { 5: "p1" } }))).toBe(0);
    expect(tileCommands(inv, 0)).toEqual([{ type: "turnout", address: 5, output: 1 }]);
  });
  it("round-trips every position of three-way turnouts and double slips", () => {
    for (const kind of ["threeWay", "doubleSlip"] as const) {
      const t = tile({ kind, address: 10, address2: 11, invert2: true });
      for (let s = 0; s < stateCount(t); s++) {
        const turnouts: Record<number, string> = {};
        for (const c of tileCommands(t, s)) if (c.type === "turnout") turnouts[c.address] = c.output ? "p1" : "p0";
        expect(tileState(t, live({ turnouts })), `${kind} ${s}`).toBe(s);
      }
    }
    expect(() => tileCommands(tile({ kind: "threeWay" }), 3)).toThrow();
  });
  it("sends nothing for unlinked tiles", () => {
    expect(tileCommands(tile({ kind: "turnoutLeft" }), 1)).toEqual([]);
  });
});

describe("signals", () => {
  it("uses a turnout address for two aspects", () => {
    const s = tile({ kind: "signal", address: 20 });
    expect(tileCommands(s, 1)).toEqual([{ type: "turnout", address: 20, output: 1 }]);
    expect(tileState(s, live({ turnouts: { 20: "p0" } }))).toBe(0);
  });
  it("uses DCCext aspect values", () => {
    const s = tile({ kind: "signal", signalMode: "ext", address: 3, aspects: [{ name: "Hp0", value: 0 }, { name: "Hp1", value: 16 }, { name: "Hp2", value: 4 }] });
    expect(stateCount(s)).toBe(3);
    expect(tileCommands(s, 2)).toEqual([{ type: "ext", address: 3, value: 4 }]);
    expect(tileState(s, live({ extAccessories: { 3: 16 } }))).toBe(1);
    expect(tileState(s, live({ extAccessories: { 3: 99 } }))).toBeUndefined();
  });
});

describe("occupancy", () => {
  it("reads all three detector buses", () => {
    expect(tileOccupied(tile({}), live())).toBeUndefined();
    expect(tileOccupied(tile({ feedback: { bus: "rbus", module: 2, input: 3 } }), live({ rmbus: [{ module: 2, inputs: [false, false, true] }] }))).toBe(true);
    expect(tileOccupied(tile({ feedback: { bus: "loconet", feedbackAddress: 7 } }), live({ loconetDetectors: [{ feedbackAddress: 7, occupied: false }] }))).toBe(false);
    expect(tileOccupied(tile({ feedback: { bus: "can", nid: 1, port: 4 } }), live({ canDetectors: [{ nid: 1, ports: [{ port: 4, occupied: true }] }] }))).toBe(true);
  });
});

const sample: Layout = {
  cols: 10, rows: 5,
  tiles: [
    tile({ id: "w1", kind: "turnoutRight", address: 1 }),
    tile({ id: "w2", x: 1, kind: "turnoutLeft", address: 2, invert: true }),
    tile({ id: "s1", x: 2, kind: "signal", address: 30 }),
    tile({ id: "g1", x: 3, feedback: { bus: "rbus", module: 1, input: 1 } }),
  ],
  routes: [{ id: "r1", name: "Gleis 2", steps: [{ tileId: "w1", state: 1 }, { tileId: "w2", state: 0 }, { tileId: "s1", state: 1 }] }],
};

describe("routes", () => {
  it("turns steps into commands in order and knows when the route is set", () => {
    expect(routeCommands(sample, sample.routes[0]!)).toEqual([
      { type: "turnout", address: 1, output: 1 }, { type: "turnout", address: 2, output: 1 }, { type: "turnout", address: 30, output: 1 },
    ]);
    expect(routeIsSet(sample, sample.routes[0]!, live({ turnouts: { 1: "p1", 2: "p1", 30: "p1" } }))).toBe(true);
    expect(routeIsSet(sample, sample.routes[0]!, live({ turnouts: { 1: "p1", 2: "p0", 30: "p1" } }))).toBe(false);
  });
  it("lists addresses and buses in use", () => {
    expect(turnoutAddresses(sample)).toEqual([1, 2, 30]);
    expect([...feedbackBuses(sample)]).toEqual(["rbus"]);
  });
});

describe("blocks", () => {
  const l: Layout = {
    ...sample,
    tiles: [...sample.tiles, tile({ id: "g2", x: 4, feedback: { bus: "rbus", module: 1, input: 2 } }), tile({ id: "g3", x: 5 })],
    blocks: [{ id: "b1", name: "Gleis 1", tileIds: ["g1", "g2"] }, { id: "b2", name: "Ohne Melder", tileIds: ["g3"] }],
  };
  it("is occupied if any detector is, free only if all report free, otherwise unknown", () => {
    const b1 = l.blocks![0]!;
    expect(blockOccupied(l, b1, live({ rmbus: [{ module: 1, inputs: [false, true] }] }))).toBe(true);
    expect(blockOccupied(l, b1, live({ rmbus: [{ module: 1, inputs: [false, false] }] }))).toBe(false);
    expect(blockOccupied(l, b1, live())).toBeUndefined(); // detectors have not reported: never "free"
    expect(blockOccupied(l, l.blocks![1]!, live())).toBeUndefined(); // no detector linked
  });
  it("validates blocks and the route's safety data", () => {
    const ok = validateLayout({ ...l, routes: [{ ...l.routes[0], from: "b1", to: "b2", signal: "s1", flank: [{ tileId: "w2", state: 0 }] }].map((r) => ({ ...r, steps: r.steps!.filter((s) => s.tileId !== "w2") })) });
    expect(ok.blocks).toHaveLength(2);
    expect(ok.routes[0]).toMatchObject({ from: "b1", to: "b2", signal: "s1", flank: [{ tileId: "w2", state: 0 }] });
    expect(validateLayout(sample).blocks).toBeUndefined(); // old files stay valid and unchanged
    const bad = (patch: (x: Layout) => void) => { const c = JSON.parse(JSON.stringify(l)) as Layout; patch(c); return () => validateLayout(c); };
    expect(bad((c) => { c.blocks![1]!.tileIds = ["g1"]; })).toThrow(/gehört schon zu Block b1/);
    expect(bad((c) => { c.blocks![1]!.tileIds = ["nope"]; })).toThrow(/nicht gibt/);
    expect(bad((c) => { c.blocks![1]!.id = "b1"; })).toThrow(/doppelt/);
    expect(bad((c) => { c.routes[0]!.from = "zzz"; })).toThrow(/Block, den es nicht gibt/);
    expect(bad((c) => { c.routes[0]!.signal = "g1"; })).toThrow(/kein Signal/);
  });
});

describe("validation", () => {
  it("accepts and normalises a good layout", () => {
    const v = validateLayout(JSON.parse(JSON.stringify({ ...sample, tiles: [...sample.tiles, { id: "x", x: 5, y: 1, kind: "text", rot: 0, label: "  Bahnhof ", address: 9, feedback: { bus: "rbus", module: 1, input: 1 } }] })));
    expect(v.tiles).toHaveLength(5);
    expect(v.tiles[4]).toEqual({ id: "x", x: 5, y: 1, kind: "text", rot: 0, label: "Bahnhof" }); // links make no sense on text and are dropped
    expect(v.tiles[2]!.signalMode).toBe("turnout");
  });
  it("rejects broken input with a readable message", () => {
    const bad = (patch: (l: Layout) => void) => { const l = JSON.parse(JSON.stringify(sample)) as Layout; patch(l); return () => validateLayout(l); };
    expect(bad((l) => { l.tiles[1]!.x = 0; })).toThrow(/doppelt belegt/);
    expect(bad((l) => { l.tiles[0]!.address = 0; })).toThrow(/Adresse/);
    expect(bad((l) => { l.tiles[0]!.x = 99; })).toThrow(/Spalte/);
    expect(bad((l) => { l.tiles[0]!.rot = 9; })).toThrow(/Drehung/);
    expect(bad((l) => { (l.tiles[0] as { kind: string }).kind = "loop"; })).toThrow(/Art/);
    expect(bad((l) => { l.tiles[1]!.id = "w1"; })).toThrow(/doppelt/);
    expect(bad((l) => { l.routes[0]!.steps[0]!.tileId = "nope"; })).toThrow(/nicht gibt/);
    expect(bad((l) => { l.routes[0]!.steps[0]!.state = 2; })).toThrow(/Stellung/);
    expect(bad((l) => { l.tiles[3]!.feedback = { bus: "rbus", module: 21, input: 1 }; })).toThrow(/R-BUS/);
    expect(() => validateLayout(null)).toThrow();
    expect(() => validateLayout({ cols: 2, rows: 5, tiles: [] })).toThrow(/Spaltenzahl/);
  });
});

describe("example layout", () => {
  it("docs/beispiel-gleisbild.json stays valid, with interlocked routes", () => {
    const v = validateLayout(JSON.parse(readFileSync(new URL("../../../docs/beispiel-gleisbild.json", import.meta.url), "utf8")));
    expect(v.blocks).toHaveLength(3);
    expect(v.routes.map((r) => [r.from, r.to])).toEqual([["zufahrt", "g1"], ["zufahrt", "g2"]]);
  });
});
