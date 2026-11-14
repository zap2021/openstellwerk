import type { Train, TrainDrive, TrainLocation, Trip } from "./types.js";

const ID = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_DEPARTURES = 200;

function fail(msg: string): never {
  throw new Error(msg);
}

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return fail(`${what} muss eine ganze Zahl von ${min} bis ${max} sein`);
  return v;
}

/** Trimmed string of at most `max` characters; empty → undefined unless `required`. */
function text(v: unknown, max: number, what: string, required = false): string | undefined {
  if (v === undefined || v === null || v === "") return required ? fail(`${what} fehlt`) : undefined;
  if (typeof v !== "string") return fail(`${what} muss Text sein`);
  const s = v.trim();
  if (!s) return required ? fail(`${what} fehlt`) : undefined;
  if (s.length > max) return fail(`${what} darf höchstens ${max} Zeichen haben`);
  return s;
}

function id(v: unknown, where: string, seen: Set<string>): string {
  if (typeof v !== "string" || !ID.test(v)) return fail(`${where}: ungültige Id`);
  if (seen.has(v)) return fail(`${where}: Id ${v} doppelt vergeben`);
  seen.add(v);
  return v;
}

function list(input: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(input)) return fail(`${what} müssen eine Liste sein`);
  return input.map((x, i) => (x && typeof x === "object" ? (x as Record<string, unknown>) : fail(`${what} ${i + 1}: ungültig`)));
}

function cleanLocation(v: unknown, ctx?: { blockIds: Set<string> }): TrainLocation | undefined {
  if (!v || typeof v !== "object") return undefined;
  const l = v as Record<string, unknown>;
  if (typeof l.blockId !== "string" || !ID.test(l.blockId)) return undefined;
  if (l.source !== "manual" && l.source !== "carried" && l.source !== "detected") return undefined;
  if (typeof l.since !== "number" || !Number.isFinite(l.since)) return undefined;
  if (ctx && !ctx.blockIds.has(l.blockId)) return undefined;
  const out: TrainLocation = { blockId: l.blockId, source: l.source, since: l.since };
  if (l.uncertain === true) out.uncertain = true;
  return out;
}

export function validateTrains(input: unknown, ctx?: { blockIds: Set<string> }): Train[] {
  const ids = new Set<string>();
  const addresses = new Set<number>();
  return list(input, "Züge").map((t, i) => {
    const where = `Zug ${i + 1}`;
    const train: Train = {
      id: id(t.id, where, ids),
      name: text(t.name, 40, `${where}: Name`, true)!,
      address: int(t.address, 1, 9999, `${where}: Lokadresse`),
    };
    const number = text(t.number, 12, `${where}: Nummer`);
    if (number) train.number = number;
    if (addresses.has(train.address)) fail(`Lokadresse ${train.address} ist schon einem Zug zugeordnet`);
    addresses.add(train.address);
    const location = cleanLocation(t.location, ctx);
    if (location) train.location = location;
    if (t.drive !== undefined && t.drive !== null) {
      if (typeof t.drive !== "object") fail(`${where}: Fahrdaten ungültig`);
      const d = t.drive as Record<string, unknown>;
      const drive: TrainDrive = { speed: int(d.speed, 1, 126, `${where}: Fahrstufe`) };
      if (d.stopDelayMs !== undefined && d.stopDelayMs !== null) drive.stopDelayMs = int(d.stopDelayMs, 0, 30_000, `${where}: Haltezeit im Zielblock (ms)`);
      if (d.stopCm !== undefined && d.stopCm !== null) drive.stopCm = int(d.stopCm, 0, 2000, `${where}: Halteweg (cm)`);
      train.drive = drive;
    }
    return train;
  });
}

/** Departure minutes of a trip (day-relative, ascending); `repeat.until` is inclusive. */
export function departures(trip: Pick<Trip, "departure" | "repeat">): number[] {
  const out = [trip.departure];
  if (trip.repeat) for (let m = trip.departure + trip.repeat.every; m <= trip.repeat.until; m += trip.repeat.every) out.push(m);
  return out;
}

export function validateTrips(input: unknown, ctx?: { trainIds: Set<string>; routeIds: Set<string> }): Trip[] {
  const ids = new Set<string>();
  return list(input, "Fahrten").map((t, i) => {
    const where = `Fahrt ${i + 1}`;
    const tripId = id(t.id, where, ids);
    if (typeof t.trainId !== "string" || !ID.test(t.trainId)) fail(`${where}: ungültiger Zug`);
    if (typeof t.routeId !== "string" || !ID.test(t.routeId)) fail(`${where}: ungültige Fahrstraße`);
    if (ctx && !ctx.trainIds.has(t.trainId)) fail(`${where}: Zug nicht gefunden`);
    if (ctx && !ctx.routeIds.has(t.routeId)) fail(`${where}: Fahrstraße nicht gefunden`);
    const trip: Trip = {
      id: tripId,
      trainId: t.trainId,
      routeId: t.routeId,
      departure: int(t.departure, 0, 1439, `${where}: Abfahrt`),
      dwell: t.dwell === undefined ? 0 : int(t.dwell, 0, 120, `${where}: Haltezeit`),
    };
    const destination = text(t.destination, 40, `${where}: Ziel`);
    if (destination) trip.destination = destination;
    if (t.drive !== undefined && t.drive !== null) {
      if (t.drive !== "forward" && t.drive !== "reverse") fail(`${where}: Fahren muss „forward“ oder „reverse“ sein`);
      trip.drive = t.drive as "forward" | "reverse";
    }
    if (t.repeat !== undefined && t.repeat !== null) {
      if (typeof t.repeat !== "object") fail(`${where}: Takt ungültig`);
      const r = t.repeat as Record<string, unknown>;
      const every = int(r.every, 1, 1439, `${where}: Takt`);
      const until = int(r.until, 0, 1439, `${where}: Takt bis`);
      if (until < trip.departure) fail(`${where}: Takt-Ende liegt vor der ersten Abfahrt`);
      trip.repeat = { every, until };
    }
    if (departures(trip).length > MAX_DEPARTURES) fail(`${where}: höchstens ${MAX_DEPARTURES} Abfahrten pro Tag`);
    return trip;
  });
}

export function validateSettings(input: unknown): { lateLimit: number } {
  const s = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return { lateLimit: s.lateLimit === undefined ? 5 : int(s.lateLimit, 1, 120, "Verspätungsgrenze") };
}
