import type { ClockState } from "./types.js";

export const DAY = 86400;

export const DEFAULT_CLOCK: ClockState = { running: false, factor: 1, baseModel: 0, baseReal: 0 };

/** Model time in seconds since day 0 start; `now` is real time in ms. */
export function modelNow(c: ClockState, now: number): number {
  if (!c.running) return c.baseModel;
  return c.baseModel + ((now - c.baseReal) / 1000) * c.factor;
}

export function timeOfDay(model: number): number {
  return ((Math.floor(model) % DAY) + DAY) % DAY;
}

export function dayOf(model: number): number {
  return Math.floor(model / DAY);
}

export function startClock(c: ClockState, now: number): ClockState {
  if (c.running) return c;
  return { ...c, running: true, baseReal: now };
}

export function stopClock(c: ClockState, now: number): ClockState {
  if (!c.running) return c;
  return { ...c, running: false, baseModel: modelNow(c, now), baseReal: now };
}

export function setClock(c: ClockState, now: number, o: { time?: number; factor?: number }): ClockState {
  if (o.factor !== undefined && (!Number.isInteger(o.factor) || o.factor < 1 || o.factor > 120)) {
    throw new RangeError("Faktor muss eine ganze Zahl von 1 bis 120 sein");
  }
  if (o.time !== undefined && (!Number.isFinite(o.time) || o.time < 0 || o.time >= DAY)) {
    throw new RangeError("Uhrzeit muss zwischen 00:00 und 23:59 liegen");
  }
  const current = modelNow(c, now);
  const baseModel = o.time === undefined ? current : dayOf(current) * DAY + o.time;
  return { ...c, factor: o.factor ?? c.factor, baseModel, baseReal: now };
}
