import { describe, expect, it } from "vitest";
import { DAY, DEFAULT_CLOCK, dayOf, modelNow, setClock, startClock, stopClock, timeOfDay } from "./clock.js";

describe("model clock", () => {
  const running = { running: true, factor: 20, baseModel: 1000, baseReal: 5000 };
  it("advances with factor while running", () => {
    expect(modelNow(running, 8000)).toBe(1060);
  });
  it("does not advance when stopped", () => {
    expect(modelNow({ ...running, running: false }, 99999)).toBe(1000);
  });
  it("stop freezes, start rebases", () => {
    const stopped = stopClock(running, 8000);
    expect(stopped).toEqual({ running: false, factor: 20, baseModel: 1060, baseReal: 8000 });
    expect(modelNow(stopped, 20000)).toBe(1060);
    const again = startClock(stopped, 20000);
    expect(again.running).toBe(true);
    expect(again.baseReal).toBe(20000);
    expect(modelNow(again, 23000)).toBe(1120);
  });
  it("start/stop are idempotent", () => {
    expect(startClock(running, 9000)).toBe(running);
    const s = DEFAULT_CLOCK;
    expect(stopClock(s, 9000)).toBe(s);
  });
  it("setClock sets time of day, keeps day and running state", () => {
    const c = setClock({ ...DEFAULT_CLOCK, baseModel: DAY * 2 + 100 }, 0, { time: 7 * 3600 + 5 * 60 });
    expect(timeOfDay(modelNow(c, 0))).toBe(25500);
    expect(dayOf(modelNow(c, 0))).toBe(2);
    expect(c.running).toBe(false);
  });
  it("setClock factor only does not jump", () => {
    const c = setClock(running, 8000, { factor: 60 });
    expect(modelNow(c, 8000)).toBe(1060);
    expect(modelNow(c, 9000)).toBe(1120);
    expect(c.running).toBe(true);
  });
  it("rejects invalid factor", () => {
    expect(() => setClock(running, 0, { factor: 0 })).toThrow(RangeError);
    expect(() => setClock(running, 0, { factor: 121 })).toThrow(RangeError);
    expect(() => setClock(running, 0, { factor: 1.5 })).toThrow(RangeError);
  });
  it("dayOf / timeOfDay", () => {
    expect(dayOf(86400 + 5)).toBe(1);
    expect(timeOfDay(86400 + 5)).toBe(5);
  });
});
