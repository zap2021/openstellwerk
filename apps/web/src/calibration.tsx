import { useState } from "react";
import { api, type Calibration, type MeasureView, type StationState } from "./api";
import { ifSure } from "./confirm";

type Run = (p: Promise<unknown>) => Promise<void>;

/** Geschwindigkeit bei einer Fahrstufe (cm/s); Spiegel von apps/server/src/calibration.ts. */
export function cmPerSec(cal: Calibration | undefined, step: number): number | undefined {
  if (!cal?.points.length) return undefined;
  if (step <= 0) return 0;
  const pts = [{ step: 0, cmPerSec: 0 }, ...cal.points];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (step <= b.step || i === pts.length - 1) return Math.max(0, a.cmPerSec + ((b.cmPerSec - a.cmPerSec) * (step - a.step)) / (b.step - a.step));
  }
  return undefined;
}

/** Vorbildgeschwindigkeit in km/h (gerundet auf ganze km/h). */
export function kmh(cal: Calibration | undefined, step: number): number | undefined {
  const v = cmPerSec(cal, step);
  return v === undefined ? undefined : Math.round(v * cal!.scale * 0.036);
}

/** "20, 40,60" → [20, 40, 60]; undefined bei ungültiger Eingabe. */
export function parseSteps(text: string): number[] | undefined {
  const parts = text.split(/[\s,;]+/).filter(Boolean).map(Number);
  return parts.length >= 1 && parts.length <= 20 && parts.every((n) => Number.isInteger(n) && n >= 1 && n <= 126) ? parts : undefined;
}

const PHASE: Record<NonNullable<MeasureView["phase"]>, string> = {
  approach: "fährt zum Startmelder", measure: "misst", settle: "hält", return: "fährt zurück", runout: "fährt aus der Messstrecke",
};

