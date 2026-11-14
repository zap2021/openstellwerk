import { blockOccupied, type Layout, type LayoutLiveState, type LocoInfo } from "@z21/protocol";
import { DEFAULT_DRIVE, type Train, type TrainDrive } from "@z21/timetable";
import { cmPerSec, type Calibration } from "./calibration.js";

/*
 * Fahrautomat (Automatik Stufe 2): fährt eine Lok über eine gesicherte Fahrstraße. Er fährt erst an, wenn die Sicherung
 * die Fahrstraße gestellt hat (Signal auf Fahrt), bremst beim Erreichen des Zielblocks und hält dort an.
 * Er stellt selbst nichts: Weichen, Signale und Verriegelung bleiben Sache der Sicherung.
 *
 * Sicherheit:
 *  - Anfahren nur bei gestellter Fahrstraße. Störung oder Auflösung unterwegs: Lok hält sofort.
 *  - Hält der Bediener die Lok an, wechselt er die Richtung oder löst er den Lok-Nothalt aus, lässt der Automat die
 *    Lok los und fährt nicht wieder an. Ändert der Bediener nur die Geschwindigkeit, hält der Automat trotzdem im Ziel.
 *  - Erreicht die Lok das Ziel nicht in der vorgegebenen Zeit, hält sie an.
 *  - Ohne Verbindung enden alle Aufträge (es lässt sich nichts mehr befehlen).
 */

export interface DriveOrder {
  trainId: string;
  address: number;
  routeId: string;
  forward: boolean;
  /** Fahrstufe 1..126 */
  speed: number;
  /** nach dem Einfahren in den Zielblock so lange langsam weiter, dann Halt (ms) */
  stopDelayMs: number;
}

export type DrivePhase = "waiting" | "driving" | "braking";
export interface DriveView { trainId: string; address: number; routeId: string; phase: DrivePhase }
export interface DriveResult { trainId: string; routeId: string; ok: boolean; text: string; ts: number }

export interface DriveDeps {
  layout(): Layout;
  /** Status der Fahrstraße in der Sicherung; undefined = nicht (mehr) angefordert */
  routeStatus(routeId: string): string | undefined;
  /** Fahrbefehl; speed 0 = normaler Halt mit der Bremsverzögerung des Decoders */
  drive(address: number, speed: number, forward: boolean): void;
  now?(): number;
  /** nach jeder Änderung, die die Oberfläche zeigen soll */
  changed?(): void;
  /** Lok steht im Ziel (nicht bei Abbruch) */
  arrived?(order: DriveOrder): void;
  /** jedes Ende eines Auftrags, für den Verlauf */
  log?(order: DriveOrder, text: string, ok: boolean): void;
}

interface Job { order: DriveOrder; phase: DrivePhase; createdAt: number; startedAt?: number; commandedAt: number; timer?: NodeJS.Timeout }

type Live = LayoutLiveState & { connected: boolean };

/** Kriechfahrt im Zielblock: ein Drittel der Reisegeschwindigkeit, mindestens Fahrstufe 8, nie schneller als die Reise. */
export const creepSpeed = (speed: number) => Math.max(1, Math.min(speed, Math.max(8, Math.round(speed / 3))));

/**
 * Fahrauftrag für einen Zug: seine Fahrdaten oder die Vorgaben. Ein Halteweg (cm) wird über die Kennlinie der Lok in die
 * Zeit der Kriechfahrt umgerechnet; ohne Kennlinie gilt die eingestellte Zeit.
 */
export function orderFor(train: Train, routeId: string, forward: boolean, cal?: Calibration): DriveOrder {
  const d: TrainDrive = train.drive ?? DEFAULT_DRIVE;
  const crawl = d.stopCm ? cmPerSec(cal, creepSpeed(d.speed)) : undefined;
  const stopDelayMs = d.stopCm && crawl ? Math.min(30_000, Math.round((d.stopCm / crawl) * 1000)) : d.stopDelayMs ?? DEFAULT_DRIVE.stopDelayMs;
  return { trainId: train.id, address: train.address, routeId, forward, speed: d.speed, stopDelayMs };
}

export class AutoDriver {
  private jobs = new Map<string, Job>();
  private results = new Map<string, DriveResult>();
  private now: () => number;

  constructor(
    private deps: DriveDeps,
    /** längste Fahrzeit bis zum Ziel (ms) */
    private maxRunMs = 5 * 60_000,
    /** so lange darf eine Fahrstraße nach dem Auftrag noch fehlen (ms) */
    private graceMs = 3000,
    /** Lok-Meldungen kurz nach einem eigenen Befehl sind dessen Echo, keine Handbedienung (ms) */
    private echoMs = 2000,
  ) { this.now = deps.now ?? Date.now; }

  /** Auftrag annehmen; ein früherer Auftrag desselben Zugs wird ersetzt (ohne Halt: die Lok fährt durch). */
  assign(order: DriveOrder) {
    this.drop(order.trainId);
    this.jobs.set(order.trainId, { order, phase: "waiting", createdAt: this.now(), commandedAt: -Infinity });
    this.results.delete(order.trainId);
    this.deps.changed?.();
  }

