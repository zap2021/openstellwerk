import { useState } from "react";
import { api, useStation, type StationState } from "./api";

type Tab = "station" | "drive" | "turnouts" | "cv" | "monitor";
const TABS: [Tab, string][] = [["station", "Zentrale"], ["drive", "Fahren"], ["turnouts", "Weichen"], ["cv", "CV-Programmierung"], ["monitor", "Monitor"]];

export function App() {
  const { state, wire, online, clearWire } = useStation();
  const [tab, setTab] = useState<Tab>("station");
  const [error, setError] = useState<string>();
  const run = async (p: Promise<unknown>) => { try { setError(undefined); await p; } catch (e) { setError((e as Error).message); } };

  return (
    <div className="app">
      <header>
        <h1>Z21 Web</h1>
        <span className={`dot ${state?.connected ? "ok" : online ? "warn" : "bad"}`} />
        <span>{state?.connected ? `${state.hw?.hwName ?? "Z21"} @ ${state.host}` : online ? "nicht mit Zentrale verbunden" : "Server offline"}</span>
        {state?.connected && <PowerBar state={state} run={run} />}
      </header>
      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {error && <div className="error" onClick={() => setError(undefined)}>{error}</div>}
      <main>
        {tab === "station" && <StationTab state={state} run={run} />}
        {!state?.connected && tab !== "station" && tab !== "monitor" && <p>Bitte zuerst mit einer Zentrale verbinden.</p>}
        {state?.connected && tab === "drive" && <DriveTab state={state} run={run} />}
        {state?.connected && tab === "turnouts" && <TurnoutsTab state={state} run={run} />}
        {state?.connected && tab === "cv" && <CvTab run={run} />}
        {tab === "monitor" && <Monitor wire={wire} clear={clearWire} />}
      </main>
    </div>
  );
}

type Run = (p: Promise<unknown>) => Promise<void>;

function PowerBar({ state, run }: { state: StationState; run: Run }) {
  const on = state.power === "on";
  return (
    <div className="power">
      <span className={`pill ${state.power}`}>{state.power ?? "?"}</span>
      <button onClick={() => run(api("POST", "/api/power", { on: !on }))}>{on ? "Gleisspannung aus" : "Gleisspannung ein"}</button>
      <button className="danger" onClick={() => run(api("POST", "/api/estop"))}>NOT-HALT</button>
    </div>
  );
}

