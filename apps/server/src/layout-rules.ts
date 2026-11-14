import type { FastifyInstance } from "fastify";
import { blockOccupied, stateCount, stateName, tileState, type Layout, type LayoutLiveState } from "@z21/protocol";
import { JsonFile } from "./json-file.js";

/*
 * Anlagen-Regeln: ein Rückmelder (Block wird belegt/frei) löst Aktionen aus (Auslöser → Bedingungen → Aktionen).
 * Die Auswertung ist rein; Zeitsteuerung und Ausführung stecken in der LayoutRuleEngine. Stellbefehle gehen über die
 * Sicherung (SignalBox), eine Regel kann sie nicht umgehen.
 */

export type RuleTrigger =
  | { type: "block"; blockId: string; occupied: boolean; /** Zustand muss so lange anhalten (ms) */ holdMs?: number }
  /** Taster: die Regel läuft, wenn jemand sie in der Bedienung anstößt (Ablauf/Makro) */
  | { type: "manual" };

export type RuleCondition =
  | { type: "block"; blockId: string; occupied: boolean }
  | { type: "tile"; tileId: string; state: number }
  | { type: "route"; routeId: string; active: boolean };

export type RuleAction = (
  | { type: "tile"; tileId: string; state: number }
  | { type: "route"; routeId: string; do: "request" | "release" }
  | { type: "stopLoco" }
) & { /** Verzögerung vor der Aktion in ms */ delayMs?: number };

export interface LayoutRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface RuleResult { text: string; ok: boolean }
export interface RuleStatus { ts: number; results: RuleResult[] }
export interface RuleView extends LayoutRule { /** fehlende Verweise; nicht leer = Regel läuft nicht */ broken: string[]; last?: RuleStatus }

const MAX_RULES = 100;
const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 10;
const MAX_MS = 60_000;

