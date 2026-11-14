import { useEffect, useState } from "react";
import { api, type StationState } from "./api";
import { ifSure } from "./confirm";

type Run = (p: Promise<unknown>) => Promise<void>;

/** Spiegel von apps/server/src/update.ts. */
export interface UpdateView {
  current: string; latest?: string; notes?: string; available: boolean; checkedAt?: number; error?: string;
  phase: "idle" | "downloading" | "installing" | "building" | "testing" | "switching" | "restarting" | "failed";
  log: string[]; blocked?: string; lastUpdate?: { from: string; to: string; at: number };
}
/** Spiegel von apps/server/src/history.ts. */
export interface HistoryEvent { ts: number; kind: string; text: string; ok: boolean }

const KIND: Record<string, string> = {
  verbindung: "Verbindung", fahrstrasse: "Fahrstraße", zielfahrt: "Zielfahrt", fahrautomat: "Fahrautomat", regel: "Regel",
  fahrplan: "Fahrplan", einmessen: "Einmessen", update: "Update", system: "System",
};
const dateTime = (ts: number) => new Date(ts).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** true, solange eine Installation läuft (dann wird der Stand oft abgefragt). */
export const updateBusy = (v?: UpdateView) => !!v && v.phase !== "idle" && v.phase !== "failed";

/** Update: installierte und neueste Version, Installation mit Fortschritt. */
export function UpdatePage({ run }: { run: Run }) {
  const [view, setView] = useState<UpdateView>();
  const [error, setError] = useState<string>();
  const load = () => api<UpdateView>("GET", "/api/update").then(setView, () => undefined); // during the restart the server is away
  useEffect(() => { void load(); }, []);
  const busy = updateBusy(view);
  useEffect(() => { const h = setInterval(() => { void load(); }, busy ? 2000 : 15_000); return () => clearInterval(h); }, [busy]);
  // The new version answers again: load its page instead of the old one in the browser.
  useEffect(() => { if (view?.phase === "restarting") { const h = setInterval(() => { void fetch("/api/session").then((r) => { if (r.ok) window.location.reload(); }, () => undefined); }, 4000); return () => clearInterval(h); } }, [view?.phase]);

  const act = async (request: Promise<UpdateView>) => {
    setError(undefined);
    await run(request.then(setView, (e) => { setError((e as Error).message); }));
  };
  if (!view) return <p className="hint">Lade …</p>;
  return (
    <div className="panel">
      <div className="head">
        <h2>Update</h2>
        <button type="button" disabled={busy} onClick={() => void act(api<UpdateView>("POST", "/api/update/check"))}>Jetzt prüfen</button>
      </div>
      <p>
        Installiert: <strong>v{view.current}</strong>
        {view.latest && <> · Neueste Version: <strong>v{view.latest}</strong></>}
        {view.checkedAt && <span className="hint"> (geprüft {dateTime(view.checkedAt)})</span>}
      </p>
      {view.lastUpdate && <p className="hint">Letztes Update: von v{view.lastUpdate.from} auf v{view.lastUpdate.to} am {dateTime(view.lastUpdate.at)}.</p>}
      {view.error && <p className="hint warn">{view.error}</p>}
      {!view.error && view.latest && !view.available && <p className="hint">Die Installation ist auf dem neuesten Stand.</p>}
      {view.available && (
        <>
          {view.notes && <pre className="release-notes">{view.notes}</pre>}
          {view.blocked && <p className="hint warn">Gerade nicht möglich: {view.blocked}.</p>}
          <p className="hint">
            Das Update lädt die neue Version, baut sie, startet sie zur Probe und spielt sie erst dann ein. Das dauert auf einem Raspberry Pi einige Minuten;
            am Ende startet der Server neu und die Verbindung zur Zentrale wird kurz getrennt. Deine Daten bleiben unberührt, lade trotzdem vorher eine Datensicherung herunter.
          </p>
          <div className="row tight">
            <button type="button" className="active" disabled={busy || !!view.blocked}
              onClick={() => ifSure(`Jetzt auf v${view.latest} aktualisieren? Der Server startet am Ende neu.`, () => void act(api<UpdateView>("POST", "/api/update/install")))}>
              Auf v{view.latest} aktualisieren
            </button>
          </div>
        </>
      )}
      {error && <p className="hint warn">{error}</p>}
      {view.log.length > 0 && <ol className={`update-log${view.phase === "failed" ? " failed" : ""}`}>{view.log.map((l, i) => <li key={i}>{l}</li>)}</ol>}
      {view.phase === "restarting" && <p className="hint">Der Server startet neu. Die Seite lädt sich danach selbst neu.</p>}
    </div>
  );
}

