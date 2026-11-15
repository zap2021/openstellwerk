import { useEffect, useState } from "react";
import { api } from "./api";

type Run = (p: Promise<unknown>) => Promise<void>;

/** Spiegel der Server-Typen (apps/server/src/automations.ts). */
export type Trigger =
  | { type: "start" | "stop" | "accelerate" | "brake" | "direction" | "estop" }
  | { type: "function"; fn: number; on: boolean };
export type Condition =
  | { type: "direction"; forward: boolean }
  | { type: "moving"; moving: boolean }
  | { type: "function"; fn: number; on: boolean };
export interface Action { type: "function"; fn: number; do: "on" | "off" | "toggle"; delayMs?: number; forMs?: number }
export interface Automation { id: string; name: string; enabled: boolean; trigger: Trigger; conditions: Condition[]; actions: Action[] }

export const TRIGGER_LABELS: Record<Trigger["type"], string> = {
  start: "Lok fährt an",
  stop: "Lok hält an",
  accelerate: "Lok beschleunigt",
  brake: "Lok bremst",
  direction: "Richtung wechselt",
  estop: "Lok-Nothalt",
  function: "Funktion wird geschaltet",
};

const newId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const blank = (): Automation => ({ id: newId(), name: "", enabled: true, trigger: { type: "start" }, conditions: [], actions: [{ type: "function", fn: 0, do: "on" }] });

/** Sekundeneingabe → ms (leer = nicht gesetzt). */
export const toMs = (text: string): number | undefined => {
  const n = Number(text.replace(",", "."));
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? undefined : Math.min(60_000, Math.round(n * 1000));
};
const toSec = (ms?: number) => (ms ? String(ms / 1000) : "");

function FnSelect({ value, names, onChange }: { value: number; names: Record<number, string>; onChange: (n: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: 29 }, (_, n) => <option key={n} value={n}>{`F${n}${names[n] ? ` – ${names[n]}` : ""}`}</option>)}
    </select>
  );
}