  /** Auftrag beenden; mit `halt` wird die Lok angehalten, wenn sie schon fährt. */
  cancel(trainId: string, text = "Abgebrochen", halt = true) {
    const job = this.jobs.get(trainId);
    if (!job) return;
    this.end(job, false, text, halt && job.phase !== "waiting");
  }

  has(trainId: string): boolean { return this.jobs.has(trainId); }

  view(): { jobs: DriveView[]; results: DriveResult[] } {
    const cutoff = this.now() - 60_000;
    for (const [id, r] of this.results) if (r.ts < cutoff) this.results.delete(id);
    return {
      jobs: [...this.jobs.values()].map((j) => ({ trainId: j.order.trainId, address: j.order.address, routeId: j.order.routeId, phase: j.phase })),
      results: [...this.results.values()],
    };
  }

  /** Bei jeder Zustandsänderung der Zentrale und mindestens einmal pro Sekunde aufrufen. */
  onState(live: Live) {
    if (!live.connected) {
      for (const job of [...this.jobs.values()]) this.end(job, false, "Verbindung getrennt", false);
      return;
    }
    const layout = this.deps.layout();
    const t = this.now();
    for (const job of [...this.jobs.values()]) {
      const { order } = job;
      const status = this.deps.routeStatus(order.routeId);
      const route = layout.routes.find((r) => r.id === order.routeId);
      if (!route) { this.end(job, false, "Fahrstraße gibt es nicht mehr", job.phase !== "waiting"); continue; }
      if (status === "fault") { this.end(job, false, "Störung der Fahrstraße", job.phase !== "waiting"); continue; }

      if (job.phase === "waiting") {
        if (status === "set" || status === "running") {
          job.phase = "driving";
          job.startedAt = t;
          this.command(job, order.speed);
          this.deps.changed?.();
        } else if (status === undefined && t - job.createdAt > this.graceMs) {
          this.end(job, false, "Fahrstraße nicht mehr angefordert", false);
        }
        continue;
      }
      if (job.phase !== "driving") continue; // braking: the timer finishes it

      const target = route.to && route.to !== route.from ? (layout.blocks ?? []).find((b) => b.id === route.to) : undefined;
      if (target ? blockOccupied(layout, target, live) === true : status === undefined) { this.arrive(job); continue; }
      if (status === undefined) { this.end(job, false, "Fahrstraße aufgelöst", true); continue; }
      if (t - (job.startedAt ?? t) > this.maxRunMs) this.end(job, false, "Ziel nicht rechtzeitig erreicht", true);
    }
  }

  /** Lok-Meldung: Handbedienung erkennen. */
  onLoco(_prev: LocoInfo | undefined, next: LocoInfo) {
    for (const job of [...this.jobs.values()]) {
      if (job.order.address !== next.address || job.phase === "waiting") continue;
      if (this.now() - job.commandedAt < this.echoMs) continue;
      if (next.emergencyStop) this.end(job, false, "Lok-Nothalt", false);
      else if (next.forward !== job.order.forward) this.end(job, false, "Von Hand übernommen (Richtung gewechselt)", false);
      else if (next.speed === 0) this.end(job, false, "Von Hand angehalten", false);
    }
  }

  private arrive(job: Job) {
    const { order } = job;
    job.phase = "braking";
    if (order.stopDelayMs > 0) {
      this.command(job, creepSpeed(order.speed));
      job.timer = setTimeout(() => { job.timer = undefined; this.finish(job); }, order.stopDelayMs);
      job.timer.unref?.();
      this.deps.changed?.();
    } else this.finish(job);
  }

  private finish(job: Job) {
    if (this.jobs.get(job.order.trainId) !== job) return; // replaced meanwhile: the next order drives on
    this.end(job, true, "Im Ziel angehalten", true);
    try { this.deps.arrived?.(job.order); } catch (e) { console.error("Fahrautomat:", (e as Error).message); }
  }

  private command(job: Job, speed: number) {
    job.commandedAt = this.now();
    try { this.deps.drive(job.order.address, speed, job.order.forward); } catch { /* getrennt: der nächste onState beendet den Auftrag */ }
  }

  private end(job: Job, ok: boolean, text: string, halt: boolean) {
    if (this.jobs.get(job.order.trainId) !== job) return;
    clearTimeout(job.timer);
    this.jobs.delete(job.order.trainId);
    if (halt) this.command(job, 0);
    this.results.set(job.order.trainId, { trainId: job.order.trainId, routeId: job.order.routeId, ok, text, ts: this.now() });
    this.deps.log?.(job.order, text, ok);
    this.deps.changed?.();
  }

  /** Ohne Halt und ohne Ergebnis entfernen (wird ersetzt). */
  private drop(trainId: string) {
    const job = this.jobs.get(trainId);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(trainId);
  }
}