/** Verlauf: was die Anlage und der Server getan haben, neueste Einträge zuerst. */
export function HistoryPage({ run }: { run: Run }) {
  const [events, setEvents] = useState<HistoryEvent[]>();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const load = () => api<HistoryEvent[]>("GET", "/api/history?limit=300").then(setEvents, () => undefined);
  useEffect(() => { void load(); const h = setInterval(() => { void load(); }, 3000); return () => clearInterval(h); }, []);
  if (!events) return <p className="hint">Lade …</p>;
  const shown = onlyProblems ? events.filter((e) => !e.ok) : events;
  return (
    <div className="panel">
      <div className="head">
        <h2>Verlauf</h2>
        <label className="check"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> nur Probleme</label>
        <button type="button" disabled={events.length === 0} onClick={() => ifSure("Den Verlauf löschen?", () => run(api("DELETE", "/api/history").then(load)))}>Löschen</button>
      </div>
      <p className="hint">Verbindung, Fahrstraßen, Zielfahrten, Fahrautomat, Regeln, Fahrplan, Einmessen und Updates. Der Server behält die letzten 500 Einträge.</p>
      {shown.length === 0 && <p className="hint">{events.length ? "Keine Probleme im Verlauf." : "Noch keine Einträge."}</p>}
      <table className="history">
        <tbody>
          {shown.map((e, i) => (
            <tr key={`${e.ts}-${i}`} className={e.ok ? "" : "problem"}>
              <td>{dateTime(e.ts)}</td><td>{KIND[e.kind] ?? e.kind}</td><td>{e.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Taster für Abläufe (Regeln mit Auslöser „von Hand“), über allen Bedienseiten. */
export function MacroBar({ state, run }: { state: StationState; run: Run }) {
  const [note, setNote] = useState<{ id: string; text: string; ok: boolean }>();
  const macros = state.macros ?? [];
  if (!macros.length) return null;
  const press = (id: string) => run(
    api<{ results: { text: string; ok: boolean }[] }>("POST", `/api/layout-rules/${encodeURIComponent(id)}/run`).then((s) => {
      const bad = s.results.find((r) => !r.ok);
      setNote({ id, text: bad?.text ?? "ausgelöst", ok: !bad });
    }),
  );
  return (
    <div className="macrobar" role="group" aria-label="Abläufe">
      {macros.map((m) => <button key={m.id} type="button" onClick={() => void press(m.id)} title="Ablauf auslösen">▶ {m.name}</button>)}
      {note && <span className={`hint${note.ok ? "" : " warn"}`}>{macros.find((m) => m.id === note.id)?.name}: {note.text}</span>}
    </div>
  );
}

/** Vollbild ein/aus (für Tablets und den zweiten Bildschirm); nichts, wenn der Browser es nicht kann. */
export function FullscreenButton() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  if (typeof document === "undefined" || !document.documentElement.requestFullscreen) return null;
  const toggle = () => { void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined); };
  return <button type="button" onClick={toggle} title={on ? "Vollbild beenden" : "Vollbild"} aria-pressed={on}>{on ? "⤡" : "⤢"}</button>;
}
