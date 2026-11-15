import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout, LocoInfo } from "@openstellwerk/protocol";
import { AutoDriver, creepSpeed, orderFor, type DriveOrder } from "./auto-drive.js";

const layout = {
  cols: 8, rows: 2,
  tiles: [
    { id: "t1", x: 0, y: 0, kind: "straight", rot: 0, feedback: { bus: "rbus", module: 1, input: 1 } },
    { id: "t2", x: 1, y: 0, kind: "straight", rot: 0, feedback: { bus: "rbus", module: 1, input: 2 } },
  ],
  routes: [{ id: "r1", name: "1 nach 2", from: "b1", to: "b2", steps: [] }, { id: "open", name: "ohne Ziel", from: "b1", steps: [] }],
  blocks: [{ id: "b1", name: "Gleis 1", tileIds: ["t1"] }, { id: "b2", name: "Gleis 2", tileIds: ["t2"] }],
} as unknown as Layout;

const live = (b1: boolean, b2: boolean, connected = true) => ({ connected, turnouts: {}, extAccessories: {}, rmbus: [{ module: 1, inputs: [b1, b2] }], loconetDetectors: [], canDetectors: [] });
const order = (o: Partial<DriveOrder> = {}): DriveOrder => ({ trainId: "t", address: 3, routeId: "r1", forward: true, speed: 60, stopDelayMs: 1000, ...o });
const loco = (o: Partial<LocoInfo> = {}): LocoInfo => ({ address: 3, steps: 128, busy: false, forward: true, speed: 60, emergencyStop: false, functions: [], ...o });

