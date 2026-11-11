import { useCallback, useEffect, useState } from "react";
import { formatHHMM, parseHHMM, type Train, type Trip } from "@z21/timetable";
import type { Route } from "@z21/protocol/layout";
import { api, type StationState } from "./api";
import { ifSure } from "./confirm";

type Run = (p: Promise<unknown>) => Promise<void>;

export interface Row { id: string; time: string; trainName: string; routeName: string; repeatText?: string; invalid: boolean }

/** Display rows of the timetable; a trip whose train or route no longer exists is `invalid`. */
export function tripRows(trips: Trip[], trains: Train[], routes: Route[]): Row[] {
  return trips.map((t) => {
    const train = trains.find((x) => x.id === t.trainId);
    const route = routes.find((x) => x.id === t.routeId);
    return {
      id: t.id,
      time: formatHHMM(t.departure),
      trainName: train?.name ?? "?",
      routeName: route?.name ?? "?",
      repeatText: t.repeat ? `alle ${t.repeat.every} min bis ${formatHHMM(t.repeat.until)}` : undefined,
      invalid: !train || !route,
    };
  });
}

interface Draft { id?: string; trainId: string; routeId: string; departure: string; dwell: number; destination: string; repeat: boolean; every: number; until: string }
const EMPTY: Draft = { trainId: "", routeId: "", departure: "08:00", dwell: 2, destination: "", repeat: false, every: 30, until: "20:00" };

function toDraft(t: Trip): Draft {
  return {
    id: t.id, trainId: t.trainId, routeId: t.routeId, departure: formatHHMM(t.departure), dwell: t.dwell, destination: t.destination ?? "",
    repeat: !!t.repeat, every: t.repeat?.every ?? 30, until: t.repeat ? formatHHMM(t.repeat.until) : "20:00",
  };
}

