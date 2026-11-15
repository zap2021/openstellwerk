import type { FastifyInstance } from "fastify";
import type { LocoInfo } from "@openstellwerk/protocol";
import { JsonFile } from "./json-file.js";

/* Automatismen je Lok (Auslöser → Bedingung → Aktion). Auswertung ist rein; Zeitsteuerung steckt im AutomationEngine. */

export type Trigger =
  | { type: "start" }          // Lok fährt an (0 → >0)
  | { type: "stop" }           // Lok hält an (>0 → 0)
  | { type: "accelerate" }     // Geschwindigkeit steigt (Lok fährt bereits)
  | { type: "brake" }          // Geschwindigkeit sinkt (Lok fährt weiter)
  | { type: "direction" }      // Richtungswechsel
  | { type: "estop" }          // Lok-Nothalt
  | { type: "function"; fn: number; on: boolean };

export type Condition =
  | { type: "direction"; forward: boolean }
  | { type: "moving"; moving: boolean }
  | { type: "function"; fn: number; on: boolean };

export interface Action {
  type: "function";
  fn: number;
  do: "on" | "off" | "toggle";
  /** Verzögerung vor der Aktion in ms */
  delayMs?: number;
  /** Nur bei „on“: nach dieser Zeit wieder ausschalten */
  forMs?: number;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
}

const MAX_FN = 28;
const MAX_PER_LOCO = 30;
const MAX_ACTIONS = 10;
const MAX_CONDITIONS = 10;
const MAX_MS = 60_000;

