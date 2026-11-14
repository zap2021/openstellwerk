import type { FastifyInstance } from "fastify";
import { blockOccupied, type Layout, type LayoutLiveState } from "@z21/protocol";
import { JsonFile } from "./json-file.js";

/*
 * Einmessen: Geschwindigkeit einer Lok je Fahrstufe über zwei Rückmelder messen. Die Lok fährt mit fester Fahrstufe;
 * gemessen wird die Zeit zwischen "Startblock wird belegt" und "Zielblock wird belegt" über eine bekannte Strecke.
 * Aus den Messpunkten entsteht eine Kennlinie (Fahrstufe → cm/s), umgerechnet in Vorbild-km/h über den Maßstab.
 */

export interface SpeedPoint { step: number; cmPerSec: number }
export interface Calibration { /** Maßstab 1:n, z. B. 87 für H0 */ scale: number; points: SpeedPoint[] }

const fail = (m: string, statusCode = 400): never => { throw Object.assign(new Error(m), { statusCode }); };
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Geschwindigkeit bei einer Fahrstufe (cm/s): linear zwischen den Messpunkten, vom Stillstand aus, über den letzten Punkt hinaus verlängert. */
export function cmPerSec(cal: Calibration | undefined, step: number): number | undefined {
  if (!cal?.points.length) return undefined;
  if (step <= 0) return 0;
  const pts = [{ step: 0, cmPerSec: 0 }, ...cal.points];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (step <= b.step || i === pts.length - 1) return Math.max(0, a.cmPerSec + ((b.cmPerSec - a.cmPerSec) * (step - a.step)) / (b.step - a.step));
  }
  return undefined;
}

/** Vorbildgeschwindigkeit in km/h. */
export function kmh(cal: Calibration | undefined, step: number): number | undefined {
  const v = cmPerSec(cal, step);
  return v === undefined ? undefined : round1(v * cal!.scale * 0.036);
}

export function validateCalibration(raw: unknown, what = "Kennlinie"): Calibration {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : fail(`${what} ungültig`);
  const scale = typeof o.scale === "number" && o.scale >= 1 && o.scale <= 1000 ? o.scale : fail(`${what}: Maßstab muss 1..1000 sein`);
  const list = Array.isArray(o.points) ? o.points : fail(`${what}: Messpunkte fehlen`);
  if (list.length > 126) fail(`${what}: zu viele Messpunkte`);
  const seen = new Set<number>();
  const points = list.map((p): SpeedPoint => {
    const x = p && typeof p === "object" ? (p as Record<string, unknown>) : fail(`${what}: Messpunkt ungültig`);
    const step = Number.isInteger(x.step) && (x.step as number) >= 1 && (x.step as number) <= 126 ? (x.step as number) : fail(`${what}: Fahrstufe muss 1..126 sein`);
    if (seen.has(step)) fail(`${what}: Fahrstufe ${step} doppelt`);
    seen.add(step);
    const v = typeof x.cmPerSec === "number" && x.cmPerSec > 0 && x.cmPerSec <= 1000 ? x.cmPerSec : fail(`${what}: Geschwindigkeit ungültig`);
    return { step, cmPerSec: v };
  }).sort((a, b) => a.step - b.step);
  return { scale, points };
}

/** Kennlinien je Lokadresse. Ohne Datei nur im Speicher (Tests). */
export class CalibrationStore {
  private map = new Map<number, Calibration>();
  private store: JsonFile<Record<string, Calibration>>;

  constructor(file?: string, private onChange: () => void = () => {}) {
    this.store = new JsonFile(file);
    const raw = this.store.read();
    if (raw && typeof raw === "object") {
      try { this.map = CalibrationStore.parseAll(raw); } catch (e) { console.error("calibration.json ignoriert:", (e as Error).message); }
    }
  }

  get(address: number): Calibration | undefined { return this.map.get(address); }
  all(): Record<string, Calibration> { return Object.fromEntries([...this.map].map(([a, c]) => [String(a), c])); }