function Editor({ a, names, onChange, onRemove }: { a: Automation; names: Record<number, string>; onChange: (a: Automation) => void; onRemove: () => void }) {
  const setAction = (i: number, p: Partial<Action>) => onChange({ ...a, actions: a.actions.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const setCond = (i: number, c: Condition) => onChange({ ...a, conditions: a.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="automation">
      <div className="row tight">
        <label className="check"><input type="checkbox" checked={a.enabled} onChange={(e) => onChange({ ...a, enabled: e.target.checked })} /> aktiv</label>
        <input placeholder="Name" maxLength={60} value={a.name} onChange={(e) => onChange({ ...a, name: e.target.value })} />
        <button type="button" className="x" title="Automatismus entfernen" onClick={onRemove}>×</button>
      </div>
      <div className="row tight">
        <strong>Wenn</strong>
        <select value={a.trigger.type} onChange={(e) => {
          const type = e.target.value as Trigger["type"];
          onChange({ ...a, trigger: type === "function" ? { type, fn: 0, on: true } : { type } });
        }}>
          {(Object.keys(TRIGGER_LABELS) as Trigger["type"][]).map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
        </select>
        {a.trigger.type === "function" && (<>
          <FnSelect value={a.trigger.fn} names={names} onChange={(fn) => onChange({ ...a, trigger: { type: "function", fn, on: (a.trigger as { on: boolean }).on } })} />
          <select value={a.trigger.on ? "on" : "off"} onChange={(e) => onChange({ ...a, trigger: { type: "function", fn: (a.trigger as { fn: number }).fn, on: e.target.value === "on" } })}>
            <option value="on">ein</option><option value="off">aus</option>
          </select>
        </>)}
      </div>
      {a.conditions.map((c, i) => (
        <div className="row tight" key={i}>
          <strong>{i === 0 ? "und nur wenn" : "und"}</strong>
          <select value={c.type} onChange={(e) => setCond(i, e.target.value === "direction" ? { type: "direction", forward: true } : e.target.value === "moving" ? { type: "moving", moving: true } : { type: "function", fn: 0, on: true })}>
            <option value="direction">Richtung</option><option value="moving">Fahrzustand</option><option value="function">Funktion</option>
          </select>
          {c.type === "direction" && <select value={c.forward ? "f" : "b"} onChange={(e) => setCond(i, { type: "direction", forward: e.target.value === "f" })}><option value="f">vorwärts</option><option value="b">rückwärts</option></select>}
          {c.type === "moving" && <select value={c.moving ? "m" : "s"} onChange={(e) => setCond(i, { type: "moving", moving: e.target.value === "m" })}><option value="m">fährt</option><option value="s">steht</option></select>}
          {c.type === "function" && (<>
            <FnSelect value={c.fn} names={names} onChange={(fn) => setCond(i, { ...c, fn })} />
            <select value={c.on ? "on" : "off"} onChange={(e) => setCond(i, { ...c, on: e.target.value === "on" })}><option value="on">ist ein</option><option value="off">ist aus</option></select>
          </>)}
          <button type="button" className="x" title="Bedingung entfernen" onClick={() => onChange({ ...a, conditions: a.conditions.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <div className="row tight"><button type="button" onClick={() => onChange({ ...a, conditions: [...a.conditions, { type: "direction", forward: true }] })}>+ Bedingung</button></div>
      {a.actions.map((x, i) => (
        <div className="row tight" key={i}>
          <strong>{i === 0 ? "dann" : "und"}</strong>
          <select value={x.do} onChange={(e) => {
            const d = e.target.value as Action["do"];
            setAction(i, d === "on" ? { do: d } : { do: d, forMs: undefined });
          }}>
            <option value="on">einschalten</option><option value="off">ausschalten</option><option value="toggle">umschalten</option>
          </select>
          <FnSelect value={x.fn} names={names} onChange={(fn) => setAction(i, { fn })} />
          <label>nach <input type="number" min={0} step="0.1" value={toSec(x.delayMs)} onChange={(e) => setAction(i, { delayMs: toMs(e.target.value) })} /> s</label>
          {x.do === "on" && <label>für <input type="number" min={0} step="0.1" value={toSec(x.forMs)} placeholder="∞" onChange={(e) => setAction(i, { forMs: toMs(e.target.value) })} /> s</label>}
          {a.actions.length > 1 && <button type="button" className="x" title="Aktion entfernen" onClick={() => onChange({ ...a, actions: a.actions.filter((_, j) => j !== i) })}>×</button>}
        </div>
      ))}
      <div className="row tight"><button type="button" onClick={() => onChange({ ...a, actions: [...a.actions, { type: "function", fn: 0, do: "on" }] })}>+ Aktion</button></div>
    </div>
  );
}

/** Automatismen der gewählten Lok: Auslöser → Bedingung → Aktion. */
export function Automations({ addr, names, run }: { addr: number; names: Record<number, string>; run: Run }) {
  const [list, setList] = useState<Automation[]>();
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let alive = true;
    api<Automation[]>("GET", `/api/locos/${addr}/automations`).then((l) => { if (alive) { setList(l); setDirty(false); } }, () => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [addr]);
  if (!list) return null;
  const change = (next: Automation[]) => { setList(next); setDirty(true); };
  const save = () => run(api<Automation[]>("PUT", `/api/locos/${addr}/automations`, list).then((l) => { setList(l); setDirty(false); }));
  return (
    <div className="panel">
      <div className="head">
        <h2>Automatik<small>Lok {addr}</small></h2>
        <button type="button" onClick={() => change([...list, blank()])}>+ Automatismus</button>
        <button type="button" className={dirty ? "active" : ""} disabled={!dirty} onClick={save}>Speichern</button>
      </div>
      {list.length === 0 && <p className="hint">Noch kein Automatismus. Beispiel: Wenn die Lok anfährt, Licht einschalten.</p>}
      {list.map((a, i) => (
        <Editor key={a.id} a={a} names={names} onChange={(n) => change(list.map((x, j) => (j === i ? n : x)))} onRemove={() => change(list.filter((_, j) => j !== i))} />
      ))}
    </div>
  );
}
