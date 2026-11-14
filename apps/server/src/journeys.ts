import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Layout } from "@z21/protocol";
import type { Train } from "@z21/timetable";

/*
 * Zielfahrt: Zug und Zielblock wählen, der Server sucht die Kette gesicherter Fahrstraßen und stellt sie Abschnitt für
 * Abschnitt. Auf Wunsch fährt der Fahrautomat die Lok; sonst fährt der Bediener. Die Sicherung entscheidet über jede
 * Fahrstraße; eine abgelehnte wird wiederholt angefordert, bis die Wartezeit abläuft.
 */

export type JourneyStatus = "waiting" | "set" | "done" | "failed" | "cancelled";

export interface Journey {
  id: string;
  trainId: string;
  targetBlockId: string;
  /** Fahrstraßen in Fahrtreihenfolge */
  routeIds: string[];
  /** Index des aktuellen Abschnitts */
  leg: number;
  status: JourneyStatus;
  /** der Server fährt die Lok in dieser Richtung; ohne: der Bediener fährt */
  drive?: "forward" | "reverse";
  /** warum es gerade nicht weitergeht oder warum die Fahrt endete */
  reason?: string;
  since: number;
}

const err = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** Kürzeste Kette gesicherter Fahrstraßen (wenigste Abschnitte) von Block zu Block; undefined, wenn es keine gibt. */
export function findPath(layout: Layout, from: string, to: string): string[] | undefined {
  if (from === to) return [];
  const prev = new Map<string, { block: string; routeId: string }>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const block = queue.shift()!;
    for (const r of layout.routes) {
      if (r.from !== block || !r.to || seen.has(r.to)) continue;
      seen.add(r.to);
      prev.set(r.to, { block, routeId: r.id });
      if (r.to === to) {
        const path: string[] = [];
        for (let b = to; b !== from; b = prev.get(b)!.block) path.unshift(prev.get(b)!.routeId);
        return path;
      }
      queue.push(r.to);
    }
  }
  return undefined;
}

export interface JourneyDeps {
  layout(): Layout;
  trains(): Train[];
  connected(): boolean;
  requestRoute(routeId: string): { ok: true } | { ok: false; reason: string };
  /** wirft, wenn das Auflösen nicht möglich ist (Zug in der Fahrstraße) */
  releaseRoute(routeId: string): void;
  routeStatus(routeId: string): string | undefined;
  setCarried(trainId: string, blockId: string): void;
  /** true, solange der Zug eine aktive Fahrplan-Abfahrt hat */
  busy(trainId: string): boolean;
  /** Lok fahren lassen (Fahrautomat); nur bei Fahrten mit `drive` */
  drive(journey: Journey, routeId: string, train: Train): void;
  /** Fahrautomat für diesen Zug beenden und die Lok anhalten */
  stopDriving(trainId: string, text: string): void;
  now?(): number;
  changed?(): void;
  /** Start und Ende einer Zielfahrt, für den Verlauf */
  log?(journey: Journey, text: string, ok: boolean): void;
}

export class JourneyRunner {
  private journeys: Journey[] = [];
  private lastTry = new Map<string, number>();
  private now: () => number;

  constructor(
    private deps: JourneyDeps,
    /** so lange wird eine abgelehnte Fahrstraße wieder angefordert (ms) */
    private waitLimitMs = 5 * 60_000,
    /** Abstand zwischen zwei Anforderungen (ms) */
    private retryMs = 2000,
    /** beendete Fahrten bleiben so lange sichtbar (ms) */
    private keepMs = 60_000,
  ) { this.now = deps.now ?? Date.now; }

  list(): Journey[] { return this.journeys; }

  start(input: unknown): Journey {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    if (!this.deps.connected()) throw err("Keine Verbindung zur Zentrale", 409);
    const train = this.deps.trains().find((t) => t.id === o.trainId);
    if (!train) throw err("Zug nicht gefunden", 404);
    if (o.drive !== undefined && o.drive !== null && o.drive !== "forward" && o.drive !== "reverse") throw err("Fahren muss „forward“ oder „reverse“ sein", 400);
    const layout = this.deps.layout();
    const target = (layout.blocks ?? []).find((b) => b.id === o.targetBlockId);
    if (!target) throw err("Zielblock nicht gefunden", 400);
    if (!train.location) throw err("Der Zug hat keinen Standort", 409);
    if (train.location.uncertain) throw err("Der Standort des Zugs ist unsicher; zuerst bestätigen", 409);
    if (train.location.blockId === target.id) throw err("Der Zug steht schon im Zielblock", 409);
    if (this.active(train.id)) throw err("Der Zug ist schon auf einer Zielfahrt", 409);
    if (this.deps.busy(train.id)) throw err("Der Zug hat eine aktive Abfahrt im Fahrplan", 409);
    const routeIds = findPath(layout, train.location.blockId, target.id);
    if (!routeIds) throw err(`Keine Fahrstraßen von „${(layout.blocks ?? []).find((b) => b.id === train.location!.blockId)?.name ?? train.location.blockId}“ nach „${target.name}“`, 409);
    const journey: Journey = { id: randomBytes(4).toString("hex"), trainId: train.id, targetBlockId: target.id, routeIds, leg: 0, status: "waiting", since: this.now() };
    if (o.drive) journey.drive = o.drive as "forward" | "reverse";
    this.journeys.push(journey);
    this.deps.log?.(journey, `gestartet (${routeIds.length} ${routeIds.length === 1 ? "Abschnitt" : "Abschnitte"}${journey.drive ? ", Server fährt" : ""})`, true);
    this.tick();
    return journey;
  }