function setup() {
  let t = 1_000_000;
  let status: string | undefined = "setting";
  const sent: string[] = [];
  const arrived: string[] = [];
  const driver = new AutoDriver({
    layout: () => layout,
    routeStatus: () => status,
    drive: (a, s, f) => { sent.push(`${a} ${s} ${f ? "v" : "r"}`); },
    now: () => t,
    arrived: (o) => { arrived.push(o.trainId); },
  });
  return { driver, sent, arrived, route: (s: string | undefined) => { status = s; }, tick: (ms: number) => { t += ms; vi.advanceTimersByTime(ms); } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("AutoDriver", () => {
  it("waits for the route, drives, crawls in the target block and stops", () => {
    const { driver, sent, arrived, route, tick } = setup();
    driver.assign(order());
    driver.onState(live(true, false));
    expect(sent).toEqual([]); // the route is still being set
    route("set");
    driver.onState(live(true, false));
    expect(sent).toEqual(["3 60 v"]);
    expect(driver.view().jobs[0]!.phase).toBe("driving");
    route("running");
    driver.onState(live(true, false));
    driver.onState(live(true, true)); // head in the target block
    expect(sent).toEqual(["3 60 v", "3 20 v"]);
    tick(999);
    expect(sent).toHaveLength(2);
    tick(1);
    expect(sent).toEqual(["3 60 v", "3 20 v", "3 0 v"]);
    expect(arrived).toEqual(["t"]);
    expect(driver.view()).toMatchObject({ jobs: [], results: [{ trainId: "t", ok: true, text: "Im Ziel angehalten" }] });
  });

  it("stops at once without a delay, and drives in reverse when told to", () => {
    const { driver, sent, route } = setup();
    driver.assign(order({ stopDelayMs: 0, forward: false }));
    route("set");
    driver.onState(live(true, false));
    driver.onState(live(false, true));
    expect(sent).toEqual(["3 60 r", "3 0 r"]);
  });

  it("stops the loco when the route faults or is released on the way", () => {
    for (const end of ["fault", undefined]) {
      const { driver, sent, route, arrived } = setup();
      driver.assign(order());
      route("set");
      driver.onState(live(true, false));
      route(end);
      driver.onState(live(true, false));
      expect(sent).toEqual(["3 60 v", "3 0 v"]);
      expect(arrived).toEqual([]);
      expect(driver.view().results[0]!.ok).toBe(false);
    }
  });

  it("never starts when the route is refused or faults before the start", () => {
    const { driver, sent, route, tick } = setup();
    driver.assign(order());
    route(undefined);
    driver.onState(live(true, false));
    expect(driver.has("t")).toBe(true); // a short grace: the request may still be on its way
    tick(3001);
    driver.onState(live(true, false));
    expect(driver.has("t")).toBe(false);
    driver.assign(order());
    route("fault");
    driver.onState(live(true, false));
    expect(sent).toEqual([]);
  });

  it("gives up after the time limit and stops the loco", () => {
    const { driver, sent, route, tick } = setup();
    driver.assign(order());
    route("set");
    driver.onState(live(true, false));
    tick(5 * 60_000 + 1);
    driver.onState(live(true, false));
    expect(sent).toEqual(["3 60 v", "3 0 v"]);
    expect(driver.view().results[0]!.text).toMatch(/nicht rechtzeitig/);
  });

  it("lets go when the operator stops the loco, reverses it or hits the emergency stop; a changed speed keeps the stop", () => {
    for (const [info, text] of [[loco({ speed: 0 }), /angehalten/], [loco({ forward: false }), /Richtung/], [loco({ emergencyStop: true }), /Nothalt/]] as const) {
      const { driver, sent, route, tick } = setup();
      driver.assign(order());
      route("set");
      driver.onState(live(true, false));
      driver.onLoco(undefined, loco({ speed: 0 })); // echo right after our own command: ignored
      expect(driver.has("t")).toBe(true);
      tick(2500);
      driver.onLoco(undefined, info);
      expect(driver.has("t")).toBe(false);
      expect(driver.view().results[0]!.text).toMatch(text);
      driver.onState(live(true, true));
      expect(sent).toEqual(["3 60 v"]); // no further command: the operator has the loco
    }
    const { driver, sent, route, tick } = setup();
    driver.assign(order({ stopDelayMs: 0 }));
    route("set");
    driver.onState(live(true, false));
    tick(2500);
    driver.onLoco(undefined, loco({ speed: 90 }));
    driver.onLoco(undefined, loco({ address: 9, speed: 0 })); // another loco
    driver.onState(live(true, true));
    expect(sent).toEqual(["3 60 v", "3 0 v"]);
  });

  it("drives on without stopping when the next order arrives while braking", () => {
    const { driver, sent, arrived, route, tick } = setup();
    driver.assign(order());
    route("set");
    driver.onState(live(true, false));
    driver.onState(live(true, true));
    driver.assign(order({ routeId: "open" }));
    tick(2000);
    expect(arrived).toEqual([]);
    driver.onState(live(false, true));
    expect(sent).toEqual(["3 60 v", "3 20 v", "3 60 v"]);
  });

  it("a route without a target block ends when the route completes", () => {
    const { driver, sent, route } = setup();
    driver.assign(order({ routeId: "open", stopDelayMs: 0 }));
    route("set");
    driver.onState(live(true, false));
    route(undefined);
    driver.onState(live(false, false));
    expect(sent).toEqual(["3 60 v", "3 0 v"]);
    expect(driver.view().results[0]!.ok).toBe(true);
  });

  it("ends every order without a command when the connection is lost, and cancel stops a moving loco", () => {
    const { driver, sent, route } = setup();
    driver.assign(order());
    route("set");
    driver.onState(live(true, false));
    driver.onState(live(true, false, false));
    expect(sent).toEqual(["3 60 v"]);
    expect(driver.has("t")).toBe(false);
    driver.assign(order());
    driver.cancel("t");
    expect(sent).toEqual(["3 60 v"]); // was still waiting
    driver.assign(order());
    driver.onState(live(true, false));
    driver.cancel("t");
    expect(sent).toEqual(["3 60 v", "3 60 v", "3 0 v"]);
  });

  it("crawls at a third of the speed, at least step 8, never faster than the cruise", () => {
    expect([creepSpeed(60), creepSpeed(12), creepSpeed(5), creepSpeed(126)]).toEqual([20, 8, 5, 42]);
  });

  it("builds the order from the train: defaults, own settings, and a stop distance through the speed table", () => {
    const train = { id: "t", name: "Zug", address: 3 };
    expect(orderFor(train, "r1", true)).toEqual({ trainId: "t", address: 3, routeId: "r1", forward: true, speed: 40, stopDelayMs: 1500 });
    expect(orderFor({ ...train, drive: { speed: 60, stopDelayMs: 0 } }, "r1", false)).toMatchObject({ forward: false, speed: 60, stopDelayMs: 0 });
    const cal = { scale: 87, points: [{ step: 20, cmPerSec: 10 }] }; // crawl of speed 60 is step 20: 10 cm/s
    expect(orderFor({ ...train, drive: { speed: 60, stopCm: 25 } }, "r1", true, cal).stopDelayMs).toBe(2500);
    expect(orderFor({ ...train, drive: { speed: 60, stopCm: 25 } }, "r1", true).stopDelayMs).toBe(1500); // no table: the default time
    expect(orderFor({ ...train, drive: { speed: 60, stopCm: 2000 } }, "r1", true, cal).stopDelayMs).toBe(30_000); // capped
  });
});
