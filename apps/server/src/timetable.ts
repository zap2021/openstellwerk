import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_CLOCK, Dispatcher, parseHHMM, setClock, startClock, stopClock, validateSettings, validateTrains, validateTrips,
  type Action, type ClockState, type Instance, type RouteInfo, type RouteResult, type TimetableSnapshot, type Trip,
} from "@z21/timetable";
import { JsonFile } from "./json-file.js";
import type { SignalBox } from "./layout.js";
import type { Station } from "./station.js";
import type { TrainStore } from "./trains.js";

/** The example timetable, relative to this file (repo/docs/beispiel-fahrplan.json). */
const EXAMPLE = new URL("../../../docs/beispiel-fahrplan.json", import.meta.url);

const err = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

interface Stored { trips: Trip[]; settings: { lateLimit: number }; clock: ClockState }

const FINISHED = new Set(["done", "failed", "cancelled"]);
const MAX_INSTANCES = 40;
const MAX_FINISHED = 5;
const byDue = (a: Instance, b: Instance) => a.day - b.day || a.due - b.due || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function restoreClock(raw: unknown): ClockState {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!Number.isInteger(c.factor) || (c.factor as number) < 1 || (c.factor as number) > 120) throw new Error("Uhr: Faktor ungültig");
  if (!num(c.baseModel) || (c.baseModel as number) < 0) throw new Error("Uhr: Modellzeit ungültig");
  return { running: false, factor: c.factor as number, baseModel: c.baseModel as number, baseReal: num(c.baseReal) ? (c.baseReal as number) : 0 };
}

/**
 * Drives the timetable: steps the pure Dispatcher on a timer, asks the signal box for interlocked routes,
 * carries and detects train locations. Instances live only in memory; trips, settings and the clock are stored.
 */
export class TimetableRunner {
  private trips: Trip[] = [];
  private lateLimit = 5;
  private clock: ClockState = { ...DEFAULT_CLOCK };
  private dispatcher = new Dispatcher();
  private instances: Instance[] = [];
  private lastView = "";
  private timer?: NodeJS.Timeout;
  private store: JsonFile<Stored>;
  private tickMs: number;
  /** A running clock is written to the file this often (real ms), so a restart resumes near where it was. */
  private clockSaveMs: number;
  private lastSave = Date.now();