  static parseAll(raw: unknown): Map<number, Calibration> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Kennlinien: ungültiger Aufbau");
    const out = new Map<number, Calibration>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const addr = Number(k);
      if (!Number.isInteger(addr) || addr < 1 || addr > 9999) fail(`Kennlinien: Lokadresse ${k} ungültig`);
      const cal = validateCalibration(v, `Kennlinie Lok ${k}`);
      if (cal.points.length) out.set(addr, cal);
    }
    return out;
  }

  /** Einen Messpunkt eintragen (ersetzt den Punkt derselben Fahrstufe). */
  setPoint(address: number, scale: number, point: SpeedPoint) {
    const cur = this.map.get(address);
    const points = [...(cur?.points ?? []).filter((p) => p.step !== point.step), { step: point.step, cmPerSec: round1(point.cmPerSec) }].sort((a, b) => a.step - b.step);
    this.map.set(address, { scale, points });
    this.persist();
  }

  remove(address: number): boolean {
    const had = this.map.delete(address);
    if (had) this.persist();
    return had;
  }

  replaceAll(map: Map<number, Calibration>) { this.map = new Map(map); this.persist(); }

  private persist() { this.store.write(() => this.all()); this.onChange(); }
}

export type MeasurePhase = "approach" | "measure" | "settle" | "return" | "runout";

export interface MeasureView {
  address: number;
  steps: number[];
  /** Index der laufenden Fahrstufe */
  index: number;
  phase?: MeasurePhase;
  running: boolean;
  results: SpeedPoint[];
  error?: string;
}

interface Run {
  address: number; startBlockId: string; endBlockId: string; distanceCm: number; steps: number[]; forward: boolean; scale: number; returnStep: number;
  index: number; phase: MeasurePhase; phaseSince: number; t0?: number; results: SpeedPoint[]; timer?: NodeJS.Timeout;
}

export interface MeasureDeps {
  layout(): Layout;
  drive(address: number, speed: number, forward: boolean): void;
  now?(): number;
  changed?(): void;
}

type Live = LayoutLiveState & { connected: boolean };

/**
 * Messreihe: je Fahrstufe eine Messfahrt vom Startblock in den Zielblock, danach fährt die Lok selbst zurück vor die
 * Messstrecke. Jede Phase hat eine Zeitgrenze; bei jedem Fehler hält die Lok an.
 */
export class CalibrationRunner {
  private run?: Run;
  private last?: MeasureView;
  private live?: Live;
  private now: () => number;

  constructor(
    private store: CalibrationStore,
    private deps: MeasureDeps,
    private opts: { phaseLimitMs: number; settleMs: number; runoutMs: number } = { phaseLimitMs: 90_000, settleMs: 2500, runoutMs: 3000 },
  ) { this.now = deps.now ?? Date.now; }

  view(): MeasureView | undefined {
    const r = this.run;
    return r ? { address: r.address, steps: r.steps, index: r.index, phase: r.phase, running: true, results: r.results } : this.last;
  }

