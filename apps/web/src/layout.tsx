import { useEffect, useMemo, useRef, useState } from "react";
import {
  activePaths, blockOccupied, CENTER, EMPTY_LAYOUT, hasTrack, isSwitchable, needsSecondAddress, routeIsSet, signalAspects, stateCount, stateName,
  tileCommands, tileOccupied, tilePaths, tileState, validateLayout,
  type Block, type FeedbackRef, type Layout, type Route, type Tile, type TileKind,
} from "@z21/protocol/layout";
import { api, type StationState } from "./api";
import { DepartureBoard, formatHMS, useModelTime } from "./timetable";

type Run = (p: Promise<unknown>) => Promise<void>;
type Tool = "select" | "erase" | TileKind;

const S = 44; // tile size in px
const VEC: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const KIND_LABEL: Record<TileKind, string> = {
  straight: "Gerade", curve: "Bogen", curve90: "90° Bogen", turnoutLeft: "Weiche links", turnoutRight: "Weiche rechts", threeWay: "Dreiwegweiche",
  doubleSlip: "Kreuzungsweiche", crossing: "Kreuzung 45°", crossing90: "Kreuzung 90°", bufferStop: "Prellbock", signal: "Signal", text: "Text",
};
const PALETTE: TileKind[] = ["straight", "curve", "curve90", "turnoutLeft", "turnoutRight", "threeWay", "doubleSlip", "crossing", "crossing90", "bufferStop", "signal", "text"];
const newId = () => Math.random().toString(36).slice(2, 10);
/** Remove tiles and everything that refers to them (route steps, blocks, signal references). */
function dropTiles(l: Layout, gone: Set<string>) {
  l.tiles = l.tiles.filter((t) => !gone.has(t.id));
  for (const r of l.routes) {
    r.steps = r.steps.filter((s) => !gone.has(s.tileId));
    if (r.flank) { r.flank = r.flank.filter((s) => !gone.has(s.tileId)); if (!r.flank.length) delete r.flank; }
    if (r.signal && gone.has(r.signal)) delete r.signal;
  }
  for (const b of l.blocks ?? []) b.tileIds = b.tileIds.filter((id) => !gone.has(id));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const point = (cx: number, cy: number, d: number): [number, number] => (d === CENTER ? [cx, cy] : [cx + (VEC[d]![0] * S) / 2, cy + (VEC[d]![1] * S) / 2]);

/** One tile. `state` undefined = position unknown. `wanted` marks tiles that belong to the route being edited. */
function TileView({ tile, state, occupied, selected, hint, wanted }: { tile: Tile; state?: number; occupied?: boolean; selected?: boolean; hint?: boolean; wanted?: boolean }) {
  const cx = tile.x * S + S / 2;
  const cy = tile.y * S + S / 2;
  const paths = tilePaths(tile);
  const switchable = isSwitchable(tile) && tile.kind !== "signal";
  const active = new Set(activePaths(tile, state));
  const line = (i: number) => {
    const [a, b] = paths[i]!;
    const [x1, y1] = point(cx, cy, a);
    const [x2, y2] = point(cx, cy, b);
    // a 90° bend (edges two steps apart) is drawn rounded, the 45° bend and straights as a plain polyline
    const quarter = a !== CENTER && b !== CENTER && (b - a + 8) % 8 !== 0 && Math.min((b - a + 8) % 8, (a - b + 8) % 8) === 2;
    return quarter ? `M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}` : `M${x1} ${y1} L${cx} ${cy} L${x2} ${y2}`;
  };
  const cls = (i: number) => {
    if (switchable && state === undefined) return "trk unknown";
    if (!active.has(i)) return "trk idle";
    return `trk${occupied ? " occ" : switchable ? " set" : ""}`;
  };
  // draw the branches that are not set first, so the set one lies on top
  const order = paths.map((_, i) => i).sort((a, b) => Number(active.has(a)) - Number(active.has(b)));
  const dir = VEC[tile.rot % 8]!;
  const len = Math.hypot(dir[0], dir[1]);
  const perp: [number, number] = [-dir[1] / len, dir[0] / len];
  return (
    <g className={`tile${wanted ? " wanted" : ""}`}>
      {selected && <rect className="sel" x={tile.x * S + 1} y={tile.y * S + 1} width={S - 2} height={S - 2} rx={4} />}
      {order.map((i) => <path key={i} className={cls(i)} d={line(i)} />)}
      {tile.kind === "bufferStop" && <line className={`trk${occupied ? " occ" : ""}`} x1={cx - perp[0] * 8} y1={cy - perp[1] * 8} x2={cx + perp[0] * 8} y2={cy + perp[1] * 8} />}
      {tile.kind === "signal" && (
        <>
          <line className="mast" x1={cx} y1={cy} x2={cx - perp[0] * 13} y2={cy - perp[1] * 13} />
          <circle className={`lamp ${state === undefined ? "unknown" : state === 0 ? "stop" : "go"}`} cx={cx - perp[0] * 13} cy={cy - perp[1] * 13} r={6} />
        </>
      )}
      {tile.label && <text className={tile.kind === "text" ? "lbl big" : "lbl"} x={cx} y={tile.kind === "text" ? cy + 4 : tile.y * S + S - 3}>{tile.label}</text>}
      {hint && tile.address !== undefined && <text className="adr" x={tile.x * S + 3} y={tile.y * S + 10}>{tile.address}{tile.address2 !== undefined ? `/${tile.address2}` : ""}</text>}
      {hint && tile.feedback && <circle className="fb" cx={tile.x * S + S - 6} cy={tile.y * S + 6} r={3} />}
    </g>
  );
}

function Diagram({ layout, live, grid, selected, hint, routeSteps, marked, onCell }: {
  layout: Layout; live: StationState; grid?: boolean; selected?: string; hint?: boolean;
  /** tiles to highlight (e.g. the members of the block being edited) */
  marked?: Set<string>;
  /** when a route is being edited: show its wanted positions instead of the live ones */
  routeSteps?: Map<string, number>;
  onCell: (x: number, y: number, tile?: Tile) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const click = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * layout.cols);
    const y = Math.floor(((e.clientY - r.top) / r.height) * layout.rows);
    if (x < 0 || y < 0 || x >= layout.cols || y >= layout.rows) return;
    onCell(x, y, layout.tiles.find((t) => t.x === x && t.y === y));
  };
  return (
    <div className="diagram">
      <svg ref={ref} width={layout.cols * S} height={layout.rows * S} viewBox={`0 0 ${layout.cols * S} ${layout.rows * S}`} onClick={click}>
        {grid && (
          <>
            <defs><pattern id="grid" width={S} height={S} patternUnits="userSpaceOnUse"><path className="gridline" d={`M${S} 0 L0 0 0 ${S}`} /></pattern></defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </>
        )}
        {layout.tiles.map((t) => (
          <TileView
            key={t.id}
            tile={t}
            state={routeSteps ? (routeSteps.has(t.id) ? routeSteps.get(t.id) : isSwitchable(t) ? undefined : 0) : tileState(t, live)}
            occupied={routeSteps ? undefined : tileOccupied(t, live)}
            selected={selected === t.id}
            wanted={routeSteps?.has(t.id) || marked?.has(t.id)}
            hint={hint}
          />
        ))}
      </svg>
    </div>
  );
}