const fail = (m: string): never => { throw Object.assign(new Error(m), { statusCode: 400 }); };
const fnNo = (v: unknown, what: string) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_FN ? (v as number) : fail(`${what}: Funktion muss 0..${MAX_FN} sein`));
const ms = (v: unknown, what: string) => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > MAX_MS) fail(`${what} muss 0..${MAX_MS} ms sein`);
  return v as number;
};
const obj = (v: unknown, what: string) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${what} ungültig`));

export function validateAutomations(raw: unknown): Automation[] {
  if (!Array.isArray(raw)) fail("Automatismen müssen eine Liste sein");
  const list = raw as unknown[];
  if (list.length > MAX_PER_LOCO) fail(`Höchstens ${MAX_PER_LOCO} Automatismen je Lok`);
  const ids = new Set<string>();
  return list.map((r, i) => {
    const a = obj(r, `Automatismus ${i + 1}`);
    const id = typeof a.id === "string" && a.id.trim() ? a.id.trim().slice(0, 40) : fail(`Automatismus ${i + 1}: id fehlt`);
    if (ids.has(id)) fail(`Automatismus-id ${id} doppelt`);
    ids.add(id);
    const name = (typeof a.name === "string" ? a.name.trim().slice(0, 60) : "") || `Automatismus ${i + 1}`;
    const t = obj(a.trigger, `${name}: Auslöser`);
    let trigger: Trigger;
    switch (t.type) {
      case "start": case "stop": case "accelerate": case "brake": case "direction": case "estop": trigger = { type: t.type }; break;
      case "function": trigger = { type: "function", fn: fnNo(t.fn, `${name}: Auslöser`), on: t.on === true }; break;
      default: return fail(`${name}: unbekannter Auslöser`);
    }
    const conds = a.conditions === undefined ? [] : Array.isArray(a.conditions) ? a.conditions : fail(`${name}: Bedingungen ungültig`);
    if (conds.length > MAX_CONDITIONS) fail(`${name}: zu viele Bedingungen`);
    const conditions = conds.map((c): Condition => {
      const o = obj(c, `${name}: Bedingung`);
      if (o.type === "direction") return { type: "direction", forward: o.forward === true };
      if (o.type === "moving") return { type: "moving", moving: o.moving === true };
      if (o.type === "function") return { type: "function", fn: fnNo(o.fn, `${name}: Bedingung`), on: o.on === true };
      return fail(`${name}: unbekannte Bedingung`);
    });
    const acts = Array.isArray(a.actions) ? a.actions : fail(`${name}: Aktionen fehlen`);
    if (acts.length === 0) fail(`${name}: mindestens eine Aktion nötig`);
    if (acts.length > MAX_ACTIONS) fail(`${name}: zu viele Aktionen`);
    const actions = acts.map((x): Action => {
      const o = obj(x, `${name}: Aktion`);
      if (o.type !== "function") return fail(`${name}: unbekannte Aktion`);
      if (o.do !== "on" && o.do !== "off" && o.do !== "toggle") fail(`${name}: Aktion „on“, „off“ oder „toggle“`);
      const action: Action = { type: "function", fn: fnNo(o.fn, `${name}: Aktion`), do: o.do as Action["do"] };
      const delayMs = ms(o.delayMs, `${name}: Verzögerung`);
      const forMs = ms(o.forMs, `${name}: Dauer`);
      if (delayMs) action.delayMs = delayMs;
      if (forMs) {
        if (action.do !== "on") fail(`${name}: Dauer gibt es nur bei „einschalten“`);
        action.forMs = forMs;
      }
      return action;
    });
    return { id, name, enabled: a.enabled !== false, trigger, conditions, actions };
  });
}

/** Ereignisse, die der Wechsel von `prev` nach `next` bedeutet. Ohne vorherigen Zustand gibt es keine (kein Auslösen beim ersten Lesen). */
export type LocoEvent = Trigger;
export function detectEvents(prev: LocoInfo | undefined, next: LocoInfo): LocoEvent[] {
  if (!prev) return [];
  const ev: LocoEvent[] = [];
  if (!prev.emergencyStop && next.emergencyStop) ev.push({ type: "estop" });
  if (prev.speed === 0 && next.speed > 0) ev.push({ type: "start" });
  else if (prev.speed > 0 && next.speed === 0) ev.push({ type: "stop" });
  else if (next.speed > prev.speed) ev.push({ type: "accelerate" });
  else if (next.speed > 0 && next.speed < prev.speed) ev.push({ type: "brake" });
  if (prev.forward !== next.forward) ev.push({ type: "direction" });
  const n = Math.max(prev.functions.length, next.functions.length);
  for (let fn = 0; fn < n; fn++) {
    const was = !!prev.functions[fn], is = !!next.functions[fn];
    if (was !== is) ev.push({ type: "function", fn, on: is });
  }
  return ev;
}

const matches = (t: Trigger, e: LocoEvent) => t.type === e.type && (t.type !== "function" || (e.type === "function" && t.fn === e.fn && t.on === e.on));

const holds = (c: Condition, s: LocoInfo) =>
  c.type === "direction" ? s.forward === c.forward : c.type === "moving" ? (s.speed > 0) === c.moving : !!s.functions[c.fn] === c.on;

/** Automatismen, die auf diese Ereignisse ansprechen und deren Bedingungen im neuen Zustand gelten. */
export function triggered(list: Automation[], events: LocoEvent[], state: LocoInfo): Automation[] {
  return list.filter((a) => a.enabled && events.some((e) => matches(a.trigger, e)) && a.conditions.every((c) => holds(c, state)));
}

/** Persistente Automatismen je Lokadresse. Ohne Datei nur im Speicher (Tests). */
export class AutomationStore {
  private map = new Map<number, Automation[]>();
  private store: JsonFile<Record<string, Automation[]>>;

  constructor(file?: string) {
    this.store = new JsonFile(file);
    const raw = this.store.read();
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const addr = Number(k);
        try { if (Number.isInteger(addr)) this.map.set(addr, validateAutomations(v)); } catch (e) { console.error(`automations.json: Lok ${k} verworfen:`, (e as Error).message); }
      }
    }
  }

  get(addr: number): Automation[] { return this.map.get(addr) ?? []; }

  /** Alle Automatismen je Lokadresse (Datensicherung). */
  all(): Record<string, Automation[]> { return Object.fromEntries([...this.map].map(([a, l]) => [String(a), l])); }

  /** Prüft eine Sicherung vollständig; wirft bei Fehlern, ohne etwas zu ändern. */
  static parseAll(raw: unknown): Map<number, Automation[]> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Automatismen: ungültiger Aufbau");
    const out = new Map<number, Automation[]>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const addr = Number(k);
      if (!Number.isInteger(addr) || addr < 1 || addr > 9999) fail(`Automatismen: Lokadresse ${k} ungültig`);
      const list = validateAutomations(v);
      if (list.length) out.set(addr, list);
    }
    return out;
  }

  replaceAll(map: Map<number, Automation[]>) {
    this.map = new Map(map);
    this.persist();
  }

  private persist() { this.store.write(() => this.all()); }

  set(addr: number, raw: unknown): Automation[] {
    const list = validateAutomations(raw);
    if (list.length) this.map.set(addr, list); else this.map.delete(addr);
    this.persist();
    return list;
  }
}

/** Zeitliche Ausführung: Verzögerung, Dauer, Mindestabstand und Schutz vor Rückkopplung. */
export class AutomationEngine {
  private last = new Map<string, number>();
  private touched = new Map<string, number>();
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    private store: AutomationStore,
    private setFunction: (addr: number, fn: number, action: "on" | "off" | "toggle") => void,
    private now: () => number = Date.now,
    /** Ereignisse auf Funktionen, die eine Aktion eben selbst geschaltet hat, lösen nichts aus (ms) */
    private guardMs = 1500,
    /** Mindestabstand je Automatismus (ms); beschleunigen/bremsen feuern sonst bei jedem Schritt */
    private cooldown: (t: Trigger) => number = (t) => (t.type === "accelerate" || t.type === "brake" ? 3000 : 500),
  ) {}

  /** Mit dem Zustand vor und nach einer Änderung aufrufen. */
  onLoco(prev: LocoInfo | undefined, next: LocoInfo) {
    const list = this.store.get(next.address);
    if (list.length === 0) return;
    const t = this.now();
    const events = detectEvents(prev, next).filter((e) => e.type !== "function" || (this.touched.get(`${next.address}:${e.fn}`) ?? 0) + this.guardMs <= t);
    for (const a of triggered(list, events, next)) {
      const key = `${next.address}:${a.id}`;
      if (t - (this.last.get(key) ?? -Infinity) < this.cooldown(a.trigger)) continue;
      this.last.set(key, t);
      for (const act of a.actions) this.run(next.address, act);
    }
  }

  private run(addr: number, act: Action) {
    const fire = () => {
      this.touched.set(`${addr}:${act.fn}`, this.now());
      try { this.setFunction(addr, act.fn, act.do); } catch { /* getrennt: Aktion verfällt */ }
      if (act.forMs) this.later(act.forMs, () => {
        this.touched.set(`${addr}:${act.fn}`, this.now());
        try { this.setFunction(addr, act.fn, "off"); } catch { /* getrennt */ }
      });
    };
    if (act.delayMs) this.later(act.delayMs, fire); else fire();
  }

  private later(delay: number, f: () => void) {
    const h = setTimeout(() => { this.timers.delete(h); f(); }, delay);
    h.unref?.();
    this.timers.add(h);
  }

  /** Offene Verzögerungen verwerfen (Trennen, Beenden). */
  cancelPending() { for (const h of this.timers) clearTimeout(h); this.timers.clear(); }
}

export function registerAutomationRoutes(app: FastifyInstance, store: AutomationStore) {
  const addrOf = (v: string) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : fail("Lokadresse muss 1..9999 sein");
  };
  app.get<{ Params: { addr: string } }>("/api/locos/:addr/automations", async (req) => store.get(addrOf(req.params.addr)));
  app.put<{ Params: { addr: string }; Body: unknown }>("/api/locos/:addr/automations", async (req) => store.set(addrOf(req.params.addr), req.body));
}
