import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LocoNetLine, type StationState } from "./api";

type Run = (p: Promise<unknown>) => Promise<void>;
type Kind = "railcom" | "loconet" | "detectors";

/** Monitors create traffic on the layout network, so they are opt-in and switched off again when the tab closes. */
function useMonitor(kind: Kind, state: StationState, run: Run) {
  const on = state.monitors[kind];
  const set = (v: boolean) => run(api("PUT", "/api/monitors", { [kind]: v }));
  useEffect(() => {
    set(true);
    return () => { api("PUT", "/api/monitors", { [kind]: false }).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { on, set };
}

const age = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function MonitorSwitch({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
}

export function RailComTab({ state, run }: { state: StationState; run: Run }) {
  const { on, set } = useMonitor("railcom", state, run);
  const now = useNow();
  return (
    <section>
      <div className="row">
        <MonitorSwitch on={on} set={set} label="RailCom-Mitschnitt aktiv" />
        <button onClick={() => run(api("POST", "/api/railcom/poll", { addr: 0 }))}>Nächste Lok abfragen</button>
      </div>
      <p className="hint">
        Zeigt, was die Zentrale per RailCom von Decodern empfängt. Geschwindigkeit und QoS liefern nur Decoder, die das unterstützen
        (Z21 ab Firmware 1.29; „RailCom“ muss in den Z21-Einstellungen aktiv sein, CV 28/29 passend gesetzt).
      </p>
      {state.railcom.length === 0 ? <p>Noch keine RailCom-Daten empfangen.</p> : (
        <table className="grid">
          <thead><tr><th>Lok</th><th>Geschw.</th><th>QoS</th><th>Empfangen</th><th>Fehler</th><th>Fehlerrate</th><th>Zuletzt</th></tr></thead>
          <tbody>
            {state.railcom.map((r) => (
              <tr key={r.address}>
                <td>{r.address}</td>
                <td>{r.speed ?? "–"}</td>
                <td>{r.qos ?? "–"}</td>
                <td>{r.receiveCounter}</td>
                <td>{r.errorCounter}</td>
                <td>{r.receiveCounter ? `${((r.errorCounter / r.receiveCounter) * 100).toFixed(1)} %` : "–"}</td>
                <td>{age(r.ts, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const DIR = { rx: "← Bus", tx: "→ Bus", lan: "↔ LAN" } as const;

function parseHex(text: string): number[] | undefined {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const bytes = parts.map((p) => Number.parseInt(p.replace(/^0x/i, ""), 16));
  return bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255) ? undefined : bytes;
}

export function LocoNetTab({ state, lines, clear, run }: { state: StationState; lines: LocoNetLine[]; clear: () => void; run: Run }) {
  const { on, set } = useMonitor("loconet", state, run);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LocoNetLine[]>([]);
  const [hex, setHex] = useState("83");
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => { if (!paused) setFrozen(lines); }, [lines, paused]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (paused ? frozen : lines).filter((l) => !f || l.decoded.opcode.toLowerCase().includes(f) || l.decoded.text.toLowerCase().includes(f));
  }, [lines, frozen, paused, filter]);
  useEffect(() => { if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown, paused]);

  const bytes = parseHex(hex);
  const send = () => {
    if (!bytes) return;
    if (!window.confirm(`Diese Nachricht wird auf den LocoNet-Bus der Anlage geschrieben:\n\n${bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ")}\n\nFortfahren?`)) return;
    run(api("POST", "/api/loconet/send", { bytes }));
  };

  return (
    <section>
      <div className="row">
        <MonitorSwitch on={on} set={set} label="LocoNet-Mitschnitt aktiv" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter (z. B. SW_REQ, turnout 12)" />
        <button onClick={() => setPaused((p) => !p)}>{paused ? "Weiter" : "Pause"}</button>
        <button onClick={clear}>Leeren</button>
      </div>
      <pre className="log tall" ref={box}>
        {shown.map((l, i) => (
          <div key={i} className={l.decoded.checksumOk ? "" : "bad-line"}>
            {new Date(l.ts).toLocaleTimeString()} {DIR[l.direction]}  {l.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(36)}
            {l.decoded.opcode.padEnd(16)} {l.decoded.text}{l.decoded.checksumOk ? "" : "  [Prüfsumme falsch]"}
          </div>
        ))}
      </pre>
      <details>
        <summary>Rohnachricht senden</summary>
        <div className="row">
          <input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="Hex-Bytes ohne Prüfsumme, z. B. 83" className={bytes ? "" : "invalid"} />
          <button className="danger" disabled={!bytes} onClick={send}>Auf LocoNet senden</button>
        </div>
        <p className="hint">Die Prüfsumme wird automatisch ergänzt. Die Nachricht gelangt direkt auf den Bus der Anlage (z. B. 83 = Gleisspannung ein).</p>
      </details>
    </section>
  );
}

export function DetectorsTab({ state, run }: { state: StationState; run: Run }) {
  const { on, set } = useMonitor("detectors", state, run);
  const now = useNow();
  const [report, setReport] = useState(1017);
  const poll = (kind: string, reportAddress?: number) => run(api("POST", "/api/detectors/poll", { kind, reportAddress }));
  return (
    <section>
      <div className="row">
        <MonitorSwitch on={on} set={set} label="Meldungen empfangen" />
        <button onClick={() => poll("sic")}>LocoNet abfragen (SIC)</button>
        <label>Report-Adresse <input type="number" min={1} value={report} onChange={(e) => setReport(Number(e.target.value))} /></label>
        <button onClick={() => poll("report", report)}>Uhlenbrock abfragen</button>
        <button onClick={() => poll("can")}>CAN-Melder abfragen</button>
      </div>

      <h2>LocoNet-Gleisbesetztmelder</h2>
      {state.loconetDetectors.length === 0 ? <p>Noch keine Meldungen. Abfragen oder auf Zustandswechsel warten.</p> : (
        <table className="grid">
          <thead><tr><th>Melderadresse</th><th>Zustand</th><th>Lok (Transponder/RailCom)</th><th>Zuletzt</th></tr></thead>
          <tbody>
            {state.loconetDetectors.map((d) => (
              <tr key={d.feedbackAddress}>
                <td>{d.feedbackAddress}</td>
                <td><span className={`cell ${d.occupied ? "busy" : "free"}`}>{d.occupied ? "besetzt" : "frei"}</span></td>
                <td>{d.locoAddress ?? "–"}{d.forward === undefined ? "" : d.forward ? " →" : " ←"}</td>
                <td>{age(d.ts, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>CAN-Melder (10808)</h2>
      {state.canDetectors.length === 0 ? <p>Keine CAN-Melder gemeldet (Z21 ab Firmware 1.30).</p> : state.canDetectors.map((m) => (
        <div key={m.nid} className="module">
          <strong>NID 0x{m.nid.toString(16).toUpperCase()}</strong> · Modul-Adresse {m.moduleAddress} · {age(m.ts, now)}
          <div className="ports">
            {m.ports.map((p) => (
              <div key={p.port} className={`cell ${p.overload ? "over" : p.occupied ? "busy" : "free"}`} title={p.voltage ? "Spannung vorhanden" : "keine Spannung"}>
                <small>Port {p.port}</small>
                <b>{p.overload ? `Überlast ${p.overload}` : p.occupied ? "besetzt" : "frei"}</b>
                {p.locos.map((l) => <span key={l.address}>{l.address}{l.direction === "forward" ? " →" : l.direction === "backward" ? " ←" : ""}</span>)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
