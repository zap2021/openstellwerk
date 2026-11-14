import { useState } from "react";
import { api, type Journey, type StationState } from "./api";

type Run = (p: Promise<unknown>) => Promise<void>;

const STATUS: Record<Journey["status"], string> = { waiting: "wartet auf Fahrstraße", set: "unterwegs", done: "angekommen", failed: "abgebrochen", cancelled: "abgebrochen" };
const PHASE = { waiting: "wartet auf Signal", driving: "fährt", braking: "bremst im Ziel" } as const;

/** Text zum Stand einer Zielfahrt: Abschnitt, Status und Grund. */
export function journeyText(j: Journey, routeName: (id: string) => string): string {
  const leg = j.routeIds.length > 1 && (j.status === "waiting" || j.status === "set") ? `Abschnitt ${j.leg + 1}/${j.routeIds.length} („${routeName(j.routeIds[j.leg]!)}“): ` : "";
  return `${leg}${STATUS[j.status]}${j.reason ? ` – ${j.reason}` : ""}`;
}

/** Zielfahrt: Zug und Zielblock wählen; der Server stellt die Fahrstraßen und fährt auf Wunsch die Lok. */
export function JourneyPanel({ state, run }: { state: StationState; run: Run }) {
  const [trainId, setTrainId] = useState("");
  const [target, setTarget] = useState("");
  const [drive, setDrive] = useState<"" | "forward" | "reverse">("");
  const [error, setError] = useState<string>();
  const trains = state.timetable?.trains ?? [];
  const layout = state.layout;
  const blocks = layout?.blocks ?? [];
  if (!trains.length || !blocks.length) return null;

  const change = async (request: Promise<unknown>) => {
    setError(undefined);
    await run(request.then(() => undefined, (e) => { setError((e as Error).message); }));
  };
  const trainName = (id: string) => { const t = trains.find((x) => x.id === id); return t ? `${t.name}${t.number ? ` (${t.number})` : ""}` : "(Zug fehlt)"; };
  const blockName = (id: string) => blocks.find((b) => b.id === id)?.name ?? "(Block fehlt)";
  const routeName = (id: string) => layout?.routes.find((r) => r.id === id)?.name ?? id;
  const train = trains.find((t) => t.id === trainId);
  const journeys = state.journeys ?? [];
  const jobs = state.autoDrive?.jobs ?? [];
  const results = (state.autoDrive?.results ?? []).filter((r) => !jobs.some((j) => j.trainId === r.trainId));

  return (
    <div className="panel">
      <h2>Zielfahrt</h2>
      <p className="hint">Zug und Ziel wählen: Der Server sucht die Fahrstraßen dorthin und stellt sie nacheinander. Auf Wunsch fährt er auch die Lok und hält im Zielblock.</p>
      <div className="form">
        <label>Zug
          <select value={trainId} onChange={(e) => setTrainId(e.target.value)}>
            <option value="">– wählen –</option>
            {trains.map((t) => <option key={t.id} value={t.id}>{trainName(t.id)}{t.location ? ` · ${blockName(t.location.blockId)}` : " · kein Standort"}</option>)}
          </select>
        </label>
        <label>Ziel
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">– wählen –</option>
            {blocks.filter((b) => b.id !== train?.location?.blockId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="wide">Lok fahren
          <select value={drive} onChange={(e) => setDrive(e.target.value as typeof drive)}>
            <option value="">von Hand (der Server stellt nur die Fahrstraßen)</option>
            <option value="forward">Server fährt die Lok vorwärts</option>
            <option value="reverse">Server fährt die Lok rückwärts</option>
          </select>
        </label>
      </div>
      {train?.location?.uncertain && <p className="hint warn">Der Standort dieses Zugs ist unsicher. Bestätige ihn unten unter „Standorte der Züge“.</p>}
      {error && <p className="hint warn">{error}</p>}
      <div className="row tight">
        <button className="active" disabled={!trainId || !target} onClick={() => void change(api("POST", "/api/journeys", { trainId, targetBlockId: target, drive: drive || undefined }))}>Fahrt starten</button>
      </div>
      {journeys.length > 0 && (
        <ul className="loco-list">
          {journeys.map((j) => {
            const job = jobs.find((x) => x.trainId === j.trainId);
            const open = j.status === "waiting" || j.status === "set";
            return (
              <li key={j.id} className="departure">
                <span className="meta">
                  <strong>{trainName(j.trainId)} → {blockName(j.targetBlockId)}</strong>
                  <small className={j.status === "failed" ? "warn" : ""}>{journeyText(j, routeName)}{job ? ` · Lok ${PHASE[job.phase]}` : ""}</small>
                </span>
                {open && <button onClick={() => void change(api("POST", `/api/journeys/${j.id}/cancel`))}>Abbrechen</button>}
              </li>
            );
          })}
        </ul>
      )}
      {results.map((r) => <p key={r.trainId} className={`hint${r.ok ? "" : " warn"}`}>{trainName(r.trainId)}: {r.text}</p>)}
    </div>
  );
}