  /** Fahrt abbrechen: eine noch unbenutzte Fahrstraße wird aufgelöst, eine fahrende Lok angehalten. */
  cancel(id: string): Journey {
    const j = this.journeys.find((x) => x.id === id);
    if (!j) throw err("Zielfahrt nicht gefunden", 404);
    if (j.status !== "waiting" && j.status !== "set") throw err("Die Zielfahrt ist schon beendet", 409);
    if (j.drive) this.deps.stopDriving(j.trainId, "Zielfahrt abgebrochen");
    if (j.status === "set") {
      try { this.deps.releaseRoute(j.routeIds[j.leg]!); } catch { /* Zug schon in der Fahrstraße: sie bleibt bis zur Ankunft oder Notauflösung */ }
    }
    this.finish(j, "cancelled", "Abgebrochen");
    return j;
  }

  /** Die Sicherung meldet das Ende einer Fahrstraße. */
  onEnded(e: { routeId: string; reason: string }) {
    const j = this.journeys.find((x) => x.status === "set" && x.routeIds[x.leg] === e.routeId);
    if (!j) return;
    if (e.reason !== "completed") {
      if (j.drive) this.deps.stopDriving(j.trainId, "Fahrstraße aufgelöst");
      this.finish(j, "failed", e.reason === "fault" ? "Störung der Fahrstraße" : e.reason === "forced" ? "Notauflösung" : "Fahrstraße aufgelöst");
      return;
    }
    const to = this.deps.layout().routes.find((r) => r.id === e.routeId)?.to;
    if (to) this.deps.setCarried(j.trainId, to);
    if (j.leg + 1 >= j.routeIds.length) { this.finish(j, "done"); return; }
    j.leg++;
    j.status = "waiting";
    j.reason = undefined;
    j.since = this.now();
    this.lastTry.delete(j.id);
    this.tick();
  }

  /** Regelmäßig aufrufen (etwa jede Sekunde): fordert wartende Abschnitte an und räumt beendete Fahrten ab. */
  tick() {
    const t = this.now();
    const before = JSON.stringify(this.journeys);
    this.journeys = this.journeys.filter((j) => j.status === "waiting" || j.status === "set" || t - j.since < this.keepMs);
    for (const j of this.journeys) {
      if (j.status === "set" && this.deps.routeStatus(j.routeIds[j.leg]!) === "fault") {
        // the route stays locked until the operator releases it; the journey is over
        if (j.drive) this.deps.stopDriving(j.trainId, "Störung der Fahrstraße");
        this.finish(j, "failed", "Störung der Fahrstraße");
        continue;
      }
      if (j.status !== "waiting") continue;
      if (!this.deps.connected()) { this.finish(j, "failed", "Verbindung getrennt"); continue; }
      const train = this.deps.trains().find((x) => x.id === j.trainId);
      if (!train) { this.finish(j, "failed", "Zug gibt es nicht mehr"); continue; }
      if (t - (this.lastTry.get(j.id) ?? -Infinity) < this.retryMs) continue;
      this.lastTry.set(j.id, t);
      const routeId = j.routeIds[j.leg]!;
      const r = this.deps.requestRoute(routeId);
      if (r.ok) {
        j.status = "set";
        j.reason = undefined;
        j.since = t;
        if (j.drive) this.deps.drive(j, routeId, train);
      } else if (t - j.since > this.waitLimitMs) {
        this.finish(j, "failed", `Fahrstraße nicht frei geworden: ${r.reason}`);
      } else j.reason = r.reason;
    }
    if (JSON.stringify(this.journeys) !== before) this.deps.changed?.();
  }

  private active(trainId: string) { return this.journeys.some((j) => j.trainId === trainId && (j.status === "waiting" || j.status === "set")); }

  /** true, solange der Zug auf einer Zielfahrt ist */
  isActive(trainId: string): boolean { return this.active(trainId); }

  private finish(j: Journey, status: JourneyStatus, reason?: string) {
    j.status = status;
    j.reason = reason;
    j.since = this.now();
    this.lastTry.delete(j.id);
    this.deps.log?.(j, status === "done" ? "angekommen" : reason ?? status, status === "done");
    this.deps.changed?.();
  }
}

export function registerJourneyRoutes(app: FastifyInstance, runner: JourneyRunner) {
  app.get("/api/journeys", async () => runner.list());
  app.post<{ Body: unknown }>("/api/journeys", async (req) => runner.start(req.body));
  app.post<{ Params: { id: string } }>("/api/journeys/:id/cancel", async (req) => runner.cancel(req.params.id));
}
