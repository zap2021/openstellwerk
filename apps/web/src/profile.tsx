import { useEffect, useState } from "react";
import { api, type AchievementView, type SessionUser, type StationState } from "./api";

type Run = (p: Promise<unknown>) => Promise<void>;

/** Eigenes Profil: Anzeigename, Passwort ändern, eigene Erfolge und Rangliste. */
export function ProfilePage({ user, state, run, done }: { user: SessionUser; state?: StationState; run: Run; done: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [mine, setMine] = useState<AchievementView>();
  const [info, setInfo] = useState<string>();
  // reload when the layout's achievements change (seq) so that the page stays current
  useEffect(() => { api<AchievementView>("GET", "/api/achievements/me").then(setMine, () => undefined); }, [state?.achievements?.seq, state?.achievements?.score]);
  const view = mine;
  return (
    <section>
      <div className="panel">
        <h2>Profil – {user.name}</h2>
        <div className="row tight">
          <label>Anzeigename <input value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} /></label>
          <button disabled={!displayName.trim() || displayName.trim() === user.displayName}
            onClick={() => run(api("PUT", "/api/me", { displayName }).then(() => { setInfo("Anzeigename gespeichert"); done(); }))}>Speichern</button>
        </div>
        <h3>Passwort ändern</h3>
        <div className="row tight">
          <input type="password" placeholder="bisheriges Passwort" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          <input type="password" placeholder="neues Passwort" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <button disabled={!current || !password}
            onClick={() => run(api("POST", "/api/me/password", { current, password }).then(() => { setCurrent(""); setPassword(""); setInfo("Passwort geändert; andere Geräte müssen sich neu anmelden"); }))}>Ändern</button>
        </div>
        {info && <p className="hint">{info}</p>}
      </div>
      {view && (
        <div className="panel">
          <h2>Meine Erfolge</h2>
          <p className="hint"><strong>{view.score}</strong> von {view.maxScore} Punkten · {view.stats.starts}× angefahren · {view.stats.stops}× angehalten · {view.stats.estops}× Nothalt</p>
          <ul className="achievements">
            {view.items.map((i) => (
              <li key={i.id} className={i.unlockedAt ? "done" : ""}>
                <strong>{i.unlockedAt ? "🏆 " : ""}{i.title}</strong> <small>{i.points} Punkte</small>
                <div className="muted">{i.text}</div>
                <progress max={i.goal} value={i.progress} /> <small>{i.progress}/{i.goal}</small>
              </li>
            ))}
          </ul>
          {view.ranking.length > 0 && (<>
            <h3>Rangliste</h3>
            <ol>{view.ranking.map((r) => <li key={r.userId}>{r.name} – {r.score} Punkte{r.userId === user.id ? " (du)" : ""}</li>)}</ol>
          </>)}
        </div>
      )}
    </section>
  );
}
