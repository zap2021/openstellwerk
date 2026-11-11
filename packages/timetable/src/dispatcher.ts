import { DAY, modelNow } from "./clock.js";
import { formatHHMM } from "./format.js";
import type { ClockState, Instance, Status, Train, Trip } from "./types.js";
import { departures } from "./validate.js";

export interface RouteInfo {
  from?: string;
  to?: string;
}
/** Live state of a route in the interlocking; only "setting", "set", "running" and "fault" are acted on. */
export interface RouteStatusInfo {
  routeId: string;
  status: string;
}
export interface EndedRoute {
  routeId: string;
  reason: "completed" | "released" | "forced" | "fault";
}
export interface RouteResult {
  instanceId: string;
  ok: boolean;
  reason?: string;
}
export interface DispatchInput {
  now: number;
  clock: ClockState;
  lateLimit: number;
  trips: Trip[];
  trains: Train[];
  routes: Map<string, RouteInfo>;
  connected: boolean;
  interlocking: RouteStatusInfo[];
  ended: EndedRoute[];
  results: RouteResult[];
}
export type Action =
  | { type: "request"; instanceId: string; routeId: string }
  | { type: "location"; trainId: string; blockId: string }
  | { type: "uncertain"; trainId: string };

/** An instance plus the trip it was made from (frozen once the instance leaves planned/waiting). */
interface Rec {
  inst: Instance;
  index: number;
  trip: Trip;
}

const ENDED_TEXT: Record<EndedRoute["reason"], string> = {
  completed: "",
  released: "Fahrstraße aufgelöst",
  forced: "Notauflösung",
  fault: "Störung der Fahrstraße",
};

const NO_ANSWER = "Keine Antwort der Sicherung";