function StationTab({ state, run }: { state?: StationState; run: Run }) {
  const [host, setHost] = useState("192.168.0.111");
  const [found, setFound] = useState<{ host: string; serial: number }[]>();
  const s = state?.systemState;
  return (
    <section>
      <h2>Verbindung</h2>
      <div className="row">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="IP der Z21" />
        <button onClick={() => run(api("POST", "/api/connect", { host }))}>Verbinden</button>
        <button onClick={() => run(api("POST", "/api/disconnect"))}>Trennen</button>
        <button onClick={() => run(api<typeof found>("GET", "/api/discover").then(setFound))}>Im Netz suchen</button>
      </div>
      {found && (found.length === 0 ? <p>Keine Zentrale gefunden.</p> : (
        <ul>{found.map((f) => <li key={f.host}><a href="#" onClick={(e) => { e.preventDefault(); setHost(f.host); }}>{f.host}</a> (Seriennr. {f.serial})</li>)}</ul>
      ))}
      {state?.connected && (
        <>
          <h2>Status</h2>
          <table>
            <tbody>
              <tr><th>Typ</th><td>{state.hw?.hwName}</td><th>Firmware</th><td>{state.hw?.fwVersion}</td></tr>
              <tr><th>Seriennummer</th><td>{state.serial}</td><th>Temperatur</th><td>{s?.temperature} °C</td></tr>
              <tr><th>Gleisstrom</th><td>{s?.mainCurrent} mA</td><th>Progr.-Strom</th><td>{s?.progCurrent} mA</td></tr>
              <tr><th>Versorgung</th><td>{s && (s.supplyVoltage / 1000).toFixed(1)} V</td><th>Gleisspannung</th><td>{s && (s.vccVoltage / 1000).toFixed(1)} V</td></tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function DriveTab({ state, run }: { state: StationState; run: Run }) {
  const [addr, setAddr] = useState(3);
  const loco = state.locos.find((l) => l.address === addr);
  const speed = loco?.speed ?? 0;
  const forward = loco?.forward ?? true;
  const drive = (sp: number, fw: boolean) => run(api("POST", `/api/loco/${addr}/drive`, { speed: sp, forward: fw }));
  return (
    <section>
      <div className="row">
        <label>Adresse <input type="number" min={1} max={9999} value={addr} onChange={(e) => setAddr(Number(e.target.value))} /></label>
        <button onClick={() => run(api("GET", `/api/loco/${addr}`))}>Lok abfragen</button>
      </div>
      <div className="throttle">
        <input type="range" min={0} max={126} value={speed} onChange={(e) => drive(Number(e.target.value), forward)} />
        <strong>{speed}</strong>
        <button onClick={() => drive(0, forward)}>Stopp</button>
        <button onClick={() => drive(speed, !forward)}>{forward ? "→ vorwärts" : "← rückwärts"}</button>
        <button className="danger" onClick={() => run(api("POST", `/api/loco/${addr}/stop`, { forward }))}>Lok-Nothalt</button>
      </div>
      <div className="fns">
        {Array.from({ length: 29 }, (_, n) => (
          <button key={n} className={loco?.functions[n] ? "active" : ""} onClick={() => run(api("POST", `/api/loco/${addr}/function/${n}`, { action: "toggle" }))}>F{n}</button>
        ))}
      </div>
    </section>
  );
}

function TurnoutsTab({ state, run }: { state: StationState; run: Run }) {
  const [addr, setAddr] = useState(1);
  return (
    <section>
      <div className="row">
        <label>Weichenadresse <input type="number" min={1} value={addr} onChange={(e) => setAddr(Number(e.target.value))} /></label>
        <button onClick={() => run(api("POST", `/api/turnout/${addr}`, { output: 0 }))}>Gerade / rot (0)</button>
        <button onClick={() => run(api("POST", `/api/turnout/${addr}`, { output: 1 }))}>Abzweig / grün (1)</button>
      </div>
      <p>Letzter bekannter Stand: {state.turnouts[addr] ?? "–"}</p>
    </section>
  );
}

function CvTab({ run }: { run: Run }) {
  const [cv, setCv] = useState(1);
  const [value, setValue] = useState(0);
  return (
    <section>
      <p>Hauptgleis-Programmierung ist hier nicht enthalten – es wird auf dem Programmiergleis gelesen/geschrieben.</p>
      <div className="row">
        <label>CV <input type="number" min={1} max={1024} value={cv} onChange={(e) => setCv(Number(e.target.value))} /></label>
        <label>Wert <input type="number" min={0} max={255} value={value} onChange={(e) => setValue(Number(e.target.value))} /></label>
        <button onClick={() => run(api<{ value: number }>("GET", `/api/cv/${cv}`).then((r) => setValue(r.value)))}>Lesen</button>
        <button onClick={() => run(api("PUT", `/api/cv/${cv}`, { value }))}>Schreiben</button>
      </div>
    </section>
  );
}

function Monitor({ wire, clear }: { wire: { dir: string; hex: string; message?: { type: string }; ts: number }[]; clear: () => void }) {
  return (
    <section>
      <button onClick={clear}>Leeren</button>
      <pre className="log">
        {wire.map((w, i) => `${new Date(w.ts).toLocaleTimeString()} ${w.dir === "tx" ? "→" : "←"} ${w.hex}${w.message ? `  ${w.message.type}` : ""}`).join("\n")}
      </pre>
    </section>
  );
}
