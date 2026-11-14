import { useState } from "react";
import { api, type Camera, type LocoNetLine, type SessionUser, type StationState } from "./api";
import { BackupPanel } from "./backup";
import { UsersPage } from "./users";
import { AchievementsPanel } from "./achievements";
import { CamerasTab } from "./camera";
import { ifSure } from "./confirm";
import { BoostersTab, ClockTab, DeviceTab, RmBusTab } from "./devices";
import { LayoutEditorPage } from "./layout";
import { LayoutRulesPage } from "./layout-rules";
import { DetectorsTab, LocoNetTab, RailComTab } from "./monitors";
import { NetworkTab } from "./network";
import { TimetableAdmin } from "./timetable";
import { TrainsPage } from "./trains";
import type { Route } from "./route";

type Run = (p: Promise<unknown>) => Promise<void>;
const post = (url: string, body?: unknown) => api("POST", url, body);
const put = (url: string, body?: unknown) => api("PUT", url, body);

export type AdminPage =
  | "station" | "network" | "layout" | "rules" | "trains" | "timetable" | "cameras" | "users" | "achievements" | "backup" | "cv" | "rmbus" | "clock" | "boosters" | "device"
  | "railcom" | "loconet" | "detectors" | "monitor";

/** The administration area, grouped; the order here is the order in the navigation. */
export const ADMIN_GROUPS: { title: string; pages: [AdminPage, string][] }[] = [
  { title: "Verbindung", pages: [["station", "Zentrale und Demo"], ["network", "Netzwerk"]] },
  { title: "Anlage", pages: [["layout", "Gleisbild bearbeiten"], ["rules", "Regeln"], ["trains", "Züge"], ["timetable", "Fahrplan"], ["cameras", "Kameras einrichten"], ["users", "Benutzer"], ["achievements", "Erfolge"], ["backup", "Datensicherung"]] },
  { title: "Programmieren", pages: [["cv", "CV-Programmierung"]] },
  { title: "Hardware", pages: [["rmbus", "R-BUS"], ["clock", "Modellbahn-Uhr"], ["boosters", "Booster"], ["device", "Gerät"]] },
  { title: "Diagnose", pages: [["railcom", "RailCom"], ["loconet", "LocoNet"], ["detectors", "Melder"], ["monitor", "Rohdaten"]] },
];

/** Pages that start with a heading of their own; the others get the page title from the navigation. */
const HAS_OWN_HEADING: AdminPage[] = ["station", "layout", "rules", "trains", "timetable", "cameras", "backup"];

/** A Z21 offers everything; zLink boosters/decoders (behind a 10838 Z21 pro LINK) only a small part of the protocol. */
export function adminPages(state?: StationState): AdminPage[] {
  const kind = state?.hw?.kind;
  const always: AdminPage[] = ["station", "cameras", "users", "achievements", "backup", "monitor"];
  if (!state?.connected) return [...always, ...(state ? (["layout", "rules", "trains", "timetable"] as AdminPage[]) : [])];
  if (kind === "booster") return [...always, "device"];
  if (kind === "decoder") return [...always, "device", "cv"];
  return [...always, "layout", "rules", "trains", "timetable", "network", "cv", "rmbus", "clock", "boosters", "railcom", "loconet", "detectors"];
}