/** Signal box for everyday use: set routes, switch, look at the diagram. Editing lives in the administration. */
export function LayoutTab({ state, run }: { state: StationState; run: Run }) {
  return <Operate layout={state.layout ?? EMPTY_LAYOUT} state={state} run={run} />;
}

/** Administration page: edit the track diagram, its blocks and routes. `done` leaves the page. */
export function LayoutEditorPage({ state, run, done }: { state: StationState; run: Run; done: () => void }) {
  return <Editor saved={state.layout ?? EMPTY_LAYOUT} state={state} run={run} close={done} />;
}

const STATUS: Record<string, string> = { setting: "wird gestellt …", set: "Fahrt frei", running: "befahren", fault: "Störung" };

/** A route with start or target block is interlocked; the others are plain switch lists. */
export const isSafeRoute = (l: Layout, r: Route) => !!l.blocks?.length && !!(r.from || r.to);

function Operate({ layout, state, run }: { layout: Layout; state: StationState; run: Run }) {
  const running = state.routeRun?.running ? state.routeRun : undefined;
  const il = new Map((state.interlocking ?? []).map((r) => [r.routeId, r]));
  const click = (_x: number, _y: number, tile?: Tile) => {
    if (!tile || !isSwitchable(tile)) return;
    const cur = tileState(tile, state);
    const next = cur === undefined ? 0 : (cur + 1) % stateCount(tile);
    void run(api("POST", `/api/layout/tile/${tile.id}/set`, { state: next }));
  };
  const safe = layout.routes.filter((r) => isSafeRoute(layout, r));
  const plain = layout.routes.filter((r) => !isSafeRoute(layout, r));
  return (
    <section>
      {safe.length > 0 && (
        <div className="routes">
          {safe.map((r) => {
            const s = il.get(r.id);
            return (
              <div key={r.id} className={`route ${s?.status ?? "idle"}`}>
                <strong>{r.name}</strong>
                <span className="status">{s ? STATUS[s.status] : "frei"}</span>
                {s?.message && <small className="msg">{s.message}</small>}
                {!s && <button onClick={() => run(api("POST", `/api/interlocking/${r.id}/request`))}>Fahrstraße einstellen</button>}
                {s && s.status !== "running" && <button onClick={() => run(api("POST", `/api/interlocking/${r.id}/release`))}>Auflösen</button>}
                {s && s.status === "running" && (
                  <button className="danger" onClick={() => window.confirm(`Notauflösung „${r.name}“? Das hebt die Verriegelung auf, obwohl ein Zug in der Fahrstraße ist.`) && run(api("POST", `/api/interlocking/${r.id}/release`, { force: true }))}>Notauflösung</button>
                )}
                {s?.status === "fault" && <button className="danger" onClick={() => run(api("POST", `/api/interlocking/${r.id}/release`, { force: true }))}>Störung quittieren</button>}
              </div>
            );
          })}
        </div>
      )}
      {plain.length > 0 && (
        <div className="row">
          <span className="hint">Ungesicherte Fahrstraßen (nur Schaltliste):</span>
          {plain.map((r) => (
            <button
              key={r.id}
              className={routeIsSet(layout, r, state) ? "active" : ""}
              disabled={!!running}
              onClick={() => run(api("POST", `/api/layout/route/${r.id}/run`))}
            >{r.name}{running?.routeId === r.id ? ` (${running.done}/${running.total})` : ""}</button>
          ))}
        </div>
      )}
      {state.routeRun?.error && <div className="error">Fahrstraße abgebrochen: {state.routeRun.error}</div>}
      {layout.tiles.length === 0
        ? <p>Noch kein Gleisbild vorhanden. Unter Verwaltung → Gleisbild bearbeiten legst du eines an.</p>
        : <Diagram layout={layout} live={state} onCell={click} />}
      <p className="hint">
        Klick auf eine Weiche oder ein Signal schaltet um; Felder in einer eingestellten Fahrstraße sind verriegelt.
        Blau = gestellter Weg, rot = belegt, gestrichelt = Lage noch nicht gemeldet.
      </p>
    </section>
  );
}

