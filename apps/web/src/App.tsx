import { useState } from "react";
import { api, useStation, type LocoNetLine, type StationState } from "./api";
import { BoostersTab, ClockTab, DeviceTab, RmBusTab, SignalsTab } from "./devices";
import { DetectorsTab, LocoNetTab, RailComTab } from "./monitors";
import { DriveTab, ModeSelect } from "./drive";
import { NetworkTab } from "./network";
import { Login, useSession } from "./login";
import { LayoutTab } from "./layout";
import { CameraSidebar, CamerasTab, useCameras } from "./camera";

type Tab =
  | "station" | "cameras" | "network" | "drive" | "layout" | "turnouts" | "signals" | "cv" | "rmbus" | "clock" | "boosters" | "device"
  | "railcom" | "loconet" | "detectors" | "monitor";

const ALL_TABS: [Tab, string][] = [
  ["station", "Zentrale"], ["network", "Netzwerk"], ["cameras", "Kamera"], ["drive", "Fahren"], ["layout", "Stellwerk"], ["turnouts", "Weichen"], ["signals", "Signale"], ["cv", "CV-Programmierung"],
  ["rmbus", "R-BUS"], ["clock", "Uhr"], ["boosters", "Booster"], ["device", "Gerät"],
  ["railcom", "RailCom"], ["loconet", "LocoNet"], ["detectors", "Melder"], ["monitor", "Rohdaten"],
];

/** A Z21 offers everything; zLink boosters/decoders (behind a 10838 Z21 pro LINK) only a small part of the protocol. */
function visibleTabs(state?: StationState): [Tab, string][] {
  const kind = state?.hw?.kind;
  const keep = (ids: Tab[]) => ALL_TABS.filter(([id]) => ids.includes(id));
  if (!state?.connected) return keep(["station", "cameras", "monitor"]);
  if (kind === "booster") return keep(["station", "device", "cameras", "monitor"]);
  if (kind === "decoder") return keep(["station", "device", "signals", "cv", "cameras", "monitor"]);
  return ALL_TABS.filter(([id]) => id !== "device");
}

type Run = (p: Promise<unknown>) => Promise<void>;
const post = (url: string, body?: unknown) => api("POST", url, body);
const put = (url: string, body?: unknown) => api("PUT", url, body);

