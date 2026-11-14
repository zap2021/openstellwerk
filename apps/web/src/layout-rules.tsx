import { useEffect, useState } from "react";
import { isSwitchable, stateCount, stateName, type Layout, type Tile } from "@z21/protocol/layout";
import { api } from "./api";
import { toMs } from "./automations";

type Run = (p: Promise<unknown>) => Promise<void>;

/** Spiegel der Server-Typen (apps/server/src/layout-rules.ts). */
export type RuleTrigger = { type: "block"; blockId: string; occupied: boolean; holdMs?: number } | { type: "manual" };
export type RuleCondition =
  | { type: "block"; blockId: string; occupied: boolean }
  | { type: "tile"; tileId: string; state: number }
  | { type: "route"; routeId: string; active: boolean };
export type RuleAction = (
  | { type: "tile"; tileId: string; state: number }
  | { type: "route"; routeId: string; do: "request" | "release" }
  | { type: "stopLoco" }
) & { delayMs?: number };
export interface LayoutRule { id: string; name: string; enabled: boolean; trigger: RuleTrigger; conditions: RuleCondition[]; actions: RuleAction[] }
export interface RuleView extends LayoutRule { broken: string[]; last?: { ts: number; results: { text: string; ok: boolean }[] } }

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const toSec = (ms?: number) => (ms ? String(ms / 1000) : "");

/** Name eines schaltbaren Felds für die Auswahl: Bezeichnung, sonst Art und Adresse. */
export const tileName = (t: Tile) => t.label || `${t.kind === "signal" ? "Signal" : "Weiche"}${t.address !== undefined ? ` ${t.address}` : ""} (${t.x + 1}/${t.y + 1})`;

interface Choices { blocks: { id: string; name: string }[]; tiles: Tile[]; routes: { id: string; name: string }[] }

/** Die erste Regel, die sich mit diesem Gleisbild anlegen lässt; undefined, solange es nichts zu schalten gibt. */
export function blankRule(c: Choices): LayoutRule | undefined {
  const block = c.blocks[0];
  const action: RuleAction | undefined = c.tiles[0] ? { type: "tile", tileId: c.tiles[0].id, state: 0 } : c.routes[0] ? { type: "route", routeId: c.routes[0].id, do: "request" } : block ? { type: "stopLoco" } : undefined;
  if (!action) return undefined;
  // Without a block only a button can trigger the rule.
  return { id: newId(), name: "", enabled: true, trigger: block ? { type: "block", blockId: block.id, occupied: true } : { type: "manual" }, conditions: [], actions: [action] };
}