/** Read-only view for a second screen: model clock and the live track diagram, no controls. */
export function DisplayView({ state }: { state?: StationState }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const z = state?.clock?.time;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = z ? `${pad(z.hour)}:${pad(z.minute)}` : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const tt = state?.timetable;
  const layout = state?.layout;
  const il = new Map((state?.interlocking ?? []).map((r) => [r.routeId, r]));
  const active = (layout?.routes ?? []).filter((r) => il.has(r.id));
  return (
    <div className="display">
      <header className="display-head">
        {tt ? <ModelClock clock={tt.clock} /> : <div className="display-clock" title={z ? "Modellbahn-Uhr der Z21" : "Uhrzeit dieses Geräts (keine Modellbahn-Uhr gemeldet)"}>{time}{z && z.rate > 1 ? <small>×{z.rate}</small> : null}</div>}
        <div className="display-routes">
          {active.length === 0 ? <span className="muted">Keine Fahrstraße eingestellt</span> : active.map((r) => <span key={r.id} className={`chip ${il.get(r.id)!.status}`}>{r.name} · {STATUS[il.get(r.id)!.status]}</span>)}
        </div>
        {state?.demo && <span className="demo-badge">DEMO</span>}
        <span className={`dot ${state?.connected ? "ok" : "bad"}`} title={state?.connected ? "mit Zentrale verbunden" : "keine Verbindung"} />
      </header>
      {layout && layout.tiles.length > 0
        ? <Diagram layout={layout} live={state!} onCell={() => undefined} />
        : <p className="muted">Noch kein Gleisbild vorhanden.</p>}
      {state && tt && <DepartureBoard state={state} />}
    </div>
  );
}