/** Einmessen: Geschwindigkeit je Fahrstufe über zwei Rückmelder messen und als Kennlinie speichern. */
export function CalibrationPage({ state, run }: { state: StationState; run: Run }) {
  const blocks = state.layout?.blocks ?? [];
  const [address, setAddress] = useState(0);
  const [startBlockId, setStart] = useState("");
  const [endBlockId, setEnd] = useState("");
  const [distance, setDistance] = useState("100");
  const [steps, setSteps] = useState("20, 40, 60, 80, 100");
  const [returnStep, setReturnStep] = useState(40);
  const [scale, setScale] = useState(87);
  const [forward, setForward] = useState(true);
  const [error, setError] = useState<string>();
  const tables = state.calibration?.tables ?? {};
  const measure = state.calibration?.run;

  const change = async (request: Promise<unknown>) => {
    setError(undefined);
    await run(request.then(() => undefined, (e) => { setError((e as Error).message); }));
  };
  const distanceCm = Number(distance.replace(",", "."));
  const stepList = parseSteps(steps);
  const problem = !(address >= 1 && address <= 9999) ? "Lok wählen"
    : !startBlockId || !endBlockId ? "Start- und Zielmelder wählen"
    : startBlockId === endBlockId ? "Start- und Zielmelder müssen verschieden sein"
    : !(distanceCm >= 5 && distanceCm <= 5000) ? "Strecke 5–5000 cm eingeben"
    : !stepList ? "Fahrstufen als Zahlen 1–126 eingeben, durch Komma getrennt"
    : undefined;
  const name = (addr: string | number) => { const g = state.garage.find((x) => x.address === Number(addr)); return `Lok ${addr}${g?.name ? ` – ${g.name}` : ""}`; };

  return (
    <section>
      <div className="panel">
        <div className="head"><h2>Einmessen</h2></div>
        <p className="hint">
          Die Lok fährt mit fester Fahrstufe über eine Messstrecke: gemessen wird die Zeit vom Belegen des Startblocks bis zum Belegen des Zielblocks.
          Stelle die Lok <strong>vor</strong> den Startblock, beide Blöcke müssen frei sein. Nach jeder Messung fährt die Lok selbst zurück vor die Messstrecke.
          Achte auf genug freies Gleis vor und hinter der Strecke; „Abbrechen“ hält die Lok sofort an.
        </p>
        {blocks.length < 2 && <p className="hint warn">Zum Einmessen braucht das Gleisbild zwei Blöcke mit Meldern.</p>}
        <div className="form">
          <label>Lok
            <select value={address || ""} onChange={(e) => setAddress(Number(e.target.value))}>
              <option value="">– wählen –</option>
              {state.garage.map((g) => <option key={g.address} value={g.address}>{g.address}{g.name ? ` – ${g.name}` : ""}</option>)}
            </select>
          </label>
          <label>Richtung der Messfahrt
            <select value={forward ? "f" : "r"} onChange={(e) => setForward(e.target.value === "f")}><option value="f">vorwärts</option><option value="r">rückwärts</option></select>
          </label>
          <label>Startblock (wird zuerst belegt)
            <select value={startBlockId} onChange={(e) => setStart(e.target.value)}>
              <option value="">– wählen –</option>
              {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label>Zielblock
            <select value={endBlockId} onChange={(e) => setEnd(e.target.value)}>
              <option value="">– wählen –</option>
              {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label>Strecke zwischen den Block-Anfängen (cm) <input value={distance} onChange={(e) => setDistance(e.target.value)} /></label>
          <label>Maßstab 1: <input type="number" min={1} max={1000} value={scale} onChange={(e) => setScale(Number(e.target.value))} /></label>
          <label className="wide">Fahrstufen <input value={steps} onChange={(e) => setSteps(e.target.value)} /></label>
          <label>Fahrstufe der Rückfahrt <input type="number" min={1} max={126} value={returnStep} onChange={(e) => setReturnStep(Number(e.target.value))} /></label>
        </div>
        {problem && <p className="hint">{problem}</p>}
        {error && <p className="hint warn">{error}</p>}
        <div className="row tight">
          <button className="active" disabled={!!problem || !!measure?.running || !state.connected}
            onClick={() => void change(api("POST", "/api/calibration/run", { address, startBlockId, endBlockId, distanceCm, steps: stepList, forward, scale, returnStep }))}>Messreihe starten</button>
          <button className="danger" disabled={!measure?.running} onClick={() => void change(api("POST", "/api/calibration/stop"))}>Abbrechen (Lok hält)</button>
        </div>
        {measure && (
          <p className={`hint${measure.error ? " warn" : ""}`}>
            {name(measure.address)}: {measure.running ? `Fahrstufe ${measure.steps[measure.index]} (${measure.index + 1}/${measure.steps.length}), ${measure.phase ? PHASE[measure.phase] : ""}` : measure.error ? `abgebrochen – ${measure.error}` : "Messreihe abgeschlossen"}
            {measure.results.length > 0 && ` · gemessen: ${measure.results.map((p) => `${p.step} → ${p.cmPerSec} cm/s`).join(", ")}`}
          </p>
        )}
      </div>
      <div className="panel">
        <div className="head"><h2>Kennlinien</h2></div>
        {Object.keys(tables).length === 0 && <p className="hint">Noch keine Lok eingemessen.</p>}
        {Object.entries(tables).map(([addr, cal]) => (
          <div className="automation" key={addr}>
            <div className="row tight">
              <strong>{name(addr)}</strong>
              <span className="hint">Maßstab 1:{cal.scale}</span>
              <button type="button" className="x" title="Kennlinie löschen" onClick={() => ifSure(`Kennlinie von Lok ${addr} löschen?`, () => void change(api("DELETE", `/api/calibration/${addr}`)))}>×</button>
            </div>
            <table className="speed-table">
              <thead><tr><th>Fahrstufe</th>{cal.points.map((p) => <th key={p.step}>{p.step}</th>)}</tr></thead>
              <tbody>
                <tr><td>cm/s</td>{cal.points.map((p) => <td key={p.step}>{p.cmPerSec}</td>)}</tr>
                <tr><td>km/h</td>{cal.points.map((p) => <td key={p.step}>{kmh(cal, p.step)}</td>)}</tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
