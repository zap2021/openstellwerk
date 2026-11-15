import { useEffect, useMemo, useRef, useState } from "react";
import { imageUrl } from "./loco-image";
import { LocoPicture } from "./loco-picture";
import { kmh } from "./calibration";
import { api, type GarageLoco, type StationState } from "./api";
import { Automations } from "./automations";

type Run = (p: Promise<unknown>) => Promise<void>;
const post = (url: string, body?: unknown) => api("POST", url, body);
const put = (url: string, body?: unknown) => api("PUT", url, body);

export function ModeSelect({ value, onChange }: { value?: string; onChange: (m: "dcc" | "mm") => void }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value as "dcc" | "mm")}>
      <option value="" disabled>–</option>
      <option value="dcc">DCC</option>
      <option value="mm">Motorola</option>
    </select>
  );
}

const SCAN_DEFAULT = { from: 1, to: 50 };
const RAILCOM_FRESH_MS = 60_000;

/** Same rule as on the server: a queried address always answers, only a non-idle state means "in use". */
const isActive = (l: StationState["locos"][number]) => l.busy || l.speed > 0 || l.emergencyStop || l.functions.some(Boolean);

const DEFAULT_FN_NAMES: Record<number, string> = { 0: "Licht" };

interface Candidate {
  address: number;
  name?: string;
  saved: boolean;
  onTrack: boolean;
  busy: boolean;
  active: boolean;
  via: string[];
  imageVersion?: number;
}

/** Everything we have learned about which loco addresses are in use, from all sources, one row per address. */
function useCandidates(state: StationState): Candidate[] {
  return useMemo(() => {
    const map = new Map<number, Candidate>();
    const get = (address: number) => {
      let c = map.get(address);
      if (!c) map.set(address, (c = { address, saved: false, onTrack: false, busy: false, active: false, via: [] }));
      return c;
    };
    const via = (c: Candidate, v: string) => { if (!c.via.includes(v)) c.via.push(v); };
    for (const g of state.garage ?? []) {
      const c = get(g.address);
      c.saved = true;
      c.name = g.name;
      c.imageVersion = g.imageVersion;
    }
    for (const l of state.locos) {
      if (!isActive(l)) continue;
      const c = get(l.address);
      c.active = true;
      c.busy = l.busy;
      via(c, "Zentrale");
    }
    const now = Date.now();
    for (const r of state.railcom) {
      if (r.address < 1 || now - r.ts > RAILCOM_FRESH_MS) continue;
      const c = get(r.address);
      c.onTrack = true;
      via(c, "RailCom");
    }
    for (const d of state.loconetDetectors) if (d.locoAddress && d.occupied !== false) { const c = get(d.locoAddress); c.onTrack = true; via(c, "Melder"); }
    for (const d of state.canDetectors) for (const p of d.ports) for (const l of p.locos) if (l.address > 0) { const c = get(l.address); c.onTrack = true; via(c, "Melder"); }
    return [...map.values()].sort((a, b) => a.address - b.address);
  }, [state.garage, state.locos, state.railcom, state.loconetDetectors, state.canDetectors]);
}

function status(c: Candidate) {
  if (c.onTrack) return { text: "auf dem Gleis erkannt", cls: "ok" };
  if (c.busy) return { text: "belegt (anderer Regler)", cls: "warn" };
  if (c.active) return { text: "in der Zentrale aktiv", cls: "ok" };
  return { text: "gespeichert, aktuell nicht gemeldet", cls: "" };
}

/** Whether the function area shows only labelled functions; kept per browser. */
const onlyNamedStored = () => { try { return localStorage.getItem("z21.fnOnlyNamed") !== "0"; } catch { return true; } };
const storeOnlyNamed = (on: boolean) => { try { localStorage.setItem("z21.fnOnlyNamed", on ? "1" : "0"); } catch { /* private mode */ } };

const remembered = () => { try { return Number(localStorage.getItem("z21.loco")) || 0; } catch { return 0; } };
const remember = (a: number) => { try { localStorage.setItem("z21.loco", String(a)); } catch { /* private mode */ } };