/** The timetable clock of the display: HH:MM large, stopped state and speed visible. */
function ModelClock({ clock }: { clock: NonNullable<StationState["timetable"]>["clock"] }) {
  const model = useModelTime(clock);
  return (
    <div className="display-clock" title="Fahrplanuhr">
      <span className="display-clock-title">Fahrplanuhr</span>
      {formatHMS(model).slice(0, 5)}
      {clock.running ? (clock.factor > 1 ? <small>×{clock.factor}</small> : null) : <small>angehalten</small>}
    </div>
  );
}

function Num({ label, value, set, min, max }: { label: string; value?: number; set: (n?: number) => void; min: number; max: number }) {
  return (
    <label>{label}
      <input type="number" min={min} max={max} value={value ?? ""} onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))} />
    </label>
  );
}

function Editor({ saved, state, run, close }: { saved: Layout; state: StationState; run: Run; close: () => void }) {
  const [draft, setDraft] = useState<Layout>(() => structuredClone(saved));
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string>();
  const [routeId, setRouteId] = useState<string>();
  const [blockId, setBlockId] = useState<string>();
  const lastRot = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const change = (fn: (l: Layout) => void) => { setDraft((d) => { const n = structuredClone(d); fn(n); return n; }); setDirty(true); };
  const tile = draft.tiles.find((t) => t.id === selected);
  const route = draft.routes.find((r) => r.id === routeId);
  const block = (draft.blocks ?? []).find((b) => b.id === blockId);
  const routeSteps = useMemo(() => (route ? new Map(route.steps.map((s) => [s.tileId, s.state])) : undefined), [route]);
  const patch = (p: Partial<Tile>) => change((l) => { const t = l.tiles.find((x) => x.id === selected); if (t) Object.assign(t, p); });
  const removeTile = (id: string) => change((l) => dropTiles(l, new Set([id])));

  const onCell = (x: number, y: number, hit?: Tile) => {
    if (route) { // editing a route: clicking cycles the wanted position, the last click takes the tile out again
      if (!hit || !isSwitchable(hit)) return;
      change((l) => {
        const r = l.routes.find((q) => q.id === routeId)!;
        const step = r.steps.find((s) => s.tileId === hit.id);
        if (!step) r.steps.push({ tileId: hit.id, state: 0 });
        else if (step.state + 1 < stateCount(hit)) step.state += 1;
        else r.steps = r.steps.filter((s) => s !== step);
      });
      return;
    }
    if (block) { // editing a block: clicking track tiles adds or removes them
      if (!hit || !hasTrack(hit)) return;
      change((l) => {
        const b = l.blocks!.find((q) => q.id === blockId)!;
        const has = b.tileIds.includes(hit.id);
        for (const o of l.blocks!) o.tileIds = o.tileIds.filter((id) => id !== hit.id); // a tile belongs to one block only
        if (!has) b.tileIds.push(hit.id);
      });
      return;
    }
    if (tool === "select") { setSelected(hit?.id); return; }
    if (tool === "erase") { if (hit) removeTile(hit.id); return; }
    if (!hit) {
      const id = newId();
      change((l) => { l.tiles.push({ id, x, y, kind: tool, rot: tool === "text" ? 0 : lastRot.current, ...(tool === "text" ? { label: "Text" } : {}) }); });
      setSelected(id);
    } else if (hit.kind === tool) {
      lastRot.current = (hit.rot + 1) % 8;
      change((l) => { l.tiles.find((t) => t.id === hit.id)!.rot = lastRot.current; });
      setSelected(hit.id);
    } else {
      change((l) => {
        const i = l.tiles.findIndex((t) => t.id === hit.id);
        const blocks = (l.blocks ?? []).filter((b) => b.tileIds.includes(hit.id));
        dropTiles(l, new Set([hit.id])); // refs to the old tile go; a track tile keeps its block
        l.tiles.splice(i, 0, { id: hit.id, x, y, kind: tool, rot: hit.rot, label: hit.label });
        if (hasTrack({ kind: tool } as Tile)) for (const b of blocks) b.tileIds.push(hit.id);
      });
      setSelected(hit.id);
    }
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea") || !tile) return;
      if (e.key === "r" || e.key === "R") { lastRot.current = (tile.rot + (e.shiftKey ? 7 : 1)) % 8; patch({ rot: lastRot.current }); }
      if (e.key === "Delete" || e.key === "Backspace") { removeTile(tile.id); setSelected(undefined); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const save = () => run(api<Layout>("PUT", "/api/layout", draft).then((l) => { setDraft(structuredClone(l)); setDirty(false); }));
  const resize = (cols: number, rows: number) => change((l) => {
    l.cols = Math.max(4, Math.min(80, cols || 4));
    l.rows = Math.max(4, Math.min(50, rows || 4));
    dropTiles(l, new Set(l.tiles.filter((t) => t.x >= l.cols || t.y >= l.rows).map((t) => t.id)));
  });
  const exportFile = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }));
    a.download = "gleisbild.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importFile = (f?: File) => f && (draft.tiles.length === 0 || window.confirm("Das aktuelle Gleisbild im Editor wird durch die Datei ersetzt (gespeichert wird erst mit „Speichern“). Fortfahren?")) && run(f.text().then((t) => { setDraft(validateLayout(JSON.parse(t))); setDirty(true); setSelected(undefined); setRouteId(undefined); }));
  /** Send the commands of one position straight to the station, without saving the diagram first. */
  const test = (t: Tile, s: number) => run((async () => {
    for (const c of tileCommands(t, s)) {
      await api("POST", c.type === "turnout" ? `/api/turnout/${c.address}` : `/api/accessory/${c.address}`, c.type === "turnout" ? { output: c.output } : { value: c.value });
      await sleep(250);
    }
  })());
  const setFeedback = (f?: FeedbackRef) => patch({ feedback: f });
  const fb = tile?.feedback;

  return (
    <section>
      <div className="row">
        <h2 className="grow">Gleisbild bearbeiten{dirty ? " *" : ""}</h2>
        <button className="active" disabled={!dirty} onClick={save}>Speichern</button>
        <button onClick={() => (!dirty || window.confirm("Ungespeicherte Änderungen verwerfen?")) && close()}>{dirty ? "Verwerfen" : "Fertig"}</button>
      </div>

      <div className="row palette">
        <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="Feld auswählen">Auswählen</button>
        {PALETTE.map((k) => (
          <button key={k} className={`pal ${tool === k ? "active" : ""}`} onClick={() => { setTool(k); setRouteId(undefined); setBlockId(undefined); }} title={KIND_LABEL[k]}>
            <svg width={S * 0.7} height={S * 0.7} viewBox={`0 0 ${S} ${S}`}>
              {k === "text" ? <text className="lbl big" x={S / 2} y={S / 2 + 5}>Abc</text> : <TileView tile={{ id: "p", x: 0, y: 0, kind: k, rot: 0 }} state={0} />}
            </svg>
          </button>
        ))}
        <button className={tool === "erase" ? "active danger" : "danger"} onClick={() => setTool("erase")}>Löschen</button>
      </div>
      <p className="hint">
        Art wählen und ins Raster klicken. Ein weiterer Klick auf dasselbe Feld dreht es (auch Taste R), Entf löscht das gewählte Feld.
        {route && <strong> Fahrstraße „{route.name}“: Weichen und Signale anklicken, bis die gewünschte Stellung gezeigt wird.</strong>}
        {block && <strong> Block „{block.name}“: Gleisfelder anklicken, um sie aufzunehmen oder zu entfernen (ein Feld gehört zu höchstens einem Block).</strong>}
      </p>

      <div className="editor">
        <Diagram layout={draft} live={state} grid hint selected={selected} routeSteps={routeSteps} marked={block ? new Set(block.tileIds) : undefined} onCell={onCell} />

        <div className="inspector">
          {tile && !route && !block && (
            <div className="panel">
              <h2>{KIND_LABEL[tile.kind]}</h2>
              <div className="form">
                <label>Beschriftung <input value={tile.label ?? ""} maxLength={40} onChange={(e) => patch({ label: e.target.value || undefined })} /></label>
                {tile.kind !== "text" && (
                  <label>Drehung
                    <span className="row tight">
                      <button onClick={() => patch({ rot: (tile.rot + 7) % 8 })}>↺</button>
                      <button onClick={() => patch({ rot: (tile.rot + 1) % 8 })}>↻</button>
                      <span>{tile.rot * 45}°</span>
                    </span>
                  </label>
                )}
                {tile.kind === "signal" && (
                  <label>Ansteuerung
                    <select value={tile.signalMode ?? "turnout"} onChange={(e) => patch({ signalMode: e.target.value as "turnout" | "ext", address: undefined })}>
                      <option value="turnout">Weichenadresse (2 Begriffe)</option>
                      <option value="ext">Signaldecoder DCCext (z. B. 10837)</option>
                    </select>
                  </label>
                )}
                {isSwitchable(tile) && (
                  <>
                    <Num label={needsSecondAddress(tile) ? "Adresse 1" : "Adresse"} value={tile.address} set={(n) => patch({ address: n })} min={1} max={tile.signalMode === "ext" ? 2044 : 16384} />
                    {tile.signalMode !== "ext" && <label className="check"><input type="checkbox" checked={!!tile.invert} onChange={(e) => patch({ invert: e.target.checked || undefined })} /> Stellung tauschen</label>}
                    {needsSecondAddress(tile) && (
                      <>
                        <Num label="Adresse 2" value={tile.address2} set={(n) => patch({ address2: n })} min={1} max={16384} />
                        <label className="check"><input type="checkbox" checked={!!tile.invert2} onChange={(e) => patch({ invert2: e.target.checked || undefined })} /> Stellung 2 tauschen</label>
                      </>
                    )}
                  </>
                )}
                {tile.kind === "signal" && tile.signalMode === "ext" && (
                  <label className="wide">Signalbilder (eine Zeile je Begriff: Name=Wert, der erste ist „Halt“)
                    <textarea
                      rows={4}
                      defaultValue={signalAspects(tile).map((a) => `${a.name}=${a.value}`).join("\n")}
                      key={tile.id}
                      onBlur={(e) => {
                        const aspects = e.target.value.split("\n").map((l) => l.split("=")).filter((p) => p.length === 2 && p[0]!.trim() && /^\d+$/.test(p[1]!.trim()))
                          .map(([n, v]) => ({ name: n!.trim().slice(0, 20), value: Math.min(255, Number(v)) }));
                        patch({ aspects: aspects.length >= 2 ? aspects : undefined });
                      }}
                    />
                  </label>
                )}
              </div>
              {isSwitchable(tile) && tile.address !== undefined && state.connected && (
                <div className="row tight">
                  <span className="hint">Testen:</span>
                  {Array.from({ length: stateCount(tile) }, (_, s) => <button key={s} onClick={() => test(tile, s)}>{stateName(tile, s)}</button>)}
                </div>
              )}
              {hasTrack(tile) && (
                <>
                  <h3>Gleisbesetztmelder</h3>
                  <div className="form">
                    <label>Typ
                      <select
                        value={fb?.bus ?? ""}
                        onChange={(e) => setFeedback(e.target.value === "rbus" ? { bus: "rbus", module: 1, input: 1 } : e.target.value === "loconet" ? { bus: "loconet", feedbackAddress: 1 } : e.target.value === "can" ? { bus: "can", nid: 0, port: 0 } : undefined)}
                      >
                        <option value="">keiner</option>
                        <option value="rbus">R-BUS</option>
                        <option value="loconet">LocoNet</option>
                        <option value="can">CAN</option>
                      </select>
                    </label>
                    {fb?.bus === "rbus" && (
                      <>
                        <Num label="Modul (1–20)" value={fb.module} set={(n) => setFeedback({ ...fb, module: n ?? 1 })} min={1} max={20} />
                        <Num label="Eingang (1–8)" value={fb.input} set={(n) => setFeedback({ ...fb, input: n ?? 1 })} min={1} max={8} />
                      </>
                    )}
                    {fb?.bus === "loconet" && <Num label="Melderadresse" value={fb.feedbackAddress} set={(n) => setFeedback({ ...fb, feedbackAddress: n ?? 0 })} min={0} max={65535} />}
                    {fb?.bus === "can" && (
                      <>
                        <Num label="Netzwerk-ID" value={fb.nid} set={(n) => setFeedback({ ...fb, nid: n ?? 0 })} min={0} max={65535} />
                        <Num label="Port" value={fb.port} set={(n) => setFeedback({ ...fb, port: n ?? 0 })} min={0} max={15} />
                      </>
                    )}
                  </div>
                </>
              )}
              <div className="row"><button className="danger" onClick={() => { removeTile(tile.id); setSelected(undefined); }}>Feld löschen</button></div>
            </div>
          )}

          <div className="panel">
            <h2>Blöcke</h2>
            <p className="hint">Ein Block ist ein Gleisabschnitt. Er gilt als belegt, sobald ein Melder in ihm belegt meldet. Ohne Blöcke gibt es keine Sicherung.</p>
            <ul className="loco-list">
              {(draft.blocks ?? []).length === 0 && <li className="empty">Noch kein Block.</li>}
              {(draft.blocks ?? []).map((b) => (
                <li key={b.id}>
                  {blockId === b.id
                    ? <input className="grow" value={b.name} maxLength={40} autoFocus onChange={(e) => change((l) => { l.blocks!.find((q) => q.id === b.id)!.name = e.target.value; })} />
                    : <button className="loco-item" onClick={() => { setBlockId(b.id); setRouteId(undefined); setSelected(undefined); }}><span className="meta"><strong>{b.name}</strong><small>{b.tileIds.length} Felder, {b.tileIds.some((id) => draft.tiles.find((t) => t.id === id)?.feedback) ? "mit Melder" : "ohne Melder"}</small></span></button>}
                  {blockId === b.id && <button onClick={() => setBlockId(undefined)}>Fertig</button>}
                  <button className="x" title="Block löschen" onClick={() => { change((l) => { l.blocks = l.blocks!.filter((q) => q.id !== b.id); for (const r of l.routes) { if (r.from === b.id) delete r.from; if (r.to === b.id) delete r.to; if (r.blocks) { r.blocks = r.blocks.filter((x) => x !== b.id); if (!r.blocks.length) delete r.blocks; } } if (!l.blocks.length) delete l.blocks; }); if (blockId === b.id) setBlockId(undefined); }}>×</button>
                </li>
              ))}
            </ul>
            <button onClick={() => { const id = newId(); change((l) => { l.blocks = [...(l.blocks ?? []), { id, name: `Block ${(l.blocks?.length ?? 0) + 1}`, tileIds: [] }]; }); setBlockId(id); setRouteId(undefined); }}>+ Neuer Block</button>
          </div>

          <div className="panel">
            <h2>Fahrstraßen</h2>
            <ul className="loco-list">
              {draft.routes.length === 0 && <li className="empty">Noch keine Fahrstraße.</li>}
              {draft.routes.map((r) => <RouteRow key={r.id} route={r} blocks={draft.blocks ?? []} signals={draft.tiles.filter((t) => t.kind === "signal")} active={routeId === r.id} select={() => { setRouteId(routeId === r.id ? undefined : r.id); setBlockId(undefined); }} change={change} />)}
            </ul>
            <button onClick={() => { const id = newId(); change((l) => { l.routes.push({ id, name: `Fahrstraße ${l.routes.length + 1}`, steps: [] }); }); setRouteId(id); }}>+ Neue Fahrstraße</button>
          </div>

          <div className="panel">
            <h2>Raster und Datei</h2>
            <div className="form">
              <Num label="Spalten" value={draft.cols} set={(n) => resize(n ?? 4, draft.rows)} min={4} max={80} />
              <Num label="Zeilen" value={draft.rows} set={(n) => resize(draft.cols, n ?? 4)} min={4} max={50} />
            </div>
            <div className="row tight">
              <button onClick={exportFile}>Exportieren</button>
              <button onClick={() => fileInput.current?.click()}>Importieren</button>
              <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function RouteRow({ route, blocks, signals, active, select, change }: {
  route: Route; blocks: Block[]; signals: Tile[]; active: boolean; select: () => void; change: (fn: (l: Layout) => void) => void;
}) {
  const edit = (fn: (r: Route) => void) => change((l) => fn(l.routes.find((r) => r.id === route.id)!));
  const pick = (key: "from" | "to" | "signal", list: { id: string; name: string }[], label: string) => (
    <label>{label}
      <select value={route[key] ?? ""} onChange={(e) => edit((r) => { if (e.target.value) r[key] = e.target.value; else delete r[key]; })}>
        <option value="">–</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </label>
  );
  return (
    <li className={active ? "open" : ""}>
      {active
        ? <input className="grow" value={route.name} maxLength={40} autoFocus onChange={(e) => edit((r) => { r.name = e.target.value; })} />
        : <button className="loco-item" onClick={select}><span className="meta"><strong>{route.name}</strong><small>{route.steps.length} Felder{route.from || route.to ? ", gesichert" : ", ungesichert"}</small></span></button>}
      {active && <button onClick={select}>Fertig</button>}
      <button className="x" title="Fahrstraße löschen" onClick={() => change((l) => { l.routes = l.routes.filter((r) => r.id !== route.id); })}>×</button>
      {active && (
        <div className="form wide">
          {pick("from", blocks, "Start (Block)")}
          {pick("to", blocks, "Ziel (Block)")}
          {pick("signal", signals.map((t) => ({ id: t.id, name: t.label ?? `Signal ${t.address ?? t.id}` })), "Startsignal")}
          <fieldset className="between">
            <legend>Blöcke dazwischen (in Fahrtrichtung anklicken)</legend>
            {blocks.filter((b) => b.id !== route.from && b.id !== route.to).map((b) => {
              const pos = route.blocks?.indexOf(b.id) ?? -1;
              return (
                <label key={b.id} className="check">
                  <input
                    type="checkbox"
                    checked={pos >= 0}
                    onChange={(e) => edit((r) => { r.blocks = e.target.checked ? [...(r.blocks ?? []), b.id] : (r.blocks ?? []).filter((x) => x !== b.id); if (!r.blocks.length) delete r.blocks; })}
                  />
                  {pos >= 0 ? `${pos + 1}. ` : ""}{b.name}
                </label>
              );
            })}
            {blocks.length <= 2 && <small className="hint">Weitere Blöcke legst du oben unter „Blöcke“ an.</small>}
          </fieldset>
          <p className="hint">Mit Start- oder Ziel-Block wird die Fahrstraße gesichert: Besetzt-Prüfung, Verriegelung, automatische Auflösung. Streckenblöcke ohne Weiche müssen unter „Blöcke dazwischen“ eingetragen werden, sonst werden sie nicht geprüft. Die Fahrstraße löst sich erst auf, wenn der Zug den Zielblock erreicht hat.</p>
        </div>
      )}
    </li>
  );
}