const fail = (m: string): never => { throw Object.assign(new Error(m), { statusCode: 400 }); };
const obj = (v: unknown, what: string) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${what} ungültig`));
const ref = (v: unknown, what: string) => (typeof v === "string" && v.length > 0 && v.length <= 80 ? v : fail(`${what} fehlt`));
const ms = (v: unknown, what: string) => {
  if (v === undefined || v === null || v === 0) return undefined;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > MAX_MS) fail(`${what} muss 0..${MAX_MS} ms sein`);
  return v as number;
};
const stateNo = (v: unknown, what: string) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 31 ? (v as number) : fail(`${what}: Lage ungültig`));

export function validateRules(raw: unknown): LayoutRule[] {
  if (!Array.isArray(raw)) fail("Regeln müssen eine Liste sein");
  const list = raw as unknown[];
  if (list.length > MAX_RULES) fail(`Höchstens ${MAX_RULES} Regeln`);
  const ids = new Set<string>();
  return list.map((r, i) => {
    const a = obj(r, `Regel ${i + 1}`);
    const id = typeof a.id === "string" && a.id.trim() ? a.id.trim().slice(0, 40) : fail(`Regel ${i + 1}: id fehlt`);
    if (ids.has(id)) fail(`Regel-id ${id} doppelt`);
    ids.add(id);
    const name = (typeof a.name === "string" ? a.name.trim().slice(0, 60) : "") || `Regel ${i + 1}`;

    const t = obj(a.trigger, `${name}: Auslöser`);
    let trigger: RuleTrigger;
    if (t.type === "manual") trigger = { type: "manual" };
    else if (t.type === "block") {
      trigger = { type: "block", blockId: ref(t.blockId, `${name}: Block des Auslösers`), occupied: t.occupied === true };
      const holdMs = ms(t.holdMs, `${name}: Haltezeit`);
      if (holdMs) trigger.holdMs = holdMs;
    } else return fail(`${name}: unbekannter Auslöser`);

    const conds = a.conditions === undefined ? [] : Array.isArray(a.conditions) ? a.conditions : fail(`${name}: Bedingungen ungültig`);
    if (conds.length > MAX_CONDITIONS) fail(`${name}: zu viele Bedingungen`);
    const conditions = conds.map((c): RuleCondition => {
      const o = obj(c, `${name}: Bedingung`);
      if (o.type === "block") return { type: "block", blockId: ref(o.blockId, `${name}: Block der Bedingung`), occupied: o.occupied === true };
      if (o.type === "tile") return { type: "tile", tileId: ref(o.tileId, `${name}: Feld der Bedingung`), state: stateNo(o.state, `${name}: Bedingung`) };
      if (o.type === "route") return { type: "route", routeId: ref(o.routeId, `${name}: Fahrstraße der Bedingung`), active: o.active === true };
      return fail(`${name}: unbekannte Bedingung`);
    });

    const acts = Array.isArray(a.actions) ? a.actions : fail(`${name}: Aktionen fehlen`);
    if (acts.length === 0) fail(`${name}: mindestens eine Aktion nötig`);
    if (acts.length > MAX_ACTIONS) fail(`${name}: zu viele Aktionen`);
    const actions = acts.map((x): RuleAction => {
      const o = obj(x, `${name}: Aktion`);
      let action: RuleAction;
      if (o.type === "tile") action = { type: "tile", tileId: ref(o.tileId, `${name}: Feld der Aktion`), state: stateNo(o.state, `${name}: Aktion`) };
      else if (o.type === "route") {
        if (o.do !== "request" && o.do !== "release") fail(`${name}: Fahrstraße „request“ oder „release“`);
        action = { type: "route", routeId: ref(o.routeId, `${name}: Fahrstraße der Aktion`), do: o.do as "request" | "release" };
      } else if (o.type === "stopLoco") action = { type: "stopLoco" };
      else return fail(`${name}: unbekannte Aktion`);
      const delayMs = ms(o.delayMs, `${name}: Verzögerung`);
      if (delayMs) action.delayMs = delayMs;
      return action;
    });
    if (trigger.type === "manual" && actions.some((x) => x.type === "stopLoco")) fail(`${name}: „Lok im Block anhalten“ braucht einen Block als Auslöser`);
    return { id, name, enabled: a.enabled !== false, trigger, conditions, actions };
  });
}

/** Verweise der Regel, die es im Gleisbild nicht gibt (als Text für die Oberfläche). Leer = Regel ist ausführbar. */
export function missingRefs(rule: LayoutRule, layout: Layout): string[] {
  const out = new Set<string>();
  const blocks = new Set((layout.blocks ?? []).map((b) => b.id));
  const routes = new Set(layout.routes.map((r) => r.id));
  const tiles = new Map(layout.tiles.map((t) => [t.id, t]));
  const block = (id: string) => { if (!blocks.has(id)) out.add("Block fehlt im Gleisbild"); };
  const route = (id: string) => { if (!routes.has(id)) out.add("Fahrstraße fehlt im Gleisbild"); };
  const tile = (id: string, state: number) => {
    const t = tiles.get(id);
    if (!t) out.add("Weiche/Signal fehlt im Gleisbild");
    else if (state >= stateCount(t)) out.add("Lage gibt es bei diesem Feld nicht");
  };
  if (rule.trigger.type === "block") block(rule.trigger.blockId);
  for (const c of rule.conditions) { if (c.type === "block") block(c.blockId); else if (c.type === "tile") tile(c.tileId, c.state); else route(c.routeId); }
  for (const a of rule.actions) { if (a.type === "tile") tile(a.tileId, a.state); else if (a.type === "route") route(a.routeId); }
  return [...out];
}

/** Belegung aller Blöcke: true/false, undefined = unbekannt (kein Melder, Melder ohne Meldung). */
export function blockStates(layout: Layout, live: LayoutLiveState): Map<string, boolean | undefined> {
  return new Map((layout.blocks ?? []).map((b) => [b.id, blockOccupied(layout, b, live)]));
}

/** Gelten alle Bedingungen? Unbekannte Zustände erfüllen keine Bedingung. */
export function conditionsHold(rule: LayoutRule, layout: Layout, live: LayoutLiveState, activeRoutes: ReadonlySet<string>): boolean {
  const blocks = blockStates(layout, live);
  return rule.conditions.every((c) => {
    if (c.type === "block") return blocks.get(c.blockId) === c.occupied;
    if (c.type === "route") return activeRoutes.has(c.routeId) === c.active;
    const t = layout.tiles.find((x) => x.id === c.tileId);
    return !!t && tileState(t, live) === c.state;
  });
}

/** Lokadressen, die in einem Block stehen: von Meldern mit Lokerkennung gemeldet oder als Standort eines Zuges geführt. */
export function locosInBlock(
  layout: Layout,
  live: { loconetDetectors: { feedbackAddress: number; occupied: boolean; locoAddress?: number }[]; canDetectors: { nid: number; ports: { port: number; occupied: boolean; locos?: { address: number }[] }[] }[] },
  trains: { address: number; location?: { blockId: string } }[],
  blockId: string,
): number[] {
  const block = (layout.blocks ?? []).find((b) => b.id === blockId);
  if (!block) return [];
  const out = new Set<number>();
  for (const tid of block.tileIds) {
    const f = layout.tiles.find((t) => t.id === tid)?.feedback;
    if (f?.bus === "loconet") {
      const d = live.loconetDetectors.find((x) => x.feedbackAddress === f.feedbackAddress);
      if (d?.occupied && d.locoAddress) out.add(d.locoAddress);
    } else if (f?.bus === "can") {
      const p = live.canDetectors.find((x) => x.nid === f.nid)?.ports.find((x) => x.port === f.port);
      if (p?.occupied) for (const l of p.locos ?? []) if (l.address) out.add(l.address);
    }
  }
  for (const t of trains) if (t.location?.blockId === blockId) out.add(t.address);
  return [...out].sort((a, b) => a - b);
}

/** Persistente Regeln der Anlage. Ohne Datei nur im Speicher (Tests). */
export class LayoutRuleStore {
  private rules: LayoutRule[] = [];
  private store: JsonFile<LayoutRule[]>;

  constructor(file?: string, private onChange: () => void = () => {}) {
    this.store = new JsonFile(file);
    const raw = this.store.read();
    if (raw !== undefined) {
      try { this.rules = validateRules(raw); } catch (e) { console.error("layout-rules.json ignoriert:", (e as Error).message); }
    }
  }

  list(): LayoutRule[] { return this.rules; }

  set(raw: unknown): LayoutRule[] { return this.replaceAll(validateRules(raw)); }

  replaceAll(rules: LayoutRule[]): LayoutRule[] {
    this.rules = rules;
    this.store.write(() => this.rules);
    this.onChange();
    return this.rules;
  }
}

/** Was die Regeln an der Anlage tun dürfen; in main.ts mit SignalBox und Station verdrahtet. */
export interface RuleActions {
  /** Feld stellen; lehnt ab (Promise schlägt fehl), wenn es verriegelt oder nicht verknüpft ist */
  setTile(tileId: string, state: number): Promise<unknown>;
  requestRoute(routeId: string): { ok: true } | { ok: false; reason: string };
  /** wirft, wenn das Auflösen nicht möglich ist */
  releaseRoute(routeId: string): void;
  activeRoutes(): string[];
  locosIn(blockId: string): number[];
  stopLoco(address: number): void;
}

type Live = LayoutLiveState & { connected: boolean };

/** Erkennt Blockwechsel und führt die passenden Regeln aus: Entprellung, Mindestabstand, Verzögerung, Ergebnis je Regel. */
export class LayoutRuleEngine {
  private known = new Map<string, boolean>();
  private gen = new Map<string, number>();
  private lastFired = new Map<string, number>();
  private status = new Map<string, RuleStatus>();
  private timers = new Set<NodeJS.Timeout>();
  private live?: Live;

  constructor(
    private store: LayoutRuleStore,
    private layout: () => Layout,
    private act: RuleActions,
    private now: () => number = Date.now,
    /** Mindestabstand je Regel (ms) */
    private cooldownMs = 2000,
    /** nach jedem neuen Ergebnis (Oberfläche auffrischen) */
    private changed: () => void = () => {},
    /** jedes Ergebnis einer Aktion, für den Verlauf */
    private log: (rule: LayoutRule, text: string, ok: boolean) => void = () => {},
  ) {}

  /** Bei jeder Zustandsänderung der Zentrale aufrufen. */
  onState(live: Live) {
    if (!live.connected) { this.reset(); return; }
    this.live = live;
    const layout = this.layout();
    const changes: [string, boolean][] = [];
    for (const [id, v] of blockStates(layout, live)) {
      if (v === undefined) continue; // unbekannt ist weder belegt noch frei
      const was = this.known.get(id);
      this.known.set(id, v);
      if (was === undefined || was === v) continue; // erstes Lesen löst nichts aus
      this.gen.set(id, (this.gen.get(id) ?? 0) + 1);
      changes.push([id, v]);
    }
    for (const [blockId, occupied] of changes) {
      for (const rule of this.store.list()) {
        const tr = rule.trigger;
        if (!rule.enabled || tr.type !== "block" || tr.blockId !== blockId || tr.occupied !== occupied) continue;
        if (missingRefs(rule, layout).length) continue;
        const g = this.gen.get(blockId);
        if (tr.holdMs) this.later(tr.holdMs, () => { if (this.known.get(blockId) === occupied && this.gen.get(blockId) === g) this.fire(rule.id); });
        else this.fire(rule.id);
      }
    }
  }

  /** Taster: eine Regel mit Auslöser „manual“ von Hand anstoßen. Wirft mit einer klaren Meldung, wenn das nicht geht. */
  runManual(ruleId: string): RuleStatus {
    const rule = this.store.list().find((r) => r.id === ruleId);
    if (!rule || rule.trigger.type !== "manual") throw Object.assign(new Error("Ablauf nicht gefunden"), { statusCode: 404 });
    const refuse = (m: string): never => { throw Object.assign(new Error(m), { statusCode: 409 }); };
    if (!rule.enabled) refuse("Der Ablauf ist ausgeschaltet");
    if (!this.live) refuse("Keine Verbindung zur Zentrale");
    const broken = missingRefs(rule, this.layout());
    if (broken.length) refuse(`Der Ablauf läuft nicht: ${broken.join("; ")}`);
    if (this.now() - (this.lastFired.get(rule.id) ?? -Infinity) < this.cooldownMs) refuse("Der Ablauf wurde gerade erst ausgelöst");
    this.fire(rule.id);
    return this.status.get(rule.id)!;
  }

  /** Abläufe für die Bedienung: eingeschaltete Regeln mit Taster, die ausführbar sind. */
  macros(): { id: string; name: string }[] {
    const layout = this.layout();
    return this.store.list().filter((r) => r.enabled && r.trigger.type === "manual" && !missingRefs(r, layout).length).map((r) => ({ id: r.id, name: r.name }));
  }

  private fire(ruleId: string) {
    const rule = this.store.list().find((r) => r.id === ruleId);
    const live = this.live;
    if (!rule?.enabled || !live) return;
    const layout = this.layout();
    if (missingRefs(rule, layout).length) return;
    const t = this.now();
    if (t - (this.lastFired.get(rule.id) ?? -Infinity) < this.cooldownMs) return;
    if (!conditionsHold(rule, layout, live, new Set(this.act.activeRoutes()))) {
      this.status.set(rule.id, { ts: t, results: [{ text: "Bedingungen nicht erfüllt", ok: false }] });
      this.changed();
      return;
    }
    this.lastFired.set(rule.id, t);
    const status: RuleStatus = { ts: t, results: [] };
    this.status.set(rule.id, status);
    const report = (text: string, ok: boolean) => { status.results.push({ text, ok }); this.log(rule, text, ok); this.changed(); };
    for (const a of rule.actions) {
      const run = () => { void this.run(rule, a, report); };
      if (a.delayMs) this.later(a.delayMs, run); else run();
    }
    this.changed();
  }

  private async run(rule: LayoutRule, a: RuleAction, report: (text: string, ok: boolean) => void) {
    const layout = this.layout();
    try {
      if (a.type === "tile") {
        const tile = layout.tiles.find((t) => t.id === a.tileId);
        const what = `${tile?.label || (tile?.kind === "signal" ? "Signal" : "Weiche")} → ${tile ? stateName(tile, a.state) : "?"}`;
        await this.act.setTile(a.tileId, a.state);
        report(what, true);
      } else if (a.type === "route") {
        const name = `Fahrstraße „${layout.routes.find((r) => r.id === a.routeId)?.name ?? a.routeId}“`;
        if (a.do === "request") {
          const r = this.act.requestRoute(a.routeId);
          report(r.ok ? `${name} angefordert` : `${name} abgelehnt: ${r.reason}`, r.ok);
        } else {
          this.act.releaseRoute(a.routeId);
          report(`${name} aufgelöst`, true);
        }
      } else {
        const locos = rule.trigger.type === "block" ? this.act.locosIn(rule.trigger.blockId) : [];
        if (!locos.length) { report("Keine Lok im Block erkannt", false); return; }
        for (const addr of locos) this.act.stopLoco(addr);
        report(`Lok ${locos.join(", ")} angehalten`, true);
      }
    } catch (e) {
      report((e as Error).message, false);
    }
  }

  private later(delay: number, f: () => void) {
    const h = setTimeout(() => { this.timers.delete(h); f(); }, delay);
    h.unref?.();
    this.timers.add(h);
  }

  /** Offene Haltezeiten und Verzögerungen verwerfen (Regeln geändert). */
  cancelPending() { for (const h of this.timers) clearTimeout(h); this.timers.clear(); }

  /** Getrennt: nichts merken, damit das erste Lesen nach dem Verbinden nichts auslöst. */
  private reset() {
    if (!this.live && !this.known.size) return;
    this.cancelPending();
    this.known.clear();
    this.gen.clear();
    this.live = undefined;
  }

  view(): RuleView[] {
    const layout = this.layout();
    return this.store.list().map((r) => ({ ...r, broken: missingRefs(r, layout), last: this.status.get(r.id) }));
  }
}

export function registerLayoutRuleRoutes(app: FastifyInstance, store: LayoutRuleStore, engine: LayoutRuleEngine) {
  app.get("/api/layout-rules", async () => engine.view());
  app.put<{ Body: unknown }>("/api/layout-rules", async (req) => { store.set(req.body); return engine.view(); });
  // Taster in der Bedienung: auch für Benutzer ohne Admin-Rolle (roles.ts)
  app.post<{ Params: { id: string } }>("/api/layout-rules/:id/run", async (req) => engine.runManual(req.params.id));
}
