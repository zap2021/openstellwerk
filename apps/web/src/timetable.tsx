import { useCallback, useEffect, useMemo, useState } from "react";
import { formatHHMM, modelNow, parseHHMM, statusText, timeOfDay, type ClockState, type Instance, type Status, type Train, type Trip } from "@z21/timetable";
import type { Layout, Route } from "@z21/protocol/layout";
import { api, type StationState } from "./api";
import { ifSure } from "./confirm";
import { imageUrl } from "./loco-image";
import { JourneyPanel } from "./journeys";
import { AchievementBanner } from "./achievements";

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

interface Draft { id?: string; trainId: string; routeId: string; departure: string; dwell: number; destination: string; drive: "" | "forward" | "reverse"; repeat: boolean; every: number; until: string }
const EMPTY: Draft = { trainId: "", routeId: "", departure: "08:00", dwell: 2, destination: "", drive: "", repeat: false, every: 30, until: "20:00" };

function toDraft(t: Trip): Draft {
  return {
    id: t.id, trainId: t.trainId, routeId: t.routeId, departure: formatHHMM(t.departure), dwell: t.dwell, destination: t.destination ?? "", drive: t.drive ?? "",
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
      drive: draft.drive || undefined,
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
                  <strong>{r.trainName}, {r.routeName}</strong>
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
          <label className="wide">Lok fahren
            <select value={draft.drive} onChange={(e) => set("drive", e.target.value as Draft["drive"])}>
              <option value="">von Hand (der Server stellt nur die Fahrstraße)</option>
              <option value="forward">Server fährt die Lok vorwärts und hält im Zielblock</option>
              <option value="reverse">Server fährt die Lok rückwärts und hält im Zielblock</option>
            </select>
          </label>
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

// ---------------------------------------------------------------------------------------------------------------
// Operation (tab "Fahrplan") and departure board

/**
 * Model time at browser time `browserNow`, but on the server's clock: `serverNow` was the server time when the
 * snapshot arrived at browser time `receivedAt`. Without `serverNow` the browser clock is used as is.
 */
export function modelNowSkewed(clock: ClockState, browserNow: number, serverNow: number | undefined, receivedAt: number): number {
  return modelNow(clock, serverNow === undefined ? browserNow : browserNow + (serverNow - receivedAt));
}

/**
 * Model time in whole seconds; ticks every second while the clock runs, stays put when it is stopped.
 * `serverNow` (from the snapshot) corrects a browser clock that differs from the server's.
 */
export function useModelTime(clock: ClockState, serverNow?: number): number {
  const [now, setNow] = useState(() => Date.now());
  // offset server − browser, captured whenever a snapshot with a new server time arrives
  const receivedAt = useMemo(() => Date.now(), [serverNow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setNow(Date.now());
    if (!clock.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [clock.running, clock.factor, clock.baseModel, clock.baseReal]);
  return Math.floor(modelNowSkewed(clock, Math.max(now, receivedAt), serverNow, receivedAt));
}

export interface BoardRow {
  /** React key: instance ids repeat from day to day, so the day is part of it. */
  key: string;
  id: string; trainId: string; time: string; number: string; destination: string; platform: string;
  status: Status; label: string; reason?: string;
  /** Loco address and picture version, when the train has a loco picture. */
  address: number; imageVersion?: number;
}

const FINISHED: Status[] = ["done", "failed", "cancelled"];
const KEEP_FINISHED = 3;

/** Rows of the departure board: open departures first-come by due, only the last few finished ones, cut to `limit` (open ones win). */
export function boardRows(instances: Instance[], trips: Trip[], trains: Train[], layout: Layout | undefined, limit: number, images: ReadonlyMap<number, number> = new Map()): BoardRow[] {
  const sorted = [...instances].sort((a, b) => a.day - b.day || a.due - b.due || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows: { row: BoardRow; open: boolean }[] = [];
  for (const i of sorted) {
    const trip = trips.find((t) => t.id === i.tripId);
    const train = trip && trains.find((t) => t.id === trip.trainId);
    if (!trip || !train) continue;
    const route = layout?.routes.find((r) => r.id === trip.routeId);
    const target = route?.to ? (layout?.blocks ?? []).find((b) => b.id === route.to)?.name ?? "" : "";
    rows.push({
      open: !FINISHED.includes(i.status),
      row: {
        key: `${i.day}:${i.id}`, id: i.id, trainId: train.id, time: formatHHMM(Math.floor(i.due / 60)), number: train.number ?? train.name,
        destination: trip.destination ?? target, platform: target, status: i.status, label: statusText(i.status), reason: i.reason,
        address: train.address, imageVersion: images.get(train.address),
      },
    });
  }
  const open = rows.filter((r) => r.open).slice(0, limit);
  const room = Math.min(KEEP_FINISHED, Math.max(0, limit - open.length));
  const finished = room > 0 ? rows.filter((r) => !r.open).slice(-room) : [];
  const keep = new Set([...open, ...finished]);
  return rows.filter((r) => keep.has(r)).map((r) => r.row);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export function formatHMS(model: number): string {
  const t = timeOfDay(model);
  return `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor(t / 60) % 60)}:${pad2(t % 60)}`;
}

/** Loads the trips; the board has no other trigger, so it can refresh them periodically. */
export function useTrips(everyMs?: number): Trip[] {
  const [trips, setTrips] = useState<Trip[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { api<{ trips: Trip[] }>("GET", "/api/timetable").then((d) => { if (alive) setTrips(d.trips); }, () => undefined); };
    load();
    const t = everyMs ? setInterval(load, everyMs) : undefined;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [everyMs]);
  return trips;
}

/** Operation: model clock, the next departures with "cancel", and where the trains stand. */
export function TimetableOperate({ state, run }: { state: StationState; run: Run }) {
  const tt = state.timetable;
  const clock = tt?.clock ?? { running: false, factor: 1, baseModel: 0, baseReal: 0 };
  const model = useModelTime(clock, tt?.serverNow);
  const trips = useTrips();
  const [factor, setFactor] = useState(clock.factor);
  const [time, setTime] = useState("08:00");
  const [error, setError] = useState<string>();
  useEffect(() => setFactor(clock.factor), [clock.factor]);

  if (!tt) return <p className="hint">Der Fahrplan ist noch nicht verfügbar (Server zu alt oder noch nicht bereit).</p>;

  const change = async (request: Promise<unknown>) => {
    setError(undefined);
    await run(request.then(() => undefined, (e) => { setError((e as Error).message); }));
  };
  const layout = state.layout;
  const blocks = layout?.blocks ?? [];
  const rows = boardRows(tt.instances, trips, tt.trains, layout, 12);
  const clockPost = (body: unknown) => change(api("POST", "/api/timetable/clock", body));
  const hhmm = formatHHMM(Math.floor(timeOfDay(model) / 60));
  const factorOk = Number.isInteger(factor) && factor >= 1 && factor <= 120;
  const timeOk = parseHHMM(time) !== undefined;

  return (
    <section className="drive">
      <div className="panel">
        <h2>Fahrplanuhr</h2>
        <div className="clock">
          <span className="big">{formatHMS(model)}</span>
          {clock.factor > 1 && <small>×{clock.factor}</small>}
          {!clock.running && <span className="pill">angehalten</span>}
        </div>
        <div className="row tight">
          <button className={clock.running ? "danger" : "active"} onClick={() => void clockPost({ action: clock.running ? "stop" : "start" })}>{clock.running ? "Stopp" : "Start"}</button>
          <label>Faktor <input type="number" min={1} max={120} value={factor} onChange={(e) => setFactor(Number(e.target.value))} /></label>
          <button disabled={!factorOk} onClick={() => void clockPost({ action: "set", time: hhmm, factor })}>Setzen</button>
        </div>
        <div className="row tight">
          <label>Uhrzeit (HH:MM) <input value={time} placeholder="08:00" onChange={(e) => setTime(e.target.value)} /></label>
          <button disabled={!timeOk} onClick={() => void clockPost({ action: "set", time })}>Uhr stellen</button>
        </div>
        {error && <p className="hint warn">{error}</p>}
        <h2>Nächste Abfahrten</h2>
        {rows.length === 0 && <p className="hint">Keine Abfahrten geplant.</p>}
        <ul className="loco-list">
          {rows.map((r) => (
            <li key={r.key} className="departure">
              <span className="addr">{r.time}</span>
              <span className="meta">
                <strong>{r.number}, {r.destination || "–"}{r.platform ? `, ${r.platform}` : ""}</strong>
                <small><span className={`st ${r.status}`}>{r.label}</span>{r.reason ? ` – ${r.reason}` : ""}</small>
              </span>
              {(r.status === "planned" || r.status === "waiting") && (
                <button onClick={() => void change(api("POST", `/api/timetable/instances/${encodeURIComponent(r.id)}/cancel`))}>Entfallen lassen</button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <JourneyPanel state={state} run={run} />
      <div className="panel">
        <h2>Standorte der Züge</h2>
        {tt.trains.length === 0 && <p className="hint">Noch keine Züge angelegt.</p>}
        <ul className="loco-list">
          {tt.trains.map((t) => (
            <li key={t.id} className="departure">
              <span className="meta"><strong>{t.name}{t.number ? ` (${t.number})` : ""}</strong></span>
              {t.location?.uncertain && <span className="pill warn">unsicher</span>}
              <select value={t.location?.blockId ?? ""} onChange={(e) => void change(api("PUT", `/api/trains/${encodeURIComponent(t.id)}/location`, { blockId: e.target.value || null }))}>
                <option value="">kein Standort</option>
                {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                {t.location && !blocks.some((b) => b.id === t.location!.blockId) && <option value={t.location.blockId}>(fehlt)</option>}
              </select>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Read-only departure board for the display page. */
export function DepartureBoard({ state, trips }: { state: StationState; trips?: Trip[] }) {
  const tt = state.timetable;
  const fetched = useTrips(trips ? undefined : 60_000);
  if (!tt) return null;
  const all = trips ?? fetched;
  const images = new Map(state.garage.flatMap((g) => (g.imageVersion ? [[g.address, g.imageVersion] as const] : [])));
  const rows = boardRows(tt.instances, all, tt.trains, state.layout, 8, images);
  return (
    <>
    <AchievementBanner view={state.achievements} />
    <table className="board">
      <thead><tr><th>Zeit</th><th>Zug</th><th>Ziel</th><th>Gleis</th><th>Status</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={5} className="muted">Keine Abfahrten</td></tr>}
        {rows.map((r) => (
          <tr key={r.key} className={FINISHED.includes(r.status) ? "past" : undefined}>
            <td className="time">{r.time}</td>
            <td>{r.imageVersion ? <img className="board-pic" src={imageUrl(r.address, r.imageVersion)} alt="" /> : null}{r.number}</td><td>{r.destination}</td><td>{r.platform}</td>
            <td><span className={`st ${r.status}`}>{r.label}</span>{r.reason && <small className="reason"> {r.reason}</small>}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}