function StationTab({ state, run }: { state?: StationState; run: Run }) {
  const [host, setHost] = useState("192.168.0.111");
  const [found, setFound] = useState<{ host: string; serial: number }[]>();
  const s = state?.systemState;
  const code = state?.unlockCode;
  return (
    <section>
      <h2>Verbindung</h2>
      <div className={`panel demo-panel${state?.demo ? " on" : ""}`}>
        <div className="row">
          <strong>Demo-Modus</strong>
          <span className="hint grow">
            {state?.demo
              ? "Läuft: eine simulierte Zentrale ersetzt die Hardware. Fahrstraßen einstellen, ein virtueller Zug fährt sie ab."
              : "Alle Funktionen ohne Hardware ausprobieren. Startet eine simulierte Zentrale im Server und lädt, falls leer, das Beispiel-Gleisbild."}
          </span>
          <button
            className={state?.demo ? "danger" : "active"}
            disabled={!state?.demo && !!state?.connected}
            title={!state?.demo && state?.connected ? "Zuerst die Verbindung zur Zentrale trennen" : undefined}
            onClick={() => (state?.demo ? ifSure("Demo beenden? Die simulierte Zentrale wird abgeschaltet.", () => run(post("/api/demo", { on: false }))) : run(post("/api/demo", { on: true })))}
          >{state?.demo ? "Demo beenden" : "Demo starten"}</button>
        </div>
      </div>
      <div className="row">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="IP der Z21" />
        <button onClick={() => run(post("/api/connect", { host }))}>Verbinden</button>
        <button onClick={() => ifSure("Verbindung zur Zentrale trennen? Bedienung und Fahrstraßen-Sicherung sind dann nicht mehr möglich.", () => run(post("/api/disconnect")))}>Trennen</button>
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
            <button onClick={() => ifSure(`CV ${cv} auf dem Programmiergleis auf ${value} setzen? Der Decoder wird dauerhaft verändert.`, () => run(put(`/api/cv/${cv}`, { value })))}>Schreiben</button>
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
            <button onClick={() => ifSure(`Lok ${addr}: CV ${cv} auf dem Hauptgleis auf ${value} setzen? Es gibt keine Rückmeldung.`, () => run(put(`/api/pom/${addr}/${cv}`, { value })))}>Schreiben</button>
          </div>
          <div className="row">
            <NumberField label="Bit (0–7)" value={bit} set={setBit} min={0} max={7} />
            <select value={String(bitValue)} onChange={(e) => setBitValue(e.target.value === "true")}><option value="true">1</option><option value="false">0</option></select>
            <button onClick={() => ifSure(`Lok ${addr}: Bit ${bit} von CV ${cv} auf ${bitValue ? 1 : 0} setzen?`, () => run(put(`/api/pom/${addr}/${cv}`, { bit, bitValue })))}>Einzelnes Bit schreiben</button>
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
            <button onClick={() => ifSure(`Zubehördecoder ${dec}${output === "" ? "" : `, Ausgang ${output}`}: CV ${cv} auf ${value} setzen?`, () => run(put(`/api/pom-accessory/${dec}/${cv}`, { output: output === "" ? undefined : Number(output), value })))}>Schreiben</button>
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
            <button onClick={() => ifSure(`Register ${reg} auf ${value} setzen? Der Decoder wird dauerhaft verändert.`, () => run(put(`/api/register/${reg}`, { value })))}>Schreiben</button>
          </div>
        </>
      )}

      {mode === "mm" && (
        <>
          <p className="hint">Motorola-Decoder (6021-Programmiermodus) schreiben. Es gibt kein Lesen und keine Erfolgsmeldung – „fertig“ heißt nur, dass der Vorgang durchlief. Nicht jeder Decoder lässt sich so programmieren.</p>
          <div className="row">
            <NumberField label="Register (1–79)" value={reg} set={setReg} min={1} max={79} />
            <NumberField label="Wert" value={value} set={setValue} min={0} max={255} />
            <button onClick={() => ifSure(`Motorola-Register ${reg} auf ${value} setzen? Es gibt keine Rückmeldung.`, () => run(put(`/api/mm-register/${reg}`, { value })))}>Schreiben</button>
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

export function AdminView({ me, state, wire, loconet, clearWire, clearLoconet, cameras, reloadCameras, run, page, go }: {
  me?: SessionUser;
  state?: StationState;
  wire: { dir: string; hex: string; message?: { type: string }; ts: number }[];
  loconet: LocoNetLine[];
  clearWire: () => void;
  clearLoconet: () => void;
  cameras: Camera[];
  reloadCameras: () => void;
  run: Run;
  page?: string;
  go: (r: Route) => void;
}) {
  const allowed = adminPages(state);
  const current: AdminPage = allowed.includes(page as AdminPage) ? (page as AdminPage) : "station";
  const connected = !!state?.connected;
  const label = ADMIN_GROUPS.flatMap((g) => g.pages).find(([id]) => id === current)?.[1];
  return (
    <div className="admin">
      <nav className="adminnav" aria-label="Verwaltung">
        {ADMIN_GROUPS.map((g) => {
          const pages = g.pages.filter(([id]) => allowed.includes(id));
          return pages.length === 0 ? null : (
            <div key={g.title} className="group">
              <h3>{g.title}</h3>
              {pages.map(([id, text]) => (
                <button key={id} className={current === id ? "active" : ""} onClick={() => go({ area: "admin", page: id })}>{text}</button>
              ))}
            </div>
          );
        })}
      </nav>
      <main className="adminmain">
        {!HAS_OWN_HEADING.includes(current) && <h2 className="pagetitle">{label}</h2>}
        {current === "station" && <StationTab state={state} run={run} />}
        {current === "cameras" && <CamerasTab cameras={cameras} reload={reloadCameras} run={run} />}
        {current === "users" && <UsersPage me={me} run={run} />}
        {current === "achievements" && <AchievementsPanel view={state?.achievements} run={run} />}
        {current === "backup" && <BackupPanel run={run} />}
        {current === "monitor" && <Monitor wire={wire} clear={clearWire} />}
        {current === "layout" && state && <LayoutEditorPage state={state} run={run} done={() => go({ area: "admin", page: "station" })} />}
        {current === "rules" && state && <LayoutRulesPage layout={state.layout} run={run} />}
        {current === "trains" && state && <TrainsPage state={state} run={run} />}
        {current === "timetable" && state && <TimetableAdmin state={state} run={run} />}
        {connected && state && (
          <>
            {current === "network" && <NetworkTab state={state} run={run} />}
            {current === "cv" && <CvTab run={run} decoderOnly={state.hw?.kind === "decoder"} />}
            {current === "rmbus" && <RmBusTab state={state} run={run} />}
            {current === "clock" && <ClockTab state={state} run={run} />}
            {current === "boosters" && <BoostersTab state={state} run={run} />}
            {current === "device" && <DeviceTab state={state} run={run} />}
            {current === "railcom" && <RailComTab state={state} run={run} />}
            {current === "loconet" && <LocoNetTab state={state} lines={loconet} clear={clearLoconet} run={run} />}
            {current === "detectors" && <DetectorsTab state={state} run={run} />}
          </>
        )}
      </main>
    </div>
  );
}