  constructor(private station: Station, private box: SignalBox, private trains: TrainStore, file?: string, opts: { tickMs?: number; clockSaveMs?: number } = {}) {
    this.tickMs = opts.tickMs ?? 1000;
    this.clockSaveMs = opts.clockSaveMs ?? 30_000;
    this.store = new JsonFile(file);
    const raw = this.store.read() as Partial<Record<keyof Stored, unknown>> | undefined;
    let invalid = raw === undefined; // unparseable, or no file (keepInvalid is a no-op then)
    if (raw !== undefined) {
      const part = <T>(what: () => T, fallback: T): T => {
        try { return what(); } catch (e) { console.error("timetable.json ignoriert:", (e as Error).message); invalid = true; return fallback; }
      };
      if (raw === null || typeof raw !== "object") { console.error("timetable.json ignoriert:", "kein Objekt"); invalid = true; }
      else {
        this.trips = part(() => validateTrips(raw.trips), []); // references are checked when a trip runs
        this.lateLimit = part(() => validateSettings(raw.settings).lateLimit, 5);
        if (raw.clock !== undefined) this.clock = part(() => restoreClock(raw.clock), { ...DEFAULT_CLOCK });
      }
    }
    if (invalid) this.store.keepInvalid(); // before any write replaces what could not be used
    station.addExtra(() => ({ timetable: { ...this.view(), serverNow: Date.now() } }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get(): { trips: Trip[]; lateLimit: number; clock: ClockState } {
    return { trips: this.trips, lateLimit: this.lateLimit, clock: this.clock };
  }

  saveTrip(input: unknown, id?: string): Trip {
    if (id !== undefined && !this.trips.some((t) => t.id === id)) throw err("Fahrt nicht gefunden", 404);
    if (id !== undefined && this.dispatcher.hasActive(id)) throw err("Die Fahrt hat eine aktive Abfahrt", 409);
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const tripId = id ?? randomBytes(4).toString("hex");
    let trip: Trip;
    try {
      [trip] = validateTrips([{ ...o, id: tripId }], {
        trainIds: new Set(this.trains.list().map((t) => t.id)),
        routeIds: new Set(this.box.get().routes.map((r) => r.id)),
      });
    } catch (e) { throw err((e as Error).message, 400); }
    const i = this.trips.findIndex((t) => t.id === tripId);
    if (i >= 0) this.trips[i] = trip;
    else this.trips.push(trip);
    this.changed();
    return trip;
  }

  removeTrip(id: string): boolean {
    if (!this.trips.some((t) => t.id === id)) throw err("Fahrt nicht gefunden", 404);
    if (this.dispatcher.hasActive(id)) throw err("Die Fahrt hat eine aktive Abfahrt", 409);
    this.trips = this.trips.filter((t) => t.id !== id);
    this.changed();
    return true;
  }

  /** True while a trip of this train has a waiting, set or running departure; the train cannot be deleted then. */
  trainHasActiveDeparture(trainId: string): boolean {
    return this.trips.some((t) => t.trainId === trainId && this.dispatcher.hasActive(t.id));
  }

  /** The train is being deleted: its trips go with it (callers check trainHasActiveDeparture first). */
  removeTripsOf(trainId: string): void {
    const before = this.trips.length;
    this.trips = this.trips.filter((t) => t.trainId !== trainId);
    if (this.trips.length !== before) this.changed();
  }

  setSettings(input: unknown): { lateLimit: number } {
    let s: { lateLimit: number };
    // The default of validateSettings is for loading files; a request has to say what it wants.
    if (!input || typeof input !== "object" || (input as Record<string, unknown>).lateLimit === undefined) throw err("Verspätungsgrenze fehlt", 400);
    try { s = validateSettings(input); } catch (e) { throw err((e as Error).message, 400); }
    this.lateLimit = s.lateLimit;
    this.changed();
    return s;
  }

  clockAction(body: { action: "start" | "stop" } | { action: "set"; time: string; factor?: number }): ClockState {
    const now = Date.now();
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (b.action === "start") {
      if (!this.station.client.connected) throw err("Keine Verbindung zur Zentrale", 409);
      this.clock = startClock(this.clock, now);
    } else if (b.action === "stop") {
      this.clock = stopClock(this.clock, now);
    } else if (b.action === "set") {
      const minutes = typeof b.time === "string" ? parseHHMM(b.time) : undefined;
      if (minutes === undefined) throw err("Uhrzeit im Format HH:MM angeben", 400);
      if (b.factor !== undefined && typeof b.factor !== "number") throw err("Faktor muss eine ganze Zahl von 1 bis 120 sein", 400);
      try { this.clock = setClock(this.clock, now, { time: minutes * 60, factor: b.factor as number | undefined }); }
      catch (e) { throw err((e as Error).message, 400); }
    } else {
      throw err("Unbekannte Aktion für die Uhr", 400);
    }
    this.changed();
    return this.clock;
  }

  cancelInstance(id: string): void {
    const inst = this.dispatcher.find(id);
    if (!inst) throw err("Abfahrt nicht gefunden", 404);
    if (inst.status !== "planned" && inst.status !== "waiting") throw err("Nur geplante oder wartende Abfahrten können entfallen", 409);
    if (!this.dispatcher.cancel(id)) throw err("Die Fahrstraße für diese Abfahrt wird gerade angefordert", 409);
    this.tick();
  }

  /** True while a departure has its route set or is driving; trips cannot be replaced then. */
  hasRunningDeparture(): boolean {
    return this.instances.some((i) => i.status === "set" || i.status === "running");
  }

  /** Backup restore; trips are expected to be validated by the caller. */
  replaceAll(data: { trips: Trip[]; lateLimit: number }): void {
    if (this.hasRunningDeparture()) throw err("Es läuft gerade eine Fahrt; zuerst beenden", 409);
    this.trips = [...data.trips];
    this.lateLimit = data.lateLimit;
    this.changed();
  }

  /**
   * Load docs/beispiel-fahrplan.json, but only into an empty timetable and only when the current diagram has all
   * blocks and routes it refers to. Nothing is loaded partially.
   * @returns true when something was loaded
   */
  loadExample(): boolean {
    if (this.trains.list().length > 0 || this.trips.length > 0) return false;
    try {
      const raw = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
      const layout = this.box.get();
      const blockIds = new Set((layout.blocks ?? []).map((b) => b.id));
      const routeIds = new Set(layout.routes.map((r) => r.id));
      const trains = validateTrains(raw.trains, { blockIds });
      const trips = validateTrips(raw.trips, { trainIds: new Set(trains.map((t) => t.id)), routeIds });
      const settings = validateSettings(raw.settings);
      this.trains.replaceAll(trains);
      for (const t of trains) if (t.location) this.trains.setLocation(t.id, t.location.blockId);
      this.replaceAll({ trips, lateLimit: settings.lateLimit });
      return true;
    } catch (e) {
      // A diagram that does not fit the example is no error; only an unreadable file is worth a message.
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) console.error("Beispiel-Fahrplan nicht geladen:", (e as Error).message);
      return false;
    }
  }

  /** Persist and react at once (no waiting for the next tick). */
  private changed() {
    this.persist();
    this.tick();
  }

  /** A running clock is stored as it stands at the moment of writing: after a restart it is stopped at that time. */
  private persist() {
    this.lastSave = Date.now();
    this.store.write(() => ({ trips: this.trips, settings: { lateLimit: this.lateLimit }, clock: stopClock(this.clock, Date.now()) }));
  }

  private tick() {
    try { this.step(); } catch (e) { console.error("Fahrplan:", (e as Error).message); }
  }

  private step() {
    const layout = this.box.get();
    this.trains.dropUnknownBlocks(new Set((layout.blocks ?? []).map((b) => b.id)));
    const now = Date.now();
    if (!this.station.client.connected) {
      // Paused: no drainEnded, no step; the clock stops once and stays stopped until the operator starts it.
      if (this.clock.running) {
        this.clock = stopClock(this.clock, now);
        this.persist();
      }
      this.publish();
      return;
    }
    if (this.clock.running && now - this.lastSave >= this.clockSaveMs) this.persist();
    const routes = new Map<string, RouteInfo>(layout.routes.map((r) => [r.id, { from: r.from, to: r.to }]));
    const base = { now, clock: this.clock, lateLimit: this.lateLimit, trips: this.trips, routes, connected: true };
    const ended = this.box.drainEnded();
    const first = this.dispatcher.step({ ...base, trains: this.trains.list(), interlocking: this.box.routeStates(), ended, results: [] });
    const results = this.execute(first.actions);
    let out = first;
    if (results.length) {
      // Results only: the answers are delivered right here, new requests wait for the next tick's first step.
      out = this.dispatcher.step({ ...base, trains: this.trains.list(), interlocking: this.box.routeStates(), ended: [], results, requests: false });
      this.execute(out.actions);
    }
    this.instances = out.instances;
    this.detect();
    this.publish();
  }

  /** Runs the actions; returns the answers to the route requests. */
  private execute(actions: Action[]): RouteResult[] {
    const results: RouteResult[] = [];
    for (const a of actions) {
      if (a.type === "request") {
        const r = this.box.tryRequestRoute(a.routeId);
        results.push(r.ok ? { instanceId: a.instanceId, ok: true } : { instanceId: a.instanceId, ok: false, reason: r.reason });
      } else if (a.type === "location") this.trains.setCarried(a.trainId, a.blockId);
      else this.trains.markUncertain(a.trainId);
    }
    return results;
  }

  /** Loco addresses reported in occupied blocks move trains that are not on a trip. */
  private detect() {
    const layout = this.box.get();
    const blockOf = new Map<string, string>();
    for (const b of layout.blocks ?? []) {
      for (const tid of b.tileIds) {
        const f = layout.tiles.find((t) => t.id === tid)?.feedback;
        if (f?.bus === "loconet") blockOf.set(`loconet:${f.feedbackAddress}`, b.id);
        else if (f?.bus === "can") blockOf.set(`can:${f.nid}:${f.port}`, b.id);
      }
    }
    if (!blockOf.size) return;
    const seen = new Map<number, string>();
    const s = this.station.snapshot();
    for (const d of s.loconetDetectors) {
      const block = blockOf.get(`loconet:${d.feedbackAddress}`);
      if (block && d.occupied && d.locoAddress) seen.set(d.locoAddress, block);
    }
    for (const d of s.canDetectors) {
      for (const p of d.ports) {
        const block = blockOf.get(`can:${d.nid}:${p.port}`);
        if (block && p.occupied) for (const l of p.locos) if (l.address) seen.set(l.address, block);
      }
    }
    if (!seen.size) return;
    const tripTrain = new Map(this.trips.map((t) => [t.id, t.trainId]));
    const busy = new Set(this.instances.filter((i) => i.status === "set" || i.status === "running").map((i) => tripTrain.get(i.tripId)));
    for (const train of this.trains.list()) {
      const block = seen.get(train.address);
      if (block && !busy.has(train.id) && train.location?.blockId !== block) this.trains.setDetected(train.id, block);
    }
  }

  /** Tell the browsers, but only when something they see has changed (the server time is added per snapshot). */
  private publish() {
    const json = JSON.stringify(this.view());
    if (json === this.lastView) return;
    this.lastView = json;
    this.station.notify();
  }

  private view(): TimetableSnapshot {
    const open = this.instances.filter((i) => !FINISHED.has(i.status));
    const finished = this.instances
      .filter((i) => FINISHED.has(i.status))
      .sort((a, b) => a.since - b.since || byDue(a, b))
      .slice(-MAX_FINISHED);
    const instances = [...finished, ...open.slice(0, MAX_INSTANCES - finished.length)].sort(byDue);
    return { clock: this.clock, lateLimit: this.lateLimit, trains: this.trains.list(), instances };
  }
}

export function registerTimetableRoutes(app: FastifyInstance, runner: TimetableRunner): void {
  app.get("/api/timetable", async () => runner.get());
  app.post<{ Body: unknown }>("/api/trips", async (req) => runner.saveTrip(req.body));
  app.put<{ Params: { id: string }; Body: unknown }>("/api/trips/:id", async (req) => runner.saveTrip(req.body, req.params.id));
  app.delete<{ Params: { id: string } }>("/api/trips/:id", async (req) => ({ removed: runner.removeTrip(req.params.id) }));
  app.put<{ Body: unknown }>("/api/timetable/settings", async (req) => runner.setSettings(req.body));
  app.post<{ Body: Parameters<TimetableRunner["clockAction"]>[0] }>("/api/timetable/clock", async (req) => runner.clockAction(req.body));
  app.post<{ Params: { id: string } }>("/api/timetable/instances/:id/cancel", async (req) => {
    runner.cancelInstance(req.params.id);
    return { ok: true };
  });
}