function Main({ logout }: { logout?: () => void }) {
  const { state, wire, loconet, online, clearWire, clearLoconet } = useStation();
  const [tab, setTab] = useState<Tab>("station");
  const { cameras, reload: reloadCameras } = useCameras();
  const [error, setError] = useState<string>();
  const run: Run = async (p) => { try { setError(undefined); await p; } catch (e) { setError((e as Error).message); } };

  const tabs = visibleTabs(state);
  const current: Tab = tabs.some(([id]) => id === tab) ? tab : "station";
  const connected = !!state?.connected;
  const kind = state?.hw?.kind;

  return (
    <div className="shell">
    <div className="app">
      <header>
        <h1>Z21 Web</h1>
        <span className={`dot ${connected ? "ok" : online ? "warn" : "bad"}`} />
        <span>{connected ? `${state?.hw?.hwName ?? "Z21"} @ ${state?.host}` : online ? "nicht mit Zentrale verbunden" : "Server offline"}</span>
        {connected && kind !== "decoder" && state && <PowerBar state={state} run={run} />}
        {logout && <button className={connected ? "" : "push"} onClick={logout} title="Abmelden">Abmelden</button>}
      </header>
      <nav>
        {tabs.map(([id, label]) => (
          <button key={id} className={current === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {error && <div className="error" onClick={() => setError(undefined)}>{error}</div>}
      <main>
        {current === "station" && <StationTab state={state} run={run} />}
        {connected && state && (
          <>
            {current === "network" && <NetworkTab state={state} run={run} />}
            {current === "drive" && <DriveTab state={state} run={run} />}
            {current === "layout" && <LayoutTab state={state} run={run} />}
            {current === "turnouts" && <TurnoutsTab state={state} run={run} />}
            {current === "signals" && <SignalsTab state={state} run={run} />}
            {current === "cv" && <CvTab run={run} decoderOnly={kind === "decoder"} />}
            {current === "rmbus" && <RmBusTab state={state} run={run} />}
            {current === "clock" && <ClockTab state={state} run={run} />}
            {current === "boosters" && <BoostersTab state={state} run={run} />}
            {current === "device" && <DeviceTab state={state} run={run} />}
            {current === "railcom" && <RailComTab state={state} run={run} />}
            {current === "loconet" && <LocoNetTab state={state} lines={loconet as LocoNetLine[]} clear={clearLoconet} run={run} />}
            {current === "detectors" && <DetectorsTab state={state} run={run} />}
          </>
        )}
        {current === "cameras" && <CamerasTab cameras={cameras} reload={reloadCameras} run={run} />}
        {current === "monitor" && <Monitor wire={wire} clear={clearWire} />}
      </main>
    </div>
      <CameraSidebar cameras={cameras} onConfigure={() => setTab("cameras")} />
    </div>
  );
}

/** Shows the login form when the server asks for a password, the application otherwise. */
export function App() {
  const session = useSession();
  if (!session.known) return null;
  if (!session.authenticated) return <Login onDone={session.refresh} />;
  return <Main logout={session.required ? session.logout : undefined} />;
}

function PowerBar({ state, run }: { state: StationState; run: Run }) {
  const on = state.power === "on";
  return (
    <div className="power">
      <span className={`pill ${state.power}`}>{state.power ?? "?"}</span>
      <button onClick={() => run(post("/api/power", { on: !on }))}>{on ? "Gleisspannung aus" : "Gleisspannung ein"}</button>
      <button className="danger" onClick={() => run(post("/api/estop"))}>NOT-HALT</button>
    </div>
  );
}

function StationTab({ state, run }: { state?: StationState; run: Run }) {
  const [host, setHost] = useState("192.168.0.111");
  const [found, setFound] = useState<{ host: string; serial: number }[]>();
  const s = state?.systemState;
  const code = state?.unlockCode;
  return (
    <section>
      <h2>Verbindung</h2>
      <div className="row">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="IP der Z21" />
        <button onClick={() => run(post("/api/connect", { host }))}>Verbinden</button>
        <button onClick={() => run(post("/api/disconnect"))}>Trennen</button>
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
              <tr><th>Typ</th><td>{state.hw?.hwName}</td><th>Firmware</th><td>{state.hw?.fwVersion}{state.firmwareVersion && state.firmwareVersion !== state.hw?.fwVersion ? ` (X-Bus: ${state.firmwareVersion})` : ""}</td></tr>
              <tr><th>Seriennummer</th><td>{state.serial}</td><th>Temperatur</th><td>{s ? `${s.temperature} °C` : "–"}</td></tr>
              {state.hw?.kind === "z21" && (
                <>
                  <tr><th>Gleisstrom</th><td>{s?.mainCurrent} mA</td><th>Progr.-Strom</th><td>{s?.progCurrent} mA</td></tr>
                  <tr><th>Versorgung</th><td>{s && (s.supplyVoltage / 1000).toFixed(1)} V</td><th>Gleisspannung</th><td>{s && (s.vccVoltage / 1000).toFixed(1)} V</td></tr>
                </>
              )}
              {code !== undefined && code !== "none" && (
                <tr><th>z21 start</th><td colSpan={3}>{code === "startLocked" ? "Fahren und Schalten gesperrt (Aktivierungscode fehlt)" : code === "startUnlocked" ? "freigeschaltet" : `Code ${code}`}</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function TurnoutsTab({ state, run }: { state: StationState; run: Run }) {
  const [addr, setAddr] = useState(1);
  return (
    <section>
      <div className="row">
        <label>Weichenadresse <input type="number" min={1} value={addr} onChange={(e) => setAddr(Number(e.target.value))} /></label>
        <button onClick={() => run(post(`/api/turnout/${addr}`, { output: 0 }))}>Ausgang 1 (0)</button>
        <button onClick={() => run(post(`/api/turnout/${addr}`, { output: 1 }))}>Ausgang 2 (1)</button>
        <label>Format <ModeSelect value={addr >= 257 ? "dcc" : state.modes.turnout[addr]} onChange={(m) => run(put(`/api/turnout/${addr}/mode`, { mode: m }))} /></label>
        <button onClick={() => run(api("GET", `/api/turnout/${addr}/mode`))}>Format lesen</button>
      </div>
      <p>Letzter bekannter Stand: {state.turnouts[addr] ?? "–"}</p>
      <p className="hint">Welcher Ausgang „gerade“ oder „abzweigend“ ist, hängt von der Verdrahtung ab – die Zentrale weiß das nicht. Adressen ab 257 sind immer DCC.</p>
    </section>
  );
}

function NumberField({ label, value, set, min, max }: { label: string; value: number; set: (n: number) => void; min: number; max: number }) {
  return <label>{label} <input type="number" min={min} max={max} value={value} onChange={(e) => set(Number(e.target.value))} /></label>;
}

function CvTab({ run, decoderOnly }: { run: Run; decoderOnly: boolean }) {
  const [mode, setMode] = useState<"service" | "pom" | "accessory" | "register" | "mm">("service");
  const [cv, setCv] = useState(1);
  const [value, setValue] = useState(0);
  const [addr, setAddr] = useState(3);
  const [dec, setDec] = useState(0);
  const [output, setOutput] = useState("");
  const [reg, setReg] = useState(1);
  const [bit, setBit] = useState(0);
  const [bitValue, setBitValue] = useState(true);
  const read = (url: string) => run(api<{ value: number }>("GET", url).then((r) => setValue(r.value)));

  const modes: [typeof mode, string][] = decoderOnly
    ? [["service", "Direkt (Programmiergleis)"]]
    : [["service", "Programmiergleis"], ["pom", "Hauptgleis (POM) Lok"], ["accessory", "Hauptgleis (POM) Zubehör"], ["register", "Register (alte DCC)"], ["mm", "Motorola"]];
  return (
    <section>
      <div className="row">
        {modes.map(([id, l]) => <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>{l}</button>)}
      </div>

      {mode === "service" && (
        <>
          <p className="hint">{decoderOnly ? "CVs des Decoders lesen/schreiben." : "Lesen/Schreiben auf dem Programmiergleis. Das Auslesen kann lange dauern."}</p>
          <div className="row">
            <NumberField label="CV" value={cv} set={setCv} min={1} max={1024} />
            <NumberField label="Wert" value={value} set={setValue} min={0} max={255} />
            <button onClick={() => read(`/api/cv/${cv}`)}>Lesen</button>
            <button onClick={() => run(put(`/api/cv/${cv}`, { value }))}>Schreiben</button>
          </div>
        </>
      )}

      {mode === "pom" && (
        <>
          <p className="hint">Programmieren auf dem Hauptgleis bei eingeschalteter Gleisspannung. Schreiben hat keine Rückmeldung. Lesen braucht RailCom (in der Z21 aktiviert; im Decoder CV 28 Bit 0/1 und CV 29 Bit 3).</p>
          <div className="row">
            <NumberField label="Lokadresse" value={addr} set={setAddr} min={1} max={9999} />
            <NumberField label="CV" value={cv} set={setCv} min={1} max={1024} />
            <NumberField label="Wert" value={value} set={setValue} min={0} max={255} />
            <button onClick={() => read(`/api/pom/${addr}/${cv}`)}>Lesen (RailCom)</button>
            <button onClick={() => run(put(`/api/pom/${addr}/${cv}`, { value }))}>Schreiben</button>
          </div>
          <div className="row">
            <NumberField label="Bit (0–7)" value={bit} set={setBit} min={0} max={7} />
            <select value={String(bitValue)} onChange={(e) => setBitValue(e.target.value === "true")}><option value="true">1</option><option value="false">0</option></select>
            <button onClick={() => run(put(`/api/pom/${addr}/${cv}`, { bit, bitValue }))}>Einzelnes Bit schreiben</button>
          </div>
        </>
      )}

      {mode === "accessory" && (
        <>
          <p className="hint">Zubehördecoder auf dem Hauptgleis (NMRA S-9.2.1 Abschnitt D). Ausgang leer lassen = ganzer Decoder.</p>
          <div className="row">
            <NumberField label="Decoderadresse (0–511)" value={dec} set={setDec} min={0} max={511} />
            <label>Ausgang <input value={output} placeholder="0–7" style={{ width: 70 }} onChange={(e) => setOutput(e.target.value)} /></label>
            <NumberField label="CV" value={cv} set={setCv} min={1} max={1024} />
            <NumberField label="Wert" value={value} set={setValue} min={0} max={255} />
            <button onClick={() => read(`/api/pom-accessory/${dec}/${cv}?output=${encodeURIComponent(output)}`)}>Lesen (RailCom)</button>
            <button onClick={() => run(put(`/api/pom-accessory/${dec}/${cv}`, { output: output === "" ? undefined : Number(output), value }))}>Schreiben</button>
          </div>
        </>
      )}

      {mode === "register" && (
        <>
          <p className="hint">Registermodus auf dem Programmiergleis, nur für sehr alte DCC-Decoder. Bevorzugt die direkte CV-Programmierung.</p>
          <div className="row">
            <NumberField label="Register (1–8)" value={reg} set={setReg} min={1} max={8} />
            <NumberField label="Wert" value={value} set={setValue} min={0} max={255} />
            <button onClick={() => read(`/api/register/${reg}`)}>Lesen</button>
            <button onClick={() => run(put(`/api/register/${reg}`, { value }))}>Schreiben</button>
          </div>
        </>
      )}

      {mode === "mm" && (
        <>
          <p className="hint">Motorola-Decoder (6021-Programmiermodus) schreiben. Es gibt kein Lesen und keine Erfolgsmeldung – „fertig“ heißt nur, dass der Vorgang durchlief. Nicht jeder Decoder lässt sich so programmieren.</p>
          <div className="row">
            <NumberField label="Register (1–79)" value={reg} set={setReg} min={1} max={79} />
            <NumberField label="Wert" value={value} set={setValue} min={0} max={255} />
            <button onClick={() => run(put(`/api/mm-register/${reg}`, { value }))}>Schreiben</button>
          </div>
        </>
      )}
    </section>
  );
}

function Monitor({ wire, clear }: { wire: { dir: string; hex: string; message?: { type: string }; ts: number }[]; clear: () => void }) {
  return (
    <section>
      <button onClick={clear}>Leeren</button>
      <pre className="log">
        {wire.map((w) => `${new Date(w.ts).toLocaleTimeString()} ${w.dir === "tx" ? "→" : "←"} ${w.hex}${w.message ? `  ${w.message.type}` : ""}`).join("\n")}
      </pre>
    </section>
  );
}
