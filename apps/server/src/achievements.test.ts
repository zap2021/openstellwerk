import { describe, expect, it, vi } from "vitest";
import { AchievementStore, DEFINITIONS, parseAchievements } from "./achievements.js";
import { AutomationStore } from "./automations.js";

describe("AchievementStore", () => {
  it("unlocks at the goal, once, and scores", () => {
    const changed = vi.fn();
    const s = new AchievementStore(undefined, changed);
    for (let i = 0; i < 9; i++) s.onLocoEvents([{ type: "start" }]);
    expect(s.view().items.find((i) => i.id === "starts-10")?.unlockedAt).toBeUndefined();
    expect(s.view().score).toBe(5); // only "Erste Fahrt"
    s.onLocoEvents([{ type: "start" }]);
    const v = s.view();
    expect(v.items.find((i) => i.id === "starts-10")?.unlockedAt).toBeDefined();
    expect(v.score).toBe(15);
    expect(v.latest?.id).toBe("starts-10");
    expect(v.seq).toBe(2);
    s.onLocoEvents([{ type: "start" }]);
    expect(s.view().seq).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("counts a finished departure once", () => {
    const s = new AchievementStore(undefined);
    const inst = [{ id: "t1#0", day: 0, status: "done" }, { id: "t1#1", day: 0, status: "planned" }];
    s.onInstances(inst);
    s.onInstances(inst);
    expect(s.view().stats.departures).toBe(1);
    expect(s.view().items.find((i) => i.id === "departures-1")?.unlockedAt).toBeDefined();
  });

  it("reset clears everything, export/replace round-trips", () => {
    const s = new AchievementStore(undefined);
    s.onLocoEvents([{ type: "start" }, { type: "stop" }]);
    const saved = s.export();
    s.reset();
    expect(s.view()).toMatchObject({ score: 0, seq: 0, stats: { starts: 0 } });
    s.replace(parseAchievements(saved));
    expect(s.view().stats.starts).toBe(1);
    expect(s.view().score).toBe(5);
  });

  it("rejects garbage and drops unknown achievements", () => {
    expect(() => parseAchievements([])).toThrow();
    const p = parseAchievements({ stats: { starts: -4, stops: "x" }, unlocked: { nope: { at: 1 }, "first-start": { at: 5 } } }); // older format = the layout
    expect(p.anlage.stats.starts).toBe(0);
    expect(Object.keys(p.anlage.unlocked)).toEqual(["first-start"]);
    expect(p.users).toEqual({});
  });

  it("counts for the layout and for the user who gave the command, and announces with the name", () => {
    const names: Record<string, string> = { u1: "Anna", u2: "Ben" };
    const s = new AchievementStore(undefined, () => {}, (id) => names[id]);
    s.onLocoEvents([{ type: "start" }], "u1");
    s.onLocoEvents([{ type: "start" }]);                 // nobody to blame: only the layout
    expect(s.view().stats.starts).toBe(2);
    expect(s.viewOf("u1").stats.starts).toBe(1);
    expect(s.viewOf("u2").stats.starts).toBe(0);
    expect(s.view().latest).toMatchObject({ id: "first-start", by: "Anna" });
    expect(s.view().ranking).toEqual([{ userId: "u1", name: "Anna", score: 5 }]);
  });

  it("attributes a loco only briefly after the command", () => {
    const s = new AchievementStore(undefined);
    s.touch(3, "u1", 1000);
    expect(s.actorOf(3, 5000)).toBe("u1");
    expect(s.actorOf(3, 20_000)).toBeUndefined();
    expect(s.actorOf(4, 1000)).toBeUndefined();
  });

  it("resets one user or everything; ranking hides removed accounts", () => {
    const names: Record<string, string> = { u1: "Anna", u2: "Ben" };
    const s = new AchievementStore(undefined, () => {}, (id) => names[id]);
    s.onLocoEvents([{ type: "start" }], "u1");
    s.onLocoEvents([{ type: "start" }], "u2");
    s.reset("u1");
    expect(s.viewOf("u1").stats.starts).toBe(0);
    expect(s.viewOf("u2").stats.starts).toBe(1);
    expect(s.view().stats.starts).toBe(2);
    delete names.u2;
    expect(s.view().ranking).toEqual([]);
    s.reset();
    expect(s.view().stats.starts).toBe(0);
    expect(s.export().users).toEqual({});
  });

  it("definitions have unique ids", () => expect(new Set(DEFINITIONS.map((d) => d.id)).size).toBe(DEFINITIONS.length));
});

describe("AutomationStore.parseAll", () => {
  it("validates a backup map and refuses bad addresses", () => {
    const ok = AutomationStore.parseAll({ "3": [{ id: "a", trigger: { type: "start" }, actions: [{ type: "function", fn: 1, do: "on" }] }] });
    expect(ok.get(3)).toHaveLength(1);
    expect(() => AutomationStore.parseAll({ "0": [] })).toThrow();
    expect(() => AutomationStore.parseAll({ "3": [{ id: "a" }] })).toThrow();
  });
});