function Pick({ value, options, onChange }: { value: string; options: { id: string; name: string }[]; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {!options.some((o) => o.id === value) && <option value={value}>(fehlt)</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

function TileState({ tiles, tileId, state, onChange }: { tiles: Tile[]; tileId: string; state: number; onChange: (tileId: string, state: number) => void }) {
  const tile = tiles.find((t) => t.id === tileId);
  return (<>
    <Pick value={tileId} options={tiles.map((t) => ({ id: t.id, name: tileName(t) }))} onChange={(id) => onChange(id, 0)} />
    <select value={state} onChange={(e) => onChange(tileId, Number(e.target.value))}>
      {tile ? Array.from({ length: stateCount(tile) }, (_, s) => <option key={s} value={s}>{stateName(tile, s)}</option>) : <option value={state}>?</option>}
    </select>
  </>);
}

const OCC = (v: boolean, onChange: (v: boolean) => void, yes: string, no: string) => (
  <select value={v ? "1" : "0"} onChange={(e) => onChange(e.target.value === "1")}><option value="1">{yes}</option><option value="0">{no}</option></select>
);

function Editor({ r, view, c, onChange, onRemove }: { r: LayoutRule; view?: RuleView; c: Choices; onChange: (r: LayoutRule) => void; onRemove: () => void }) {
  const setCond = (i: number, x: RuleCondition) => onChange({ ...r, conditions: r.conditions.map((y, j) => (j === i ? x : y)) });
  const setAct = (i: number, x: RuleAction) => onChange({ ...r, actions: r.actions.map((y, j) => (j === i ? x : y)) });
  const newCond = (type: string): RuleCondition =>
    type === "tile" && c.tiles[0] ? { type: "tile", tileId: c.tiles[0].id, state: 0 }
    : type === "route" && c.routes[0] ? { type: "route", routeId: c.routes[0].id, active: true }
    : { type: "block", blockId: c.blocks[0]!.id, occupied: false };
  const newAct = (type: string, delayMs?: number): RuleAction => ({
    ...(type === "tile" && c.tiles[0] ? { type: "tile", tileId: c.tiles[0].id, state: 0 }
      : type === "request" && c.routes[0] ? { type: "route", routeId: c.routes[0].id, do: "request" }
      : type === "release" && c.routes[0] ? { type: "route", routeId: c.routes[0].id, do: "release" }
      : { type: "stopLoco" }),
    ...(delayMs ? { delayMs } : {}),
  } as RuleAction);
  const actKind = (a: RuleAction) => (a.type === "route" ? a.do : a.type);
  return (
    <div className="automation">
      <div className="row tight">
        <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => onChange({ ...r, enabled: e.target.checked })} /> aktiv</label>
        <input placeholder="Name" maxLength={60} value={r.name} onChange={(e) => onChange({ ...r, name: e.target.value })} />
        <button type="button" className="x" title="Regel entfernen" onClick={onRemove}>×</button>
      </div>
      <div className="row tight">
        <strong>Wenn</strong>
        <select value={r.trigger.type} onChange={(e) => onChange(e.target.value === "manual"
          ? { ...r, trigger: { type: "manual" }, actions: r.actions.filter((a) => a.type !== "stopLoco").length ? r.actions.filter((a) => a.type !== "stopLoco") : [newAct(c.tiles[0] ? "tile" : "request")] }
          : { ...r, trigger: { type: "block", blockId: c.blocks[0]?.id ?? "", occupied: true } })}>
          <option value="block">ein Block</option>
          <option value="manual">ein Taster gedrückt wird (Ablauf)</option>
        </select>
        {r.trigger.type === "block" && (() => { const tr = r.trigger; return (<>
          <Pick value={tr.blockId} options={c.blocks} onChange={(blockId) => onChange({ ...r, trigger: { ...tr, blockId } })} />
          {OCC(tr.occupied, (occupied) => onChange({ ...r, trigger: { ...tr, occupied } }), "belegt wird", "frei wird")}
          <label>und <input type="number" min={0} step="0.1" value={toSec(tr.holdMs)} placeholder="0" onChange={(e) => onChange({ ...r, trigger: { ...tr, holdMs: toMs(e.target.value) } })} /> s so bleibt</label>
        </>); })()}
        {r.trigger.type === "manual" && <span className="hint">Der Taster erscheint oben in der Bedienung mit dem Namen der Regel.</span>}
      </div>
      {r.conditions.map((x, i) => (
        <div className="row tight" key={i}>
          <strong>{i === 0 ? "und nur wenn" : "und"}</strong>
          <select value={x.type} onChange={(e) => setCond(i, newCond(e.target.value))}>
            <option value="block">Block</option>
            {c.tiles.length > 0 && <option value="tile">Weiche/Signal</option>}
            {c.routes.length > 0 && <option value="route">Fahrstraße</option>}
          </select>
          {x.type === "block" && (<>
            <Pick value={x.blockId} options={c.blocks} onChange={(blockId) => setCond(i, { ...x, blockId })} />
            {OCC(x.occupied, (occupied) => setCond(i, { ...x, occupied }), "ist belegt", "ist frei")}
          </>)}
          {x.type === "tile" && <TileState tiles={c.tiles} tileId={x.tileId} state={x.state} onChange={(tileId, state) => setCond(i, { type: "tile", tileId, state })} />}
          {x.type === "route" && (<>
            <Pick value={x.routeId} options={c.routes} onChange={(routeId) => setCond(i, { ...x, routeId })} />
            {OCC(x.active, (active) => setCond(i, { ...x, active }), "ist angefordert", "ist nicht angefordert")}
          </>)}
          <button type="button" className="x" title="Bedingung entfernen" onClick={() => onChange({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <div className="row tight"><button type="button" onClick={() => onChange({ ...r, conditions: [...r.conditions, newCond("block")] })}>+ Bedingung</button></div>
      {r.actions.map((x, i) => (
        <div className="row tight" key={i}>
          <strong>{i === 0 ? "dann" : "und"}</strong>
          <select value={actKind(x)} onChange={(e) => setAct(i, newAct(e.target.value, x.delayMs))}>
            {c.tiles.length > 0 && <option value="tile">Weiche/Signal stellen</option>}
            {c.routes.length > 0 && <option value="request">Fahrstraße anfordern</option>}
            {c.routes.length > 0 && <option value="release">Fahrstraße auflösen</option>}
            {r.trigger.type === "block" && <option value="stopLoco">Lok im Block anhalten</option>}
          </select>
          {x.type === "tile" && <TileState tiles={c.tiles} tileId={x.tileId} state={x.state} onChange={(tileId, state) => setAct(i, { ...x, tileId, state })} />}
          {x.type === "route" && <Pick value={x.routeId} options={c.routes} onChange={(routeId) => setAct(i, { ...x, routeId })} />}
          <label>nach <input type="number" min={0} step="0.1" value={toSec(x.delayMs)} placeholder="0" onChange={(e) => setAct(i, { ...x, delayMs: toMs(e.target.value) })} /> s</label>
          {r.actions.length > 1 && <button type="button" className="x" title="Aktion entfernen" onClick={() => onChange({ ...r, actions: r.actions.filter((_, j) => j !== i) })}>×</button>}
        </div>
      ))}
      <div className="row tight"><button type="button" onClick={() => onChange({ ...r, actions: [...r.actions, newAct(c.tiles[0] ? "tile" : "stopLoco")] })}>+ Aktion</button></div>
      {view?.broken.length ? <p className="hint warn">Läuft nicht: {view.broken.join("; ")}.</p> : null}
      {view?.last && (
        <p className="hint">
          Zuletzt ausgelöst {new Date(view.last.ts).toLocaleTimeString("de-DE")}:{" "}
          {view.last.results.length ? view.last.results.map((x, i) => <span key={i} className={x.ok ? "" : "rule-failed"}>{i ? "; " : ""}{x.text}</span>) : "läuft …"}
        </p>
      )}
    </div>
  );
}

/** Regeln der Anlage: ein Block wird belegt oder frei → Weichen, Signale, Fahrstraßen stellen oder die Lok anhalten. */
export function LayoutRulesPage({ layout, run }: { layout?: Layout; run: Run }) {
  const [list, setList] = useState<LayoutRule[]>();
  const [views, setViews] = useState<RuleView[]>([]);
  const [dirty, setDirty] = useState(false);
  const load = (replace: boolean) => api<RuleView[]>("GET", "/api/layout-rules").then((v) => { setViews(v); if (replace) { setList(v.map(({ broken: _b, last: _l, ...r }) => r)); setDirty(false); } }, () => { if (replace) setList([]); });
  useEffect(() => { void load(true); }, []);
  // "zuletzt ausgelöst" auffrischen, ohne ungespeicherte Änderungen zu überschreiben
  useEffect(() => { const h = setInterval(() => { void load(false); }, 3000); return () => clearInterval(h); }, []);
  if (!list) return null;

  const c: Choices = {
    blocks: (layout?.blocks ?? []).map((b) => ({ id: b.id, name: b.name })),
    tiles: (layout?.tiles ?? []).filter(isSwitchable),
    routes: (layout?.routes ?? []).map((r) => ({ id: r.id, name: r.name })),
  };
  const change = (next: LayoutRule[]) => { setList(next); setDirty(true); };
  const add = () => { const r = blankRule(c); if (r) change([...list, r]); };
  const save = () => run(api<RuleView[]>("PUT", "/api/layout-rules", list).then((v) => { setViews(v); setList(v.map(({ broken: _b, last: _l, ...r }) => r)); setDirty(false); }));
  return (
    <div className="panel">
      <div className="head">
        <h2>Regeln</h2>
        <button type="button" disabled={c.blocks.length === 0 && c.tiles.length === 0 && c.routes.length === 0} onClick={add}>+ Regel</button>
        <button type="button" className={dirty ? "active" : ""} disabled={!dirty} onClick={save}>Speichern</button>
      </div>
      <p className="hint">
        Ein Rückmelder oder ein Taster löst etwas aus: Wird ein Block belegt oder frei, stellt der Server Weichen, Signale oder Fahrstraßen oder hält die Lok im Block an.
        Alles läuft über die Sicherung; ein verriegeltes Feld wird nicht umgestellt. „Lok anhalten“ braucht einen Melder mit Lokerkennung oder einen Zug mit Standort im Block.
      </p>
      {c.blocks.length === 0 && <p className="hint warn">Im Gleisbild gibt es noch keinen Block: Regeln lassen sich nur per Taster auslösen. Für Rückmelder-Regeln lege unter „Gleisbild bearbeiten“ Blöcke mit Meldern an.</p>}
      {list.length === 0 && c.blocks.length > 0 && <p className="hint">Noch keine Regel. Beispiel: Wenn „Gleis 1“ belegt wird, Einfahrsignal auf Halt.</p>}
      {list.map((r, i) => (
        <Editor key={r.id} r={r} view={dirty ? undefined : views.find((v) => v.id === r.id)} c={c} onChange={(n) => change(list.map((x, j) => (j === i ? n : x)))} onRemove={() => change(list.filter((_, j) => j !== i))} />
      ))}
    </div>
  );
}