  start(input: unknown): MeasureView {
    if (this.run) fail("Es läuft schon eine Messreihe", 409);
    if (!this.live?.connected) fail("Keine Verbindung zur Zentrale", 409);
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const int = (v: unknown, min: number, max: number, what: string) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fail(`${what} muss ${min}..${max} sein`));
    const address = int(o.address, 1, 9999, "Lokadresse");
    const layout = this.deps.layout();
    const block = (id: unknown, what: string) => (layout.blocks ?? []).find((b) => b.id === id)?.id ?? fail(`${what} nicht gefunden`);
    const startBlockId = block(o.startBlockId, "Startblock");
    const endBlockId = block(o.endBlockId, "Zielblock");
    if (startBlockId === endBlockId) fail("Start- und Zielblock müssen verschieden sein");
    const distanceCm = typeof o.distanceCm === "number" && o.distanceCm >= 5 && o.distanceCm <= 5000 ? o.distanceCm : fail("Strecke muss 5..5000 cm sein");
    const steps = Array.isArray(o.steps) && o.steps.length >= 1 && o.steps.length <= 20 ? [...new Set(o.steps.map((s) => int(s, 1, 126, "Fahrstufe")))].sort((a, b) => a - b) : fail("Fahrstufen fehlen (1 bis 20 Werte)");
    const scale = o.scale === undefined ? 87 : typeof o.scale === "number" && o.scale >= 1 && o.scale <= 1000 ? o.scale : fail("Maßstab muss 1..1000 sein");
    const returnStep = o.returnStep === undefined ? 40 : int(o.returnStep, 1, 126, "Fahrstufe der Rückfahrt");
    this.run = { address, startBlockId, endBlockId, distanceCm, steps, forward: o.forward !== false, scale, returnStep, index: 0, phase: "approach", phaseSince: this.now(), results: [] };
    this.last = undefined;
    this.approach();
    return this.view()!;
  }

  /** Messreihe abbrechen; die Lok hält an. */
  stop(text = "Abgebrochen") { if (this.run) this.abort(text); }

  /** Bei jeder Zustandsänderung der Zentrale und mindestens einmal pro Sekunde aufrufen. */
  onState(live: Live) {
    this.live = live;
    const r = this.run;
    if (!r) return;
    if (!live.connected) { this.abort("Verbindung getrennt", false); return; }
    const t = this.now();
    const start = this.occupied(r.startBlockId);
    const end = this.occupied(r.endBlockId);
    if (r.phase === "approach") {
      if (end === true) this.abort("Der Zielblock wurde vor dem Startblock belegt (falsche Richtung oder Lok steht in der Messstrecke)");
      else if (start === true) { r.t0 = t; this.to("measure"); }
    } else if (r.phase === "measure") {
      if (end === true) this.measured(t - r.t0!);
    } else if (r.phase === "return") {
      if (start === false && end === false) {
        this.to("runout");
        r.timer = this.later(this.opts.runoutMs, () => { this.drive(0, !r.forward); this.to("settle"); r.timer = this.later(this.opts.settleMs, () => this.approach()); });
      }
    }
    if (this.run === r && (r.phase === "approach" || r.phase === "measure" || r.phase === "return") && t - r.phaseSince > this.opts.phaseLimitMs) {
      this.abort(r.phase === "return" ? "Die Lok hat die Messstrecke bei der Rückfahrt nicht verlassen" : "Die Lok hat den Melder nicht rechtzeitig erreicht");
    }
  }

  private occupied(blockId: string): boolean | undefined {
    const layout = this.deps.layout();
    const b = (layout.blocks ?? []).find((x) => x.id === blockId);
    return b && this.live ? blockOccupied(layout, b, this.live) : undefined;
  }

  /** Messfahrt beginnen: beide Blöcke müssen frei sein, die Lok steht davor. */
  private approach() {
    const r = this.run;
    if (!r) return;
    r.timer = undefined;
    if (this.occupied(r.startBlockId) !== false || this.occupied(r.endBlockId) !== false) { this.abort("Die Messstrecke ist nicht frei (oder ein Melder meldet nichts)"); return; }
    r.t0 = undefined;
    this.to("approach");
    this.drive(r.steps[r.index]!, r.forward);
  }

  private measured(ms: number) {
    const r = this.run!;
    this.drive(0, r.forward);
    if (ms < 200) { this.abort("Messzeit zu kurz; die Melder liegen zu dicht beieinander oder melden gleichzeitig"); return; }
    const point = { step: r.steps[r.index]!, cmPerSec: round1(r.distanceCm / (ms / 1000)) };
    r.results.push(point);
    this.store.setPoint(r.address, r.scale, point);
    if (r.index + 1 >= r.steps.length) { this.finish(); return; }
    r.index++;
    this.to("settle");
    r.timer = this.later(this.opts.settleMs, () => { this.to("return"); this.drive(r.returnStep, !r.forward); });
  }

  private to(phase: MeasurePhase) {
    const r = this.run;
    if (!r) return;
    r.phase = phase;
    r.phaseSince = this.now();
    this.deps.changed?.();
  }

  private drive(speed: number, forward: boolean) {
    try { this.deps.drive(this.run!.address, speed, forward); } catch { /* getrennt */ }
  }

  private later(ms: number, f: () => void): NodeJS.Timeout {
    const r = this.run;
    const h = setTimeout(() => { if (this.run === r) f(); }, ms);
    h.unref?.();
    return h;
  }

  private finish() {
    const r = this.run!;
    this.last = { address: r.address, steps: r.steps, index: r.index, running: false, results: r.results };
    this.run = undefined;
    this.deps.changed?.();
  }

  private abort(error: string, halt = true) {
    const r = this.run;
    if (!r) return;
    clearTimeout(r.timer);
    if (halt) this.drive(0, r.forward);
    this.last = { address: r.address, steps: r.steps, index: r.index, running: false, results: r.results, error };
    this.run = undefined;
    this.deps.changed?.();
  }
}

export function registerCalibrationRoutes(app: FastifyInstance, store: CalibrationStore, runner: CalibrationRunner) {
  app.get("/api/calibration", async () => ({ tables: store.all(), run: runner.view() }));
  app.post<{ Body: unknown }>("/api/calibration/run", async (req) => runner.start(req.body));
  app.post("/api/calibration/stop", async () => { runner.stop(); return { ok: true }; });
  app.delete<{ Params: { addr: string } }>("/api/calibration/:addr", async (req) => {
    const n = Number(req.params.addr);
    if (!Number.isInteger(n) || n < 1 || n > 9999) fail("Lokadresse muss 1..9999 sein");
    return { removed: store.remove(n) };
  });
}
