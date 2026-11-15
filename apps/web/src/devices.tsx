import { useEffect, useState } from "react";
import { api, type BoosterSystemState, type DecoderState, type StationState } from "./api";
import { ifSure, sure } from "./confirm";
import { age, MonitorSwitch, useMonitor, useNow } from "./monitors";

type Run = (p: Promise<unknown>) => Promise<void>;
const post = (url: string, body?: unknown) => api("POST", url, body);
const put = (url: string, body?: unknown) => api("PUT", url, body);

const DAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const pad = (n: number) => String(n).padStart(2, "0");

/* ------------------------------------------------------------------ signals / accessories (DCCext) */

export function SignalsTab({ state, run }: { state: StationState; run: Run }) {
  const [addr, setAddr] = useState(1);
  const [value, setValue] = useState(0);
  const [time, setTime] = useState(5);
  const [output, setOutput] = useState<"red" | "green">("green");
  const known = state.extAccessories[addr];
  return (
    <section>
      <p className="hint">
        Erweiterte Zubehördecoder nach RCN-213 (DCCext), Z21 ab Firmware 1.40: Signaldecoder 10837 (Signalbild) und Weichendecoder 10836 (Schaltzeit).
        Die Adresse ist die angezeigte Adresse (ab 1).
      </p>
      <div className="row">
        <label>Adresse <input type="number" min={1} max={2044} value={addr} onChange={(e) => setAddr(Number(e.target.value))} /></label>
        <button onClick={() => run(api("GET", `/api/accessory/${addr}`))}>Zustand abfragen</button>
        <span>Letzter Wert: {known ?? "–"}</span>
      </div>

      <h2>Signalbild (10837)</h2>
      <div className="row">
        <label>Wert 0–255 <input type="number" min={0} max={255} value={value} onChange={(e) => setValue(Number(e.target.value))} /></label>
        <button onClick={() => run(post(`/api/accessory/${addr}`, { value }))}>Signalbild senden</button>
        {[[0, "Halt"], [16, "Fahrt"], [4, "40 km/h"], [65, "Rangieren"], [66, "dunkel"]].map(([v, l]) => (
          <button key={v} onClick={() => { setValue(v as number); run(post(`/api/accessory/${addr}`, { value: v })); }}>{l}</button>
        ))}
      </div>
      <p className="hint">Gültige Werte hängen vom eingestellten Signaltyp ab (Liste: z21.eu → Signaldecoder → Signaltypen).</p>

      <h2>Weiche mit Schaltzeit (10836)</h2>
      <div className="row">
        <select value={output} onChange={(e) => setOutput(e.target.value as "red" | "green")}>
          <option value="green">grün (gerade)</option>
          <option value="red">rot (abzweigend)</option>
        </select>
        <label>Einschaltzeit (×100 ms, 127 = dauernd) <input type="number" min={0} max={127} value={time} onChange={(e) => setTime(Number(e.target.value))} /></label>
        <button onClick={() => run(post(`/api/accessory/${addr}`, { value: (output === "green" ? 0x80 : 0) | (time & 0x7f) }))}>Schalten</button>
      </div>

      <h2>Not-Halt für alle erweiterten Zubehördecoder</h2>
      <button className="danger" onClick={() => sure("RCN-213 Not-Halt an alle erweiterten Zubehördecoder senden?") && run(post("/api/accessory-estop"))}>
        Not-Halt Zubehör
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ R-BUS */

export function RmBusTab({ state, run }: { state: StationState; run: Run }) {
  const { on, set } = useMonitor("rmbus", state, run);
  useEffect(() => { post("/api/rmbus/poll").catch(() => {}); }, []);
  const [prog, setProg] = useState(1);
  const modules = new Map(state.rmbus.map((m) => [m.module, m.inputs]));
  return (
    <section>
      <div className="row">
        <MonitorSwitch on={on} set={set} label="R-BUS-Meldungen empfangen" />
        <button onClick={() => run(post("/api/rmbus/poll"))}>Alle abfragen</button>
      </div>
      <p className="hint">Rückmeldemodule 10787, 10808 und 10819 am R-BUS (Modul 1–20, je 8 Eingänge).</p>
      <div className="rmbus">
        {Array.from({ length: 20 }, (_, i) => i + 1).map((mod) => (
          <div key={mod} className="module">
            <strong>Modul {mod}</strong>
            <div className="inputs">
              {Array.from({ length: 8 }, (_, bit) => (
                <span key={bit} className={`led ${modules.get(mod)?.[bit] ? "busy" : modules.has(mod) ? "free" : "unknown"}`} title={`Eingang ${bit + 1}`}>{bit + 1}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <details>
        <summary>Modul-Adresse programmieren</summary>
        <p className="hint">Nur genau EIN Modul am R-BUS anschließen. Die Programmiersequenz läuft, bis sie mit Adresse 0 beendet wird.</p>
        <div className="row">
          <label>Neue Adresse (1–20) <input type="number" min={1} max={20} value={prog} onChange={(e) => setProg(Number(e.target.value))} /></label>
          <button onClick={() => ifSure(`Das angeschlossene R-BUS-Modul auf Adresse ${prog} programmieren? Es darf nur dieses eine Modul am R-BUS hängen.`, () => run(post("/api/rmbus/program", { address: prog })))}>Starten</button>
          <button onClick={() => run(post("/api/rmbus/program", { address: 0 }))}>Beenden</button>
        </div>
      </details>
    </section>
  );
}

/* ------------------------------------------------------------------ fast clock */

const FC = { LocoNet: 0x01, XBus: 0x02, Dcc: 0x08, MrClock: 0x10, Halt: 0x40, Enabled: 0x80 };

export function ClockTab({ state, run }: { state: StationState; run: Run }) {
  const { on, set } = useMonitor("clock", state, run);
  useEffect(() => { post("/api/clock/poll").catch(() => {}); }, []);
  const t = state.clock?.time;
  const cfg = state.clock?.settings;
  const [form, setForm] = useState({ weekday: 0, hour: 12, minute: 0, rate: 1 });
  const [startForm, setStartForm] = useState({ weekday: 0, hour: 0, minute: 0, rate: 1 });
  const flags = cfg?.settings ?? 0;
  const toggle = (bit: number) =>
    run(put("/api/clock/settings", { settings: flags ^ bit }));
  return (
    <section>
      <div className="row">
        <MonitorSwitch on={on} set={set} label="Uhrzeit-Meldungen empfangen" />
        <button onClick={() => run(post("/api/clock/poll"))}>Abfragen</button>
      </div>
      <p className="hint">Modellbahn-Uhr der Z21 (Firmware ab 1.43). Die Z21 hat keine batteriegepufferte Uhr: nach dem Einschalten beginnt sie mit der Startzeit.</p>
      {t ? (
        <div className="clock">
          <span className="time">{pad(t.hour)}:{pad(t.minute)}:{pad(t.second)}</span>
          <span>{DAYS[t.weekday]}, Faktor {t.rate}×</span>
          <span className={`pill ${t.halted ? "shortCircuit" : t.stopped ? "off" : "on"}`}>{t.halted ? "angehalten (Not-Halt/Kurzschluss)" : t.stopped ? "gestoppt" : "läuft"}</span>
        </div>
      ) : <p>Noch keine Uhrzeit empfangen.</p>}
      <div className="row">
        <button onClick={() => run(post("/api/clock/start"))}>Starten</button>
        <button onClick={() => run(post("/api/clock/stop"))}>Stoppen</button>
      </div>

      <h2>Zeit setzen</h2>
      <div className="row">
        <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
        <label>Stunde <input type="number" min={0} max={23} value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })} /></label>
        <label>Minute <input type="number" min={0} max={59} value={form.minute} onChange={(e) => setForm({ ...form, minute: Number(e.target.value) })} /></label>
        <label>Faktor (1–63) <input type="number" min={0} max={63} value={form.rate} onChange={(e) => setForm({ ...form, rate: Number(e.target.value) })} /></label>
        <button onClick={() => run(put("/api/clock", form))}>Setzen</button>
      </div>

      <h2>Dauerhafte Einstellungen</h2>
      {!cfg ? <p>Noch nicht gelesen.</p> : (
        <>
          <div className="checks">
            {([["LocoNet-Ausgabe", FC.LocoNet], ["X-BUS-Broadcast", FC.XBus], ["DCC-Zeitpakete auf dem Gleis", FC.Dcc], ["MRclock-Multicast", FC.MrClock], ["Bei Not-Halt/Kurzschluss anhalten", FC.Halt], ["Uhr aktiv", FC.Enabled]] as [string, number][]).map(([label, bit]) => (
              <label key={bit} className="switch"><input type="checkbox" checked={!!(flags & bit)} onChange={() => toggle(bit)} /> {label}</label>
            ))}
          </div>
          <p className="hint">Startzeit nach dem Einschalten: {DAYS[cfg.startWeekday]} {pad(cfg.startHour)}:{pad(cfg.startMinute)}, Faktor {cfg.rate}×</p>
          <div className="row">
            <select value={startForm.weekday} onChange={(e) => setStartForm({ ...startForm, weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
            <label>Std <input type="number" min={0} max={23} value={startForm.hour} onChange={(e) => setStartForm({ ...startForm, hour: Number(e.target.value) })} /></label>
            <label>Min <input type="number" min={0} max={59} value={startForm.minute} onChange={(e) => setStartForm({ ...startForm, minute: Number(e.target.value) })} /></label>
            <label>Faktor <input type="number" min={0} max={63} value={startForm.rate} onChange={(e) => setStartForm({ ...startForm, rate: Number(e.target.value) })} /></label>
            <button onClick={() => ifSure("Startzeit und Einstellungen dauerhaft in der Z21 speichern?", () => run(put("/api/clock/settings", { settings: flags, rate: startForm.rate, start: { weekday: startForm.weekday, hour: startForm.hour, minute: startForm.minute } })))}>
              Startzeit speichern
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ CAN boosters via Z21 */

export function BoostersTab({ state, run }: { state: StationState; run: Run }) {
  const { on, set } = useMonitor("boosters", state, run);
  const now = useNow();
  const [names, setNames] = useState<Record<number, string>>({});
  return (
    <section>
      <div className="row">
        <MonitorSwitch on={on} set={set} label="Booster-Status empfangen" />
      </div>
      <p className="hint">CAN-Booster 10806, 10807 und 10869 am CAN-Bus der Z21 (Firmware ab 1.41; Ausgänge einzeln schaltbar ab 1.42). Statusmeldungen kommen etwa einmal pro Sekunde.</p>
      {state.canBoosters.length === 0 ? <p>Noch keine CAN-Booster gemeldet.</p> : state.canBoosters.map((b) => {
        const hex = b.nid.toString(16).toUpperCase();
        const nameVal = names[b.nid] ?? b.name ?? "";
        return (
          <div key={b.nid} className="card">
            <div className="row">
              <strong>NID 0x{hex}</strong>
              <input value={nameVal} maxLength={15} placeholder="Name (max. 15 Zeichen)" onChange={(e) => setNames({ ...names, [b.nid]: e.target.value })} />
              <button onClick={() => run(put(`/api/can-boosters/${b.nid}/name`, { name: nameVal }))}>Name speichern</button>
              <button onClick={() => run(post(`/api/can-boosters/${b.nid}/refresh`))}>Name lesen</button>
            </div>
            <table className="grid">
              <thead><tr><th>Ausgang</th><th>Zustand</th><th>Spannung</th><th>Strom</th><th>RailCom</th><th>Zuletzt</th><th /></tr></thead>
              <tbody>
                {b.outputs.map((o, i) => o && (
                  <tr key={i}>
                    <td>{o.outputPort}</td>
                    <td><span className={`cell ${o.shortCircuit ? "over" : o.outputDisabled || o.trackVoltageOff ? "busy" : "free"}`}>{o.shortCircuit ? "Kurzschluss" : o.outputDisabled ? "abgeschaltet" : o.trackVoltageOff ? "aus" : "ein"}</span></td>
                    <td>{(o.voltage / 1000).toFixed(1)} V</td>
                    <td>{o.current} mA</td>
                    <td>{o.railComActive ? "aktiv" : "–"}</td>
                    <td>{age(o.ts, now)}</td>
                    <td>
                      <button onClick={() => ifSure(`Booster-Ausgang ${o.outputPort} ${o.outputDisabled ? "einschalten" : "abschalten"}? Angeschlossene Gleisabschnitte ${o.outputDisabled ? "bekommen Spannung" : "werden stromlos"}.`, () => run(put(`/api/can-boosters/${b.nid}/power`, { power: (o.outputPort << 4) | (o.outputDisabled ? 0x01 : 0x00) })))}>
                        {o.outputDisabled ? "Einschalten" : "Abschalten"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <button onClick={() => ifSure("Alle Ausgänge dieses Boosters abschalten? Die Gleisabschnitte werden stromlos.", () => run(put(`/api/can-boosters/${b.nid}/power`, { power: 0x00 })))}>Alle Ausgänge aus</button>
              <button onClick={() => ifSure("Alle Ausgänge dieses Boosters einschalten?", () => run(put(`/api/can-boosters/${b.nid}/power`, { power: 0xff })))}>Alle Ausgänge ein</button>
            </div>
          </div>
        );
      })}
      <p className="hint">Ausgänge lassen sich nur einschalten, wenn die Z21 selbst eingeschaltet ist und ein gültiges Gleissignal sendet.</p>
    </section>
  );
}

/* ------------------------------------------------------------------ zLink device (booster / decoder) */

function Led({ on, label }: { on: boolean; label: string }) {
  return <span className={`led ${on ? "busy" : "free"}`} title={label}>{label}</span>;
}

function BoosterPanel({ s, run }: { s: BoosterSystemState; run: Run }) {
  return (
    <>
      <table className="grid">
        <thead><tr><th>Ausgang</th><th>Zustand</th><th>Spannung</th><th>Strom</th><th>Temperatur</th><th>RailCom</th><th /></tr></thead>
        <tbody>
          {[0, 1].map((i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td><span className={`cell ${s.shortCircuit[i] ? "over" : s.outputDisabled[i] || s.trackVoltageOff ? "busy" : "free"}`}>{s.shortCircuit[i] ? "Kurzschluss" : s.outputDisabled[i] ? "abgeschaltet" : s.trackVoltageOff ? "aus" : "ein"}</span></td>
              <td>{(s.voltage[i]! / 1000).toFixed(1)} V</td>
              <td>{s.current[i]} mA</td>
              <td>{s.temperature[i]} °C</td>
              <td>{s.railComActive[i] ? "aktiv" : "–"}</td>
              <td><button onClick={() => ifSure(`Ausgang ${i + 1} ${s.outputDisabled[i] ? "einschalten" : "abschalten"}?`, () => run(put("/api/device/booster-power", { port: i + 1, on: s.outputDisabled[i] })))}>{s.outputDisabled[i] ? "Einschalten" : "Abschalten"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Versorgung: {(s.supplyVoltage / 1000).toFixed(1)} V</p>
      <div className="row">
        <button onClick={() => ifSure("Alle Ausgänge dieses Boosters abschalten?", () => run(put("/api/device/booster-power", { port: 3, on: false })))}>Alle Ausgänge aus</button>
        <button onClick={() => ifSure("Alle Ausgänge dieses Boosters einschalten?", () => run(put("/api/device/booster-power", { port: 3, on: true })))}>Alle Ausgänge ein</button>
      </div>
      <p className="hint">Ein Ausgang lässt sich nur einschalten, wenn die Z21 ein gültiges Gleissignal liefert. Die Einstellung wird nicht gespeichert.</p>
    </>
  );
}

/** displayed turnout number of output pair i (0..7): each decoder address covers 4 turnouts; pairs 5-8 use the second address */
const switchTurnout = (s: Extract<DecoderState, { kind: "switch" }>, i: number) =>
  i < 4 ? (s.address - 1) * 4 + 1 + i : ((s.address2 || s.address + 1) - 1) * 4 + 1 + (i - 4);

function DecoderPanel({ s, run }: { s: DecoderState; run: Run }) {
  return (
    <>
      <p>
        {s.kind === "switch" ? "Weichendecoder 10836" : "Signaldecoder 10837"}, Decoderadresse {s.address}
        {s.kind === "switch" && s.address2 ? ` / ${s.address2}` : ""}, {(s.voltage / 1000).toFixed(1)} V
        {s.trackVoltageOff ? ", Gleisspannung aus" : ""}{s.shortCircuit ? ", Kurzschluss" : ""}{s.configMode ? ", Konfigurationsmodus" : ""}
      </p>
      {s.kind === "switch" ? (
        <table className="grid">
          <thead><tr><th>Ausgangspaar</th><th>Zustand</th><th>Betriebsart</th><th>Dimmung</th><th>Schalten</th></tr></thead>
          <tbody>
            {s.outputs.map((o, i) => (
              <tr key={i}>
                <td>{i + 1}</td><td>{o.state}</td><td>{o.config}</td><td>{o.dimm === 0 ? "aus" : `${o.dimm} %`}</td>
                <td>
                  <button onClick={() => run(post(`/api/accessory/${switchTurnout(s, i)}`, { value: 5 }))}>rot</button>{" "}
                  <button onClick={() => run(post(`/api/accessory/${switchTurnout(s, i)}`, { value: 0x80 | 5 }))}>grün</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <table className="grid">
            <thead><tr><th>Signal</th><th>Signaltyp (ID)</th><th>Aktuelles Bild (DCCext)</th><th>Init-Bild</th></tr></thead>
            <tbody>
              {s.signals.map((g, i) => <tr key={i}><td>{i + 1}</td><td>{g.signalId}</td><td>{g.dccExt}</td><td>{g.initAspect}</td></tr>)}
            </tbody>
          </table>
          <div className="leds">
            {s.outputsOn.map((on, i) => <Led key={i} on={on} label={`${i < 8 ? "A" : "B"}${(i % 8) + 1}${s.outputsBlinking[i] ? "~" : ""}`} />)}
          </div>
        </>
      )}
    </>
  );
}

export function DeviceTab({ state, run }: { state: StationState; run: Run }) {
  const d = state.device;
  const [name, setName] = useState<string>();
  const value = name ?? d?.name ?? "";
  const label = state.hw?.kind === "booster" ? "Booster" : "Decoder";
  return (
    <section>
      <div className="row">
        <strong>{state.hw?.hwName}</strong>
        <span>Firmware {state.hw?.fwVersion}</span>
        {d?.link && <span>Adapter: {d.link.name || "Z21 pro LINK"}, FW {d.link.fwVersion}, {d.link.mac}</span>}
        <button onClick={() => run(post("/api/device/refresh"))}>Aktualisieren</button>
      </div>
      <p className="hint">Gerät hinter einem 10838 Z21 pro LINK (zLink). Statusänderungen kommen automatisch; „Aktualisieren“ fragt Name und Status neu ab (Signaldecoder melden sich nur bei Änderungen).</p>
      <div className="row">
        <input value={value} maxLength={15} placeholder={`Name des ${label}s`} onChange={(e) => setName(e.target.value)} />
        <button onClick={() => run(put("/api/device/name", { name: value }).then(() => setName(undefined)))}>Name speichern</button>
      </div>
      {state.hw?.kind === "booster" && (d?.boosterState ? <BoosterPanel s={d.boosterState} run={run} /> : <p>Warte auf Status …</p>)}
      {state.hw?.kind === "decoder" && (d?.decoderState ? <DecoderPanel s={d.decoderState} run={run} /> : <p>Warte auf Status …</p>)}
    </section>
  );
}