/** Administration of the timetable: trips table, trip form and the late limit. */
export function TimetableAdmin({ state, run }: { state: StationState; run: Run }) {
  const [data, setData] = useState<{ trips: Trip[]; lateLimit: number }>();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [limit, setLimit] = useState(5);
  const [error, setError] = useState<string>();
  const trains = state.timetable?.trains ?? [];
  const routes = state.layout?.routes ?? [];
  const usable = routes.filter((r) => r.from || r.to);

  const load = useCallback(() => api<{ trips: Trip[]; lateLimit: number }>("GET", "/api/timetable").then((d) => { setData(d); setLimit(d.lateLimit); }), []);
  useEffect(() => { void load().catch((e) => setError((e as Error).message)); }, [load]);

  if (!state.timetable) return <p className="hint">Der Fahrplan ist noch nicht verfügbar (Server zu alt oder noch nicht bereit).</p>;

  /** Runs the request, reloads the trips and shows a server error next to the form; resolves to whether it succeeded. */
  const change = async (request: () => Promise<unknown>): Promise<boolean> => {
    let ok = false;
    setError(undefined);
    await run(request().then(load).then(() => { ok = true; }, (e) => { setError((e as Error).message); }));
    return ok;
  };
  const departure = parseHHMM(draft.departure);
  const until = parseHHMM(draft.until);
  const problem = !draft.trainId || !draft.routeId ? "Zug und Fahrstraße wählen"
    : departure === undefined ? "Abfahrt als HH:MM eingeben"
    : draft.repeat && (until === undefined || until < departure) ? "Takt-Ende als HH:MM nach der Abfahrt eingeben"
    : draft.repeat && draft.every < 1 ? "Takt mindestens 1 min" : undefined;

  const save = () => {
    if (problem || departure === undefined) return;
    const body = {
      trainId: draft.trainId, routeId: draft.routeId, departure, dwell: draft.dwell,
      destination: draft.destination.trim() || undefined,
      repeat: draft.repeat && until !== undefined ? { every: draft.every, until } : undefined,
    };
    void change(() => (draft.id ? api("PUT", `/api/trips/${draft.id}`, body) : api("POST", "/api/trips", body))).then((ok) => { if (ok) setDraft(EMPTY); });
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const rows = tripRows(data?.trips ?? [], trains, routes);

  return (
    <section className="drive">
      <aside className="panel locos">
        <h2>Fahrten</h2>
        {rows.length === 0 && <p className="hint">Noch keine Fahrten angelegt.</p>}
        <ul className="loco-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button className={`loco-item ${draft.id === r.id ? "active" : ""}`} onClick={() => { const t = data?.trips.find((x) => x.id === r.id); if (t) setDraft(toDraft(t)); }}>
                <span className="addr">{r.time}</span>
                <span className="meta">
                  <strong>{r.trainName} · {r.routeName}</strong>
                  {r.repeatText && <small>{r.repeatText}</small>}
                  {r.invalid && <small className="warn">Zug oder Fahrstraße fehlt</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <h2>Verspätungsgrenze</h2>
        <div className="row tight">
          <label>Minuten <input type="number" min={0} max={240} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
          <button disabled={limit === data?.lateLimit} onClick={() => void change(() => api("PUT", "/api/timetable/settings", { lateLimit: limit }))}>Speichern</button>
        </div>
        <p className="hint">Ab dieser Verspätung wird eine Fahrt als „verspätet“ gemeldet.</p>
      </aside>
      <div className="panel">
        <h2>{draft.id ? "Fahrt bearbeiten" : "Neue Fahrt"}</h2>
        {trains.length === 0 && <p className="hint warn">Zuerst unter „Züge“ einen Zug anlegen.</p>}
        {usable.length === 0 && <p className="hint warn">Keine Fahrstraße mit Start- oder Zielblock vorhanden (Gleisbild bearbeiten).</p>}
        <div className="form">
          <label>Zug
            <select value={draft.trainId} onChange={(e) => set("trainId", e.target.value)}>
              <option value="">– wählen –</option>
              {trains.map((t) => <option key={t.id} value={t.id}>{t.name}{t.number ? ` (${t.number})` : ""}</option>)}
            </select>
          </label>
          <label>Fahrstraße
            <select value={draft.routeId} onChange={(e) => set("routeId", e.target.value)}>
              <option value="">– wählen –</option>
              {usable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              {draft.routeId && !usable.some((r) => r.id === draft.routeId) && <option value={draft.routeId}>(fehlt)</option>}
            </select>
          </label>
          <label>Abfahrt (HH:MM) <input value={draft.departure} placeholder="08:00" onChange={(e) => set("departure", e.target.value)} /></label>
          <label>Halt danach (min) <input type="number" min={0} max={120} value={draft.dwell} onChange={(e) => set("dwell", Number(e.target.value))} /></label>
          <label className="wide">Anzeigetext (Ziel) <input value={draft.destination} placeholder="z. B. Bergstadt" onChange={(e) => set("destination", e.target.value)} /></label>
          <label className="check wide"><input type="checkbox" checked={draft.repeat} onChange={(e) => set("repeat", e.target.checked)} /> Im Takt wiederholen</label>
          {draft.repeat && (
            <>
              <label>Alle (min) <input type="number" min={1} max={1439} value={draft.every} onChange={(e) => set("every", Number(e.target.value))} /></label>
              <label>Bis (HH:MM) <input value={draft.until} placeholder="20:00" onChange={(e) => set("until", e.target.value)} /></label>
            </>
          )}
        </div>
        {problem && <p className="hint">{problem}</p>}
        {error && <p className="hint warn">{error}</p>}
        <div className="row tight">
          <button className="active" disabled={!!problem} onClick={save}>Speichern</button>
          <button onClick={() => { setDraft(EMPTY); setError(undefined); }}>Neu</button>
          {draft.id && <button className="danger" onClick={() => ifSure("Diese Fahrt löschen?", () => void change(() => api("DELETE", `/api/trips/${draft.id}`)).then((ok) => { if (ok) setDraft(EMPTY); }))}>Löschen</button>}
        </div>
      </div>
    </section>
  );
}