export function DriveTab({ state, run }: { state: StationState; run: Run }) {
  const candidates = useCandidates(state);
  const [selected, setSelected] = useState<number>(remembered);
  const [range, setRange] = useState(SCAN_DEFAULT);
  const [manual, setManual] = useState("");
  /** What the right-hand side shows for the selected loco: the throttle with its functions, the loco's automations, or its settings. */
  const [view, setView] = useState<"drive" | "automation" | "settings">("drive");
  const autoScanned = useRef<string>();

  // Discover automatically once per connection: ask the station about the usual address range and for RailCom data.
  const sessionKey = state.connected ? `${state.host}/${state.serial}` : undefined;
  useEffect(() => {
    if (!sessionKey || state.hw?.kind !== "z21" || autoScanned.current === sessionKey) return;
    autoScanned.current = sessionKey;
    void run(post("/api/railcom/poll", { addr: 0 }).then(() => post("/api/garage/scan", range)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, state.hw?.kind]);

  // Preselect something useful.
  useEffect(() => {
    if (selected && candidates.some((c) => c.address === selected)) return;
    const first = candidates.find((c) => c.onTrack) ?? candidates.find((c) => c.saved) ?? candidates[0];
    if (first && !selected) setSelected(first.address);
  }, [candidates, selected]);

  const select = (a: number) => { setSelected(a); remember(a); };
  const scan = state.scan;
  const progress = scan ? Math.round(((scan.current - scan.from + (scan.running ? 0 : 1)) / (scan.to - scan.from + 1)) * 100) : 0;

  return (
    <section className="drive">
      <aside className="panel locos">
        <h2>Loks</h2>
        <div className="row tight">
          <label>Adressen <input type="number" min={1} max={9999} value={range.from} onChange={(e) => setRange({ ...range, from: Number(e.target.value) })} /></label>
          <label>bis <input type="number" min={1} max={9999} value={range.to} onChange={(e) => setRange({ ...range, to: Number(e.target.value) })} /></label>
        </div>
        <div className="row tight">
          {scan?.running
            ? <button onClick={() => run(api("DELETE", "/api/garage/scan"))}>Suche abbrechen</button>
            : <button onClick={() => run(post("/api/railcom/poll", { addr: 0 }).then(() => post("/api/garage/scan", range)))}>Belegte Adressen suchen</button>}
          <button
            title="Eine Lok auf das Programmiergleis stellen und ihre Adresse aus den CVs lesen"
            onClick={() => window.confirm("Lok auf dem Programmiergleis auslesen (CV29, CV1 bzw. CV17/18)? Das kann einige Sekunden dauern.") && run(post("/api/garage/read-prog"))}
          >Programmiergleis lesen</button>
        </div>
        {scan && (
          <div className="scan">
            <progress max={100} value={scan.running ? progress : 100} />
            <small>
              {scan.running ? `Suche ${scan.current}/${scan.to} …` : scan.error ? scan.error : `Suche beendet (${scan.from}–${scan.to})`}
              {" "}– {scan.found.length} gefunden
            </small>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={state.monitors.railcom} onChange={(e) => run(put("/api/monitors", { railcom: e.target.checked }))} />
          RailCom-Erkennung (dauerhaft)
        </label>
        <details>
          <summary>Wie funktioniert die Lok-Erkennung?</summary>
          <p className="hint">Gefunden wird, was die Zentrale kennt (Handregler, Apps, Lichter an) und was per RailCom oder Melder auf dem Gleis gemeldet wird. Eine stehende, unbenutzte Lok ohne RailCom lässt sich nicht erkennen – dann Adresse unten eintragen oder vom Programmiergleis lesen.</p>
        </details>

        <ul className="loco-list">
          {candidates.length === 0 && <li className="empty">Noch keine Lok erkannt.</li>}
          {candidates.map((c) => {
            const st = status(c);
            const live = state.locos.find((l) => l.address === c.address);
            return (
              <li key={c.address}>
                <button className={`loco-item ${selected === c.address ? "active" : ""}`} onClick={() => select(c.address)}>
                  {c.imageVersion ? <img className="thumb" src={imageUrl(c.address, c.imageVersion)} alt="" loading="lazy" /> : null}
                  <span className="addr">{c.address}</span>
                  <span className="meta">
                    <strong>{c.name || `Lok ${c.address}`}</strong>
                    <small className={st.cls}>{st.text}</small>
                  </span>
                  {live && live.speed > 0 && <span className="speed">{live.forward ? "▶" : "◀"} {live.speed}</span>}
                </button>
                {c.saved && (
                  <button className="x" title="Aus der Liste entfernen" onClick={() => run(api("DELETE", `/api/garage/${c.address}`))}>×</button>
                )}
              </li>
            );
          })}
        </ul>
        <form
          className="row tight"
          onSubmit={(e) => {
            e.preventDefault();
            const a = Number(manual);
            if (!Number.isInteger(a) || a < 1 || a > 9999) return;
            void run(post("/api/garage", { address: a }).then(() => { select(a); setManual(""); }));
          }}
        >
          <input type="number" min={1} max={9999} placeholder="Adresse" value={manual} onChange={(e) => setManual(e.target.value)} />
          <button type="submit">Hinzufügen</button>
        </form>
      </aside>

      {selected ? (
        <div className="controls">
          <nav className="subnav" aria-label="Ansicht der Lok">
            <button className={view === "drive" ? "active" : ""} onClick={() => setView("drive")}>Fahren</button>
            <button className={view === "automation" ? "active" : ""} onClick={() => setView("automation")}>Automatik</button>
            <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Einstellungen</button>
          </nav>
          {view === "drive" ? (
            <>
              <Throttle key={selected} addr={selected} state={state} run={run} garage={state.garage?.find((g) => g.address === selected)} />
              <Functions key={`f${selected}`} addr={selected} state={state} run={run} garage={state.garage?.find((g) => g.address === selected)} />
            </>
          ) : view === "settings" ? (
            <LocoSettings key={`s${selected}`} addr={selected} state={state} run={run} garage={state.garage?.find((g) => g.address === selected)} />
          ) : (
            <Automations key={`a${selected}`} addr={selected} names={{ ...DEFAULT_FN_NAMES, ...(state.garage?.find((g) => g.address === selected)?.functionNames ?? {}) }} run={run} />
          )}
        </div>
      ) : (
        <div className="panel"><p>Wähle links eine Lok oder trage eine Adresse ein.</p></div>
      )}
    </section>
  );
}

function Throttle({ addr, state, run, garage }: { addr: number; state: StationState; run: Run; garage?: GarageLoco }) {
  const loco = state.locos.find((l) => l.address === addr);
  const [local, setLocal] = useState<number>();
  const last = useRef(0);
  const speed = local ?? loco?.speed ?? 0;
  const forward = loco?.forward ?? true;
  const cal = state.calibration?.tables[String(addr)];

  // Subscribe to the loco's state once so that sliders and function buttons show the truth.
  useEffect(() => { if (!loco) void api("GET", `/api/loco/${addr}`).catch(() => undefined); }, [addr]); // eslint-disable-line react-hooks/exhaustive-deps

  const drive = (sp: number, fw: boolean) => run(post(`/api/loco/${addr}/drive`, { speed: Math.max(0, Math.min(126, sp)), forward: fw }));
  const slide = (sp: number) => {
    setLocal(sp);
    const now = Date.now();
    if (now - last.current > 100) { last.current = now; void drive(sp, forward); }
  };
  const release = () => { if (local !== undefined) { void drive(local, forward); setLocal(undefined); } };

  return (
    <div className="panel">
      <div className="head">
        {garage?.imageVersion ? <img className="loco-pic" src={imageUrl(addr, garage.imageVersion)} alt="" /> : null}
        <h2>{garage?.name || `Lok ${addr}`}{garage?.name ? <small>Lok {addr}</small> : null}</h2>
      </div>
      <div className="speedo">
        <strong className="big">{speed}</strong>
        <span className="dir">{speed === 0 ? "steht" : forward ? "vorwärts" : "rückwärts"}{speed > 0 && cal ? `, ≈ ${kmh(cal, speed)} km/h` : ""}</span>
      </div>
      <input
        className="slider"
        style={{ "--p": speed / 126 } as React.CSSProperties}
        type="range"
        min={0}
        max={126}
        value={speed}
        onChange={(e) => slide(Number(e.target.value))}
        onPointerUp={release}
        onKeyUp={release}
        onBlur={release}
      />
      <div className="row">
        <button onClick={() => drive(speed - 10, forward)}>−10</button>
        <button onClick={() => drive(speed - 1, forward)}>−1</button>
        <button onClick={() => drive(speed + 1, forward)}>+1</button>
        <button onClick={() => drive(speed + 10, forward)}>+10</button>
        <span className="spacer" />
        <button className={!forward ? "active" : ""} onClick={() => drive(speed, false)}>◀ rückwärts</button>
        <button className={forward ? "active" : ""} onClick={() => drive(speed, true)}>vorwärts ▶</button>
      </div>
      <div className="row">
        <button className="big-stop" onClick={() => drive(0, forward)}>Stopp</button>
        <button className="danger" onClick={() => run(post(`/api/loco/${addr}/estop`))} title="DCC-Not-Halt nur für diese Lok (Firmware ab 1.43)">Lok-Nothalt</button>
      </div>
    </div>
  );
}

/** Settings of one loco: its name, the output format stored in the command station, and rarely needed commands. */
function LocoSettings({ addr, state, run, garage }: { addr: number; state: StationState; run: Run; garage?: GarageLoco }) {
  const [binary, setBinary] = useState(29);
  const [name, setName] = useState(garage?.name ?? "");
  const [onlyNamed, setOnlyNamed] = useState(onlyNamedStored);
  useEffect(() => { setName(garage?.name ?? ""); }, [garage?.name]);
  const loco = state.locos.find((l) => l.address === addr);
  const maxFn = loco && loco.functions.length > 29 ? 31 : 28;
  const saveFnName = (n: number, text: string) => {
    if ((garage?.functionNames?.[n] ?? "") === text) return;
    void run(put(`/api/garage/${addr}`, { functionNames: { ...(garage?.functionNames ?? {}), [n]: text } }));
  };

  return (
    <div className="panel">
      <div className="head"><h2>Einstellungen<small>Lok {addr}</small></h2></div>
      <div className="row">
        <label>Name
          <input
            className="name"
            placeholder="z. B. BR 218"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== (garage?.name ?? "") && run(put(`/api/garage/${addr}`, { name }))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
      </div>
      <LocoPicture address={addr} version={garage?.imageVersion} run={run} />
      <h3>Funktionen beschriften</h3>
      <div className="fn-grid editing">
        {Array.from({ length: maxFn + 1 }, (_, n) => n).map((n) => (
          <label key={n} className="fn-edit">
            <span>F{n}</span>
            <input defaultValue={garage?.functionNames?.[n] ?? (DEFAULT_FN_NAMES[n] ?? "")} placeholder="Name" maxLength={24} onBlur={(e) => saveFnName(n, e.target.value)} />
          </label>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={onlyNamed} onChange={(e) => { setOnlyNamed(e.target.checked); storeOnlyNamed(e.target.checked); }} />
        Unter „Fahren“ nur beschriftete Funktionen zeigen (gilt für alle Loks in diesem Browser)
      </label>
      <h3>Zentrale</h3>
      <div className="row">
        <label>Format <ModeSelect value={addr >= 256 ? "dcc" : state.modes.loco[addr]} onChange={(m) => run(put(`/api/loco/${addr}/mode`, { mode: m }))} /></label>
        <button onClick={() => run(api("GET", `/api/loco/${addr}/mode`))} title="Gespeichertes Format aus der Zentrale lesen">Format lesen</button>
        <button onClick={() => run(api("GET", `/api/loco/${addr}`))}>Lok abfragen</button>
        <button
          onClick={() => window.confirm(`Lok ${addr} aus der Zentrale entfernen? Das Senden auf dem Gleis stoppt, bis ein neuer Fahr- oder Funktionsbefehl kommt.`) && run(post(`/api/loco/${addr}/purge`))}
        >Lok aus Zentrale entfernen</button>
      </div>
      <p className="hint">Das Ausgabeformat (DCC/Motorola) wird dauerhaft in der Zentrale gespeichert. Adressen ab 256 sind immer DCC.</p>
      <h3>Binärzustand</h3>
      <div className="row">
        <label>Nummer (29–32767) <input type="number" min={29} max={32767} value={binary} onChange={(e) => setBinary(Number(e.target.value))} /></label>
        <button onClick={() => run(post(`/api/loco/${addr}/binary-state`, { state: binary, on: true }))}>Ein</button>
        <button onClick={() => run(post(`/api/loco/${addr}/binary-state`, { state: binary, on: false }))}>Aus</button>
      </div>
    </div>
  );
}

function Functions({ addr, state, run, garage }: { addr: number; state: StationState; run: Run; garage?: GarageLoco }) {
  const loco = state.locos.find((l) => l.address === addr);
  const [onlyNamed] = useState(onlyNamedStored);
  const names = { ...DEFAULT_FN_NAMES, ...(garage?.functionNames ?? {}) };
  const maxFn = loco && loco.functions.length > 29 ? 31 : 28;
  const all = Array.from({ length: maxFn + 1 }, (_, n) => n);
  const hiddenCount = onlyNamed ? all.filter((n) => !names[n]).length : 0;

  return (
    <div className="panel">
      <div className="head"><h2>Funktionen</h2></div>
      <div className="fn-grid">
        {all.filter((n) => !onlyNamed || names[n]).map((n) => (
          <button
            key={n}
            className={`fn ${loco?.functions[n] ? "active" : ""}`}
            title={names[n] ? `F${n} – ${names[n]}` : `F${n}`}
            onClick={() => run(post(`/api/loco/${addr}/function/${n}`, { action: "toggle" }))}
          >
            <span className="fn-no">F{n}</span>
            {names[n] ? <span className="fn-name">{names[n]}</span> : null}
          </button>
        ))}
      </div>
      {hiddenCount > 0 && <p className="hint">{hiddenCount} unbeschriftete Funktionen ausgeblendet – beschriften oder einblenden unter „Einstellungen“.</p>}
    </div>
  );
}