const byOrder = (a: Instance, b: Instance) => a.day - b.day || a.due - b.due || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Dispatcher {
  private recs: Rec[] = [];
  /** Instances with a `request` action whose result has not arrived yet. */
  private requested = new Set<Rec>();
  /** Per train: model second of the end of its last trip and that trip's dwell (minutes). */
  private lastEnd = new Map<string, { endedAt: number; dwell: number }>();
  private t = 0;

  step(input: DispatchInput): { instances: Instance[]; actions: Action[] } {
    if (!input.connected) return { instances: this.snapshot(), actions: [] };
    const t = Math.floor(modelNow(input.clock, input.now));
    const day = Math.floor(t / DAY);
    this.t = t;
    const actions: Action[] = [];
    this.sync(input.trips, day);

    const wasActive = new Set(this.recs.filter((r) => this.isActive(r.inst.status)));
    for (const res of input.results) {
      const rec = [...this.requested].find((r) => r.inst.id === res.instanceId);
      if (!rec) continue;
      this.requested.delete(rec);
      if (rec.inst.status !== "waiting") continue;
      if (res.ok) this.change(rec, "set");
      else rec.inst.reason = res.reason ?? "Fahrstraße abgelehnt";
    }
    // A request without an answer in the following connected step counts as lost: retry next step.
    const unanswered = new Set(this.requested);
    this.requested.clear();
    for (const rec of unanswered) if (rec.inst.status === "waiting") rec.inst.reason = NO_ANSWER;

    for (const e of input.ended) {
      const rec = this.recs.find((r) => this.isActive(r.inst.status) && r.trip.routeId === e.routeId);
      if (!rec) continue;
      const wasRunning = rec.inst.status === "running";
      const trainId = rec.trip.trainId;
      if (e.reason === "completed") {
        this.change(rec, "done");
        const to = input.routes.get(e.routeId)?.to;
        if (to) actions.push({ type: "location", trainId, blockId: to });
      } else {
        this.change(rec, e.reason === "released" ? "cancelled" : "failed", ENDED_TEXT[e.reason]);
        if (wasRunning) actions.push({ type: "uncertain", trainId });
      }
    }

    // Reconcile with the interlocking. A record that only became `set` in this step is exempt from
    // the "route missing" rule: the runner may have read the interlocking before the request ran.
    const live = new Map(input.interlocking.map((s) => [s.routeId, s.status]));
    for (const rec of this.recs) {
      if (!this.isActive(rec.inst.status)) continue;
      const wasRunning = rec.inst.status === "running";
      const st = live.get(rec.trip.routeId);
      if (st === undefined && !wasActive.has(rec)) continue;
      if (st === "running" && !wasRunning) this.change(rec, "running");
      else if (st === "fault" || st === undefined) {
        this.change(rec, "failed", st === "fault" ? ENDED_TEXT.fault : "Fahrstraße nicht mehr aktiv");
        if (wasRunning) actions.push({ type: "uncertain", trainId: rec.trip.trainId });
      }
    }

    const late = input.lateLimit * 60;
    const trains = new Map(input.trains.map((tr) => [tr.id, tr]));
    for (const rec of this.sorted()) {
      const inst = rec.inst;
      const overdue = t - (inst.day * DAY + inst.due);
      if (inst.status === "planned") {
        if (overdue < 0) continue;
        if (overdue > late) {
          this.change(rec, "cancelled", "verpasst");
          continue;
        }
        this.change(rec, "waiting");
      }
      if (inst.status !== "waiting") continue;
      if (overdue > late) {
        this.change(rec, "failed", `Verspätungsgrenze überschritten: ${inst.reason ?? "unbekannt"}`);
        continue;
      }
      if (unanswered.has(rec)) continue;
      const route = input.routes.get(rec.trip.routeId);
      if (!route) {
        this.change(rec, "failed", "Fahrstraße nicht mehr vorhanden");
        continue;
      }
      const train = trains.get(rec.trip.trainId);
      if (!train) {
        this.change(rec, "failed", "Zug nicht mehr vorhanden");
        continue;
      }
      const reason = this.blocker(rec, train, route);
      if (reason) {
        inst.reason = reason;
        continue;
      }
      this.requested.add(rec);
      actions.push({ type: "request", instanceId: inst.id, routeId: rec.trip.routeId });
    }
    return { instances: this.snapshot(), actions };
  }

  /** Operator cancel ("Entfallen lassen"); only in planned/waiting and not while a request is pending. */
  cancel(instanceId: string): boolean {
    const rec = this.lookup(instanceId);
    if (!rec || (rec.inst.status !== "planned" && rec.inst.status !== "waiting") || this.requested.has(rec)) return false;
    this.change(rec, "cancelled", "vom Bediener");
    return true;
  }

  find(instanceId: string): Instance | undefined {
    const rec = this.lookup(instanceId);
    return rec ? { ...rec.inst } : undefined;
  }

  hasActive(tripId: string): boolean {
    return this.recs.some((r) => r.inst.tripId === tripId && (r.inst.status === "waiting" || this.isActive(r.inst.status)));
  }

  /** First unmet condition before a request may be sent, or undefined. */
  private blocker(rec: Rec, train: Train, route: RouteInfo): string | undefined {
    const busy = this.recs.some(
      (r) => r !== rec && r.trip.trainId === train.id && (this.isActive(r.inst.status) || this.requested.has(r)),
    );
    if (busy) return "Zug ist noch auf einer anderen Fahrt";
    const end = this.lastEnd.get(train.id);
    if (end && this.t < end.endedAt + end.dwell * 60) {
      return `Halt nach der letzten Fahrt bis ${formatHHMM((end.endedAt + end.dwell * 60) / 60)}`;
    }
    if (route.from !== undefined) {
      if (!train.location) return "Zug hat keinen Standort";
      if (train.location.blockId !== route.from) return `Zug nicht im Startblock (bekannt: ${train.location.blockId})`;
    }
    return undefined;
  }

  /**
   * Keeps active instances (set/running or with a pending request) whatever happens; every other
   * instance must belong to the current model day and to a trip (and departure) that still exists.
   * Missing departures of the current day are added as planned.
   */
  private sync(trips: Trip[], day: number): void {
    const byId = new Map(trips.map((tr) => [tr.id, tr]));
    this.recs = this.recs.filter((r) => {
      if (this.isActive(r.inst.status) || this.requested.has(r)) return true;
      if (r.inst.day !== day) return false;
      const trip = byId.get(r.inst.tripId);
      if (!trip) return false;
      const deps = departures(trip);
      if (r.index >= deps.length) return false;
      if (r.inst.status === "planned" || r.inst.status === "waiting") r.trip = trip;
      if (r.inst.status === "planned") r.inst.due = deps[r.index] * 60;
      return true;
    });
    const have = new Set(this.recs.filter((r) => r.inst.day === day).map((r) => r.inst.id));
    for (const trip of trips) {
      departures(trip).forEach((m, index) => {
        const id = `${trip.id}#${index}`;
        if (have.has(id)) return;
        this.recs.push({ inst: { id, tripId: trip.id, day, due: m * 60, status: "planned", since: this.t }, index, trip });
      });
    }
  }

  private change(rec: Rec, status: Status, reason?: string): void {
    if (this.isActive(rec.inst.status) && !this.isActive(status)) {
      this.lastEnd.set(rec.trip.trainId, { endedAt: this.t, dwell: rec.trip.dwell });
    }
    rec.inst.status = status;
    rec.inst.since = this.t;
    if (reason === undefined) delete rec.inst.reason;
    else rec.inst.reason = reason;
  }

  private isActive(s: Status): boolean {
    return s === "set" || s === "running";
  }

  /** Latest instance with this id (ids repeat across model days). */
  private lookup(instanceId: string): Rec | undefined {
    return this.sorted()
      .filter((r) => r.inst.id === instanceId)
      .pop();
  }

  private sorted(): Rec[] {
    return [...this.recs].sort((a, b) => byOrder(a.inst, b.inst));
  }

  private snapshot(): Instance[] {
    return this.sorted().map((r) => ({ ...r.inst }));
  }
}
