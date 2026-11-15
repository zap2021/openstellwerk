import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "@openstellwerk/protocol";
import { CalibrationRunner, CalibrationStore, cmPerSec, kmh, validateCalibration } from "./calibration.js";

const layout = {
  cols: 8, rows: 2,
  tiles: [
    { id: "t1", x: 0, y: 0, kind: "straight", rot: 0, feedback: { bus: "rbus", module: 1, input: 1 } },
    { id: "t2", x: 1, y: 0, kind: "straight", rot: 0, feedback: { bus: "rbus", module: 1, input: 2 } },
  ],
  routes: [],
  blocks: [{ id: "a", name: "Mess 1", tileIds: ["t1"] }, { id: "b", name: "Mess 2", tileIds: ["t2"] }],
} as unknown as Layout;

const live = (a: boolean, b: boolean, connected = true) => ({ connected, turnouts: {}, extAccessories: {}, rmbus: [{ module: 1, inputs: [a, b] }], loconetDetectors: [], canDetectors: [] });

function setup() {
  let t = 1_000_000;
  const sent: string[] = [];
  const store = new CalibrationStore();
  const runner = new CalibrationRunner(store, { layout: () => layout, drive: (a, s, f) => { sent.push(`${a} ${s} ${f ? "v" : "r"}`); }, now: () => t });
  const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
  return { runner, store, sent, tick };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("speed table", () => {
  const cal = { scale: 87, points: [{ step: 40, cmPerSec: 20 }, { step: 80, cmPerSec: 50 }] };
  it("interpolates from standstill through the points and beyond the last one", () => {
    expect(cmPerSec(cal, 0)).toBe(0);
    expect(cmPerSec(cal, 20)).toBe(10);
    expect(cmPerSec(cal, 40)).toBe(20);
    expect(cmPerSec(cal, 60)).toBe(35);
    expect(cmPerSec(cal, 100)).toBe(65);
    expect(cmPerSec(undefined, 40)).toBeUndefined();
    expect(cmPerSec({ scale: 87, points: [] }, 40)).toBeUndefined();
  });
  it("converts to scale km/h", () => {
    expect(kmh(cal, 40)).toBe(62.6); // 20 cm/s × 87 × 0.036
    expect(kmh(undefined, 40)).toBeUndefined();
  });
  it("validates and sorts", () => {
    expect(validateCalibration({ scale: 160, points: [{ step: 80, cmPerSec: 30 }, { step: 20, cmPerSec: 5 }] }).points.map((p) => p.step)).toEqual([20, 80]);
    expect(() => validateCalibration({ scale: 0, points: [] })).toThrow(/Maßstab/);
    expect(() => validateCalibration({ scale: 87, points: [{ step: 200, cmPerSec: 1 }] })).toThrow(/Fahrstufe/);
    expect(() => validateCalibration({ scale: 87, points: [{ step: 5, cmPerSec: 1 }, { step: 5, cmPerSec: 2 }] })).toThrow(/doppelt/);
    expect(() => CalibrationStore.parseAll({ abc: { scale: 87, points: [] } })).toThrow(/Lokadresse/);
  });
});

describe("CalibrationRunner", () => {
  const req = { address: 3, startBlockId: "a", endBlockId: "b", distanceCm: 100, steps: [60, 30], returnStep: 50 };

  it("measures each step, drives back in between and stores the table", () => {
    const { runner, store, sent, tick } = setup();
    runner.onState(live(false, false));
    expect(runner.start(req)).toMatchObject({ running: true, steps: [30, 60], index: 0, phase: "approach" });
    expect(sent).toEqual(["3 30 v"]);
    tick(1000);
    runner.onState(live(true, false)); // enters the start block
    tick(5000);
    runner.onState(live(true, true)); // reaches the end block 5 s later: 20 cm/s
    expect(sent).toEqual(["3 30 v", "3 0 v"]);
    expect(store.get(3)).toEqual({ scale: 87, points: [{ step: 30, cmPerSec: 20 }] });

    tick(2500); // settles, then drives back
    expect(sent.at(-1)).toBe("3 50 r");
    runner.onState(live(true, false));
    runner.onState(live(false, false)); // has left the section
    expect(runner.view()!.phase).toBe("runout");
    tick(3000);
    expect(sent.at(-1)).toBe("3 0 r");
    tick(2500);
    expect(sent.at(-1)).toBe("3 60 v"); // second step
    tick(500);
    runner.onState(live(true, false));
    tick(2000);
    runner.onState(live(false, true));
    expect(store.get(3)!.points).toEqual([{ step: 30, cmPerSec: 20 }, { step: 60, cmPerSec: 50 }]);
    expect(runner.view()).toMatchObject({ running: false, results: [{ step: 30, cmPerSec: 20 }, { step: 60, cmPerSec: 50 }] });
    expect(runner.view()!.error).toBeUndefined();
    expect(sent.at(-1)).toBe("3 0 v");
  });

  it("refuses a section that is not free and bad input", () => {
    const { runner, sent } = setup();
    expect(() => runner.start(req)).toThrow(/Verbindung/);
    runner.onState(live(true, false));
    runner.start(req);
    expect(runner.view()).toMatchObject({ running: false, error: expect.stringMatching(/nicht frei/) });
    expect(sent).toEqual(["3 0 v"]);
    runner.onState(live(false, false));
    expect(() => runner.start({ ...req, endBlockId: "a" })).toThrow(/verschieden/);
    expect(() => runner.start({ ...req, distanceCm: 1 })).toThrow(/Strecke/);
    expect(() => runner.start({ ...req, steps: [] })).toThrow(/Fahrstufen/);
    expect(() => runner.start({ ...req, steps: [200] })).toThrow(/Fahrstufe/);
    expect(() => runner.start({ ...req, startBlockId: "x" })).toThrow(/Startblock/);
    runner.start(req);
    expect(() => runner.start(req)).toThrow(/läuft schon/);
  });

  it("stops the loco on wrong direction, timeout, too short a time, a lost connection and on stop", () => {
    const wrong = setup();
    wrong.runner.onState(live(false, false));
    wrong.runner.start(req);
    wrong.runner.onState(live(false, true));
    expect(wrong.runner.view()!.error).toMatch(/vor dem Startblock/);
    expect(wrong.sent.at(-1)).toBe("3 0 v");

    const slow = setup();
    slow.runner.onState(live(false, false));
    slow.runner.start(req);
    slow.tick(90_001);
    slow.runner.onState(live(false, false));
    expect(slow.runner.view()!.error).toMatch(/nicht rechtzeitig/);
    expect(slow.sent.at(-1)).toBe("3 0 v");

    const quick = setup();
    quick.runner.onState(live(false, false));
    quick.runner.start(req);
    quick.runner.onState(live(true, false));
    quick.tick(50);
    quick.runner.onState(live(true, true));
    expect(quick.runner.view()!.error).toMatch(/zu kurz/);
    expect(quick.store.get(3)).toBeUndefined();

    const lost = setup();
    lost.runner.onState(live(false, false));
    lost.runner.start(req);
    lost.runner.onState(live(false, false, false));
    expect(lost.runner.view()!.error).toMatch(/Verbindung/);

    const stopped = setup();
    stopped.runner.onState(live(false, false));
    stopped.runner.start(req);
    stopped.runner.stop();
    expect(stopped.runner.view()).toMatchObject({ running: false, error: "Abgebrochen" });
    expect(stopped.sent).toEqual(["3 30 v", "3 0 v"]);
    stopped.tick(60_000);
    expect(stopped.sent).toHaveLength(2); // nothing drives on afterwards
  });
});
