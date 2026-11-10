import { useEffect, useMemo, useRef, useState } from "react";
import {
  activePaths, CENTER, EMPTY_LAYOUT, hasTrack, isSwitchable, needsSecondAddress, routeIsSet, signalAspects, stateCount, stateName,
  tileCommands, tileOccupied, tilePaths, tileState, validateLayout,
  type FeedbackRef, type Layout, type Route, type Tile, type TileKind,
} from "@z21/protocol/layout";
import { api, type StationState } from "./api";

type Run = (p: Promise<unknown>) => Promise<void>;
type Tool = "select" | "erase" | TileKind;

const S = 44; // tile size in px
const VEC: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const KIND_LABEL: Record<TileKind, string> = {
  straight: "Gerade", curve: "Bogen", turnoutLeft: "Weiche links", turnoutRight: "Weiche rechts", threeWay: "Dreiwegweiche",
  doubleSlip: "Kreuzungsweiche", crossing: "Kreuzung 45°", crossing90: "Kreuzung 90°", bufferStop: "Prellbock", signal: "Signal", text: "Text",
};
const PALETTE: TileKind[] = ["straight", "curve", "turnoutLeft", "turnoutRight", "threeWay", "doubleSlip", "crossing", "crossing90", "bufferStop", "signal", "text"];
const newId = () => Math.random().toString(36).slice(2, 10);
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
    return `M${x1} ${y1} L${cx} ${cy} L${x2} ${y2}`;
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

function Diagram({ layout, live, grid, selected, hint, routeSteps, onCell }: {
  layout: Layout; live: StationState; grid?: boolean; selected?: string; hint?: boolean;
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
            wanted={routeSteps?.has(t.id)}
            hint={hint}
          />
        ))}
      </svg>
    </div>
  );
}

export function LayoutTab({ state, run }: { state: StationState; run: Run }) {
  const saved = state.layout ?? EMPTY_LAYOUT;
  const [editing, setEditing] = useState(false);
  return editing
    ? <Editor saved={saved} state={state} run={run} close={() => setEditing(false)} />
    : <Operate layout={saved} state={state} run={run} edit={() => setEditing(true)} />;
}

function Operate({ layout, state, run, edit }: { layout: Layout; state: StationState; run: Run; edit: () => void }) {
  const running = state.routeRun?.running ? state.routeRun : undefined;
  const click = (_x: number, _y: number, tile?: Tile) => {
    if (!tile || !isSwitchable(tile)) return;
    const cur = tileState(tile, state);
    const next = cur === undefined ? 0 : (cur + 1) % stateCount(tile);
    void run(api("POST", `/api/layout/tile/${tile.id}/set`, { state: next }));
  };
  return (
    <section>
      <div className="row">
        <h2 className="grow">Stellwerk</h2>
        <button onClick={edit}>Gleisbild bearbeiten</button>
      </div>
      {layout.routes.length > 0 && (
        <div className="row">
          <span className="hint">Fahrstraßen:</span>
          {layout.routes.map((r) => (
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
        ? <p>Noch kein Gleisbild vorhanden. Mit „Gleisbild bearbeiten“ legst du eines an.</p>
        : <Diagram layout={layout} live={state} onCell={click} />}
      <p className="hint">Klick auf eine Weiche oder ein Signal schaltet um. Blau = gestellter Weg, rot = belegt, gestrichelt = Lage noch nicht gemeldet. Fahrstraßen stellen nur, es gibt keine Verriegelung.</p>
    </section>
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
  const lastRot = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const change = (fn: (l: Layout) => void) => { setDraft((d) => { const n = structuredClone(d); fn(n); return n; }); setDirty(true); };
  const tile = draft.tiles.find((t) => t.id === selected);
  const route = draft.routes.find((r) => r.id === routeId);
  const routeSteps = useMemo(() => (route ? new Map(route.steps.map((s) => [s.tileId, s.state])) : undefined), [route]);
  const patch = (p: Partial<Tile>) => change((l) => { const t = l.tiles.find((x) => x.id === selected); if (t) Object.assign(t, p); });
  const removeTile = (id: string) => change((l) => {
    l.tiles = l.tiles.filter((t) => t.id !== id);
    for (const r of l.routes) r.steps = r.steps.filter((s) => s.tileId !== id);
  });

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
        l.tiles[i] = { id: hit.id, x, y, kind: tool, rot: hit.rot, label: hit.label };
        for (const r of l.routes) r.steps = r.steps.filter((s) => s.tileId !== hit.id);
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
    const gone = new Set(l.tiles.filter((t) => t.x >= l.cols || t.y >= l.rows).map((t) => t.id));
    l.tiles = l.tiles.filter((t) => !gone.has(t.id));
    for (const r of l.routes) r.steps = r.steps.filter((s) => !gone.has(s.tileId));
  });
  const exportFile = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }));
    a.download = "gleisbild.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importFile = (f?: File) => f && run(f.text().then((t) => { setDraft(validateLayout(JSON.parse(t))); setDirty(true); setSelected(undefined); setRouteId(undefined); }));
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
          <button key={k} className={`pal ${tool === k ? "active" : ""}`} onClick={() => { setTool(k); setRouteId(undefined); }} title={KIND_LABEL[k]}>
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
      </p>

      <div className="editor">
        <Diagram layout={draft} live={state} grid hint selected={selected} routeSteps={routeSteps} onCell={onCell} />

        <div className="inspector">
          {tile && !route && (
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
            <h2>Fahrstraßen</h2>
            <ul className="loco-list">
              {draft.routes.length === 0 && <li className="empty">Noch keine Fahrstraße.</li>}
              {draft.routes.map((r) => <RouteRow key={r.id} route={r} active={routeId === r.id} select={() => setRouteId(routeId === r.id ? undefined : r.id)} change={change} />)}
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

function RouteRow({ route, active, select, change }: { route: Route; active: boolean; select: () => void; change: (fn: (l: Layout) => void) => void }) {
  return (
    <li>
      {active
        ? <input className="grow" value={route.name} maxLength={40} autoFocus onChange={(e) => change((l) => { l.routes.find((r) => r.id === route.id)!.name = e.target.value; })} />
        : <button className="loco-item" onClick={select}><span className="meta"><strong>{route.name}</strong><small>{route.steps.length} Felder</small></span></button>}
      {active && <button onClick={select}>Fertig</button>}
      <button className="x" title="Fahrstraße löschen" onClick={() => change((l) => { l.routes = l.routes.filter((r) => r.id !== route.id); })}>×</button>
    </li>
  );
}
