import { useEffect, useRef, useState } from "react";
import { api, type AchievementView } from "./api";
import { ifSure } from "./confirm";
import { Fireworks } from "./fireworks";

type Run = (p: Promise<unknown>) => Promise<void>;

export const SHOW_MS = 15_000;

/** Soll eine Einblendung laufen? Der erste gesehene Stand zählt nicht (kein Rückblick nach dem Laden der Seite). */
export function nextAnnouncement(seen: number | undefined, view?: Pick<AchievementView, "seq" | "latest">): { seen: number | undefined; show?: NonNullable<AchievementView["latest"]> } {
  if (!view) return { seen };
  if (seen === undefined) return { seen: view.seq };
  if (view.seq !== seen) return { seen: view.seq, show: view.seq > seen ? view.latest : undefined };
  return { seen };
}

/** Prominent eingeblendeter neuer Erfolg mit Feuerwerk, verschwindet nach einigen Sekunden. Einmal je Seitenaufruf und Erfolg, auf jeder Seite der Anwendung (auch der Abfahrtstafel). */
export function AchievementBanner({ view }: { view?: AchievementView }) {
  const seen = useRef<number>();
  const [shown, setShown] = useState<AchievementView["latest"]>();
  useEffect(() => {
    if (!shown) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setShown(undefined); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [shown]);
  useEffect(() => {
    const r = nextAnnouncement(seen.current, view);
    seen.current = r.seen;
    if (!r.show) return;
    setShown(r.show);
    const t = setTimeout(() => setShown(undefined), SHOW_MS);
    return () => clearTimeout(t);
  }, [view?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  return (
    <>
      <Fireworks key={view?.seq} />
      <div className="achievement-banner" role="status" onClick={() => setShown(undefined)} title="Klicken zum Schließen">
        <span className="trophy" aria-hidden="true">🏆</span>
        <div><strong>{shown.by ? `${shown.by}: ` : ""}Erfolg freigeschaltet: {shown.title}</strong><small>{shown.text} (+{shown.points} Punkte)</small></div>
        <button type="button" className="close" aria-label="Schließen" onClick={() => setShown(undefined)}>×</button>
      </div>
    </>
  );
}

/** Verwaltung: Wertung der Anlage mit Fortschritt und Zurücksetzen. */
export function AchievementsPanel({ view, run }: { view?: AchievementView; run: Run }) {
  const [fallback, setFallback] = useState<AchievementView>();
  useEffect(() => { if (!view) api<AchievementView>("GET", "/api/achievements").then(setFallback, () => undefined); }, [view]);
  const v = view ?? fallback;
  if (!v) return <p className="hint">Wird geladen …</p>;
  return (
    <div className="panel">
      <h2>Erfolge der Anlage</h2>
      <p className="hint"><strong>{v.score}</strong> von {v.maxScore} Punkten, {v.stats.starts}× angefahren, {v.stats.stops}× angehalten, {v.stats.departures} Fahrplanfahrten, {v.stats.estops}× Nothalt</p>
      <ul className="achievements">
        {v.items.map((i) => (
          <li key={i.id} className={i.unlockedAt ? "done" : ""}>
            <strong>{i.unlockedAt ? "🏆 " : ""}{i.title}</strong> <small>{i.points} Punkte</small>
            <div className="muted">{i.text}</div>
            <progress max={i.goal} value={i.progress} /> <small>{i.progress}/{i.goal}{i.unlockedAt ? `, ${new Date(i.unlockedAt).toLocaleDateString("de-DE")}` : ""}</small>
          </li>
        ))}
      </ul>
      {v.ranking.length > 0 && (<>
        <h3>Benutzer</h3>
        <ul className="achievements">
          {v.ranking.map((r) => (
            <li key={r.userId}>
              <strong>{r.name}</strong> <small>{r.score} Punkte</small>{" "}
              <button onClick={() => ifSure(`Erfolge von ${r.name} zurücksetzen?`, () => run(api("POST", "/api/achievements/reset", { userId: r.userId })))}>Zurücksetzen</button>
            </li>
          ))}
        </ul>
      </>)}
      <div className="row">
        <button className="danger" onClick={() => ifSure("Alle Erfolge und Zähler zurücksetzen (Anlage und alle Benutzer)?", () => run(api("POST", "/api/achievements/reset")))}>Alles zurücksetzen</button>
      </div>
    </div>
  );
}
