import { describe, expect, it, vi } from "vitest";
import type { LocoInfo } from "@z21/protocol";
import { AutomationEngine, AutomationStore, detectEvents, triggered, validateAutomations, type Automation } from "./automations.js";

const loco = (o: Partial<LocoInfo> = {}): LocoInfo => ({ address: 3, steps: 128, busy: false, forward: true, speed: 0, emergencyStop: false, functions: [], ...o });
const auto = (o: Partial<Automation> = {}): Automation => ({
  id: "a1", name: "Licht", enabled: true, trigger: { type: "start" }, conditions: [], actions: [{ type: "function", fn: 1, do: "on" }], ...o,
});

describe("detectEvents", () => {
  it("gives nothing for the first state", () => expect(detectEvents(undefined, loco({ speed: 50 }))).toEqual([]));
  it("start and stop", () => {
    expect(detectEvents(loco(), loco({ speed: 10 }))).toEqual([{ type: "start" }]);
    expect(detectEvents(loco({ speed: 10 }), loco())).toEqual([{ type: "stop" }]);
  });
  it("accelerate and brake only while moving", () => {
    expect(detectEvents(loco({ speed: 10 }), loco({ speed: 20 }))).toEqual([{ type: "accelerate" }]);
    expect(detectEvents(loco({ speed: 20 }), loco({ speed: 10 }))).toEqual([{ type: "brake" }]);
  });
  it("direction, emergency stop and function changes", () => {
    expect(detectEvents(loco(), loco({ forward: false }))).toEqual([{ type: "direction" }]);
    expect(detectEvents(loco(), loco({ emergencyStop: true }))).toEqual([{ type: "estop" }]);
    expect(detectEvents(loco({ functions: [false, true] }), loco({ functions: [false, false, true] })))
      .toEqual([{ type: "function", fn: 1, on: false }, { type: "function", fn: 2, on: true }]);
  });
});

describe("triggered", () => {
  it("needs matching trigger and all conditions", () => {
    const a = auto({ conditions: [{ type: "direction", forward: true }, { type: "function", fn: 0, on: true }] });
    const ev = [{ type: "start" } as const];
    expect(triggered([a], ev, loco({ speed: 5, functions: [true] }))).toEqual([a]);
    expect(triggered([a], ev, loco({ speed: 5, functions: [false] }))).toEqual([]);
    expect(triggered([a], ev, loco({ speed: 5, forward: false, functions: [true] }))).toEqual([]);
  });
  it("ignores disabled ones and other function triggers", () => {
    expect(triggered([auto({ enabled: false })], [{ type: "start" }], loco())).toEqual([]);
    const f = auto({ trigger: { type: "function", fn: 2, on: true } });
    expect(triggered([f], [{ type: "function", fn: 3, on: true }], loco())).toEqual([]);
    expect(triggered([f], [{ type: "function", fn: 2, on: false }], loco())).toEqual([]);
    expect(triggered([f], [{ type: "function", fn: 2, on: true }], loco())).toEqual([f]);
  });
});

describe("validateAutomations", () => {
  it("accepts a valid list and fills defaults", () => {
    const [a] = validateAutomations([{ id: "x", trigger: { type: "stop" }, actions: [{ type: "function", fn: 2, do: "on", forMs: 2000 }] }]);
    expect(a).toMatchObject({ id: "x", enabled: true, conditions: [], name: "Automatismus 1" });
  });
  it.each([
    ["no actions", [{ id: "x", trigger: { type: "start" }, actions: [] }]],
    ["unknown trigger", [{ id: "x", trigger: { type: "x" }, actions: [{ type: "function", fn: 1, do: "on" }] }]],
    ["function out of range", [{ id: "x", trigger: { type: "start" }, actions: [{ type: "function", fn: 40, do: "on" }] }]],
    ["duration with off", [{ id: "x", trigger: { type: "start" }, actions: [{ type: "function", fn: 1, do: "off", forMs: 10 }] }]],
    ["duplicate id", [1, 2].map(() => ({ id: "x", trigger: { type: "start" }, actions: [{ type: "function", fn: 1, do: "on" }] }))],
  ])("rejects %s", (_n, raw) => expect(() => validateAutomations(raw)).toThrow());
});

describe("AutomationEngine", () => {
  const setup = (list: Automation[]) => {
    const store = new AutomationStore();
    store.set(3, list);
    let t = 1000;
    const calls: string[] = [];
    const engine = new AutomationEngine(store, (a, fn, act) => calls.push(`${a}:${fn}:${act}`), () => t);
    return { engine, calls, advance: (ms: number) => { t += ms; } };
  };

  it("runs actions with delay and switches off after the duration", () => {
    vi.useFakeTimers();
    try {
      const { engine, calls } = setup([auto({ actions: [{ type: "function", fn: 1, do: "on" }, { type: "function", fn: 2, do: "on", delayMs: 500, forMs: 2000 }] })]);
      engine.onLoco(loco(), loco({ speed: 10 }));
      expect(calls).toEqual(["3:1:on"]);
      vi.advanceTimersByTime(500);
      expect(calls).toEqual(["3:1:on", "3:2:on"]);
      vi.advanceTimersByTime(2000);
      expect(calls).toEqual(["3:1:on", "3:2:on", "3:2:off"]);
    } finally { vi.useRealTimers(); }
  });

  it("keeps a minimum gap per automation", () => {
    const { engine, calls, advance } = setup([auto({ trigger: { type: "accelerate" } })]);
    engine.onLoco(loco({ speed: 10 }), loco({ speed: 20 }));
    advance(1000);
    engine.onLoco(loco({ speed: 20 }), loco({ speed: 30 }));
    expect(calls).toHaveLength(1);
    advance(3000);
    engine.onLoco(loco({ speed: 30 }), loco({ speed: 40 }));
    expect(calls).toHaveLength(2);
  });

  it("does not react to a function it switched itself (no loop)", () => {
    const { engine, calls, advance } = setup([auto({ trigger: { type: "function", fn: 1, on: true }, actions: [{ type: "function", fn: 1, do: "on" }] }),
      auto({ id: "a2", trigger: { type: "start" } })]);
    engine.onLoco(loco(), loco({ speed: 5 }));           // a2 switches F1
    expect(calls).toEqual(["3:1:on"]);
    engine.onLoco(loco({ speed: 5 }), loco({ speed: 5, functions: [false, true] })); // echo of F1
    expect(calls).toEqual(["3:1:on"]);
    advance(2000);
    engine.onLoco(loco({ speed: 5, functions: [false, false] }), loco({ speed: 5, functions: [false, true] })); // the user pressed F1 later
    expect(calls).toHaveLength(2);
  });

  it("cancelPending drops open delays", () => {
    vi.useFakeTimers();
    try {
      const { engine, calls } = setup([auto({ actions: [{ type: "function", fn: 1, do: "on", delayMs: 500 }] })]);
      engine.onLoco(loco(), loco({ speed: 10 }));
      engine.cancelPending();
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
