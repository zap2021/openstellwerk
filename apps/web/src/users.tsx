import { useCallback, useEffect, useState } from "react";
import { api, type SessionUser } from "./api";
import { ifSure } from "./confirm";

type Run = (p: Promise<unknown>) => Promise<void>;

/** Verwaltung → Benutzer: anlegen, Rolle ändern, sperren, Passwort setzen, löschen. */
export function UsersPage({ me, run }: { me?: SessionUser; run: Run }) {
  const [list, setList] = useState<SessionUser[]>([]);
  const [draft, setDraft] = useState({ name: "", displayName: "", role: "user", password: "" });
  const load = useCallback(() => { api<SessionUser[]>("GET", "/api/users").then(setList, () => undefined); }, []);
  useEffect(load, [load]);
  const act = (p: Promise<unknown>) => run(p.then(load));

  return (
    <section>
      <p className="hint">Zwei Rollen: <strong>Benutzer</strong> fahren, schalten, rufen Fahrstraßen ab und sehen den Fahrplan; <strong>Admin</strong> darf zusätzlich alles in der Verwaltung. Der letzte aktive Admin lässt sich nicht löschen, sperren oder herabstufen.</p>
      <div className="panel">
        <h2>Benutzer</h2>
        <table className="board small">
          <thead><tr><th>Name</th><th>Anzeigename</th><th>Rolle</th><th>Konto</th><th /></tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <td>{u.name}{u.id === me?.id ? " (du)" : ""}</td>
                <td>{u.displayName}</td>
                <td>
                  <select value={u.role} onChange={(e) => act(api("PUT", `/api/users/${u.id}`, { role: e.target.value }))}>
                    <option value="user">Benutzer</option><option value="admin">Admin</option>
                  </select>
                </td>
                <td><button onClick={() => act(api("PUT", `/api/users/${u.id}`, { active: !u.active }))}>{u.active ? "aktiv – sperren" : "gesperrt – freigeben"}</button></td>
                <td className="row tight">
                  <button onClick={() => {
                    const pw = window.prompt(`Neues Passwort für ${u.name} (mindestens 8 Zeichen):`);
                    if (pw) void act(api("POST", `/api/users/${u.id}/password`, { password: pw }));
                  }}>Passwort setzen</button>
                  {u.id !== me?.id && <button className="danger" onClick={() => ifSure(`Benutzer ${u.name} löschen?`, () => act(api("DELETE", `/api/users/${u.id}`)))}>Löschen</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <p className="hint">Noch keine Benutzer. Das erste Konto wird immer Admin; danach ist die Anmeldung mit Name und Passwort Pflicht.</p>}
      </div>
      <form className="panel" onSubmit={(e) => {
        e.preventDefault();
        void act(api("POST", "/api/users", draft).then(() => setDraft({ name: "", displayName: "", role: "user", password: "" })));
      }}>
        <h2>Neuer Benutzer</h2>
        <div className="row tight">
          <input placeholder="Anmeldename" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoComplete="off" />
          <input placeholder="Anzeigename (optional)" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
          <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}><option value="user">Benutzer</option><option value="admin">Admin</option></select>
          <input type="password" placeholder="Passwort (min. 8 Zeichen)" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} autoComplete="new-password" />
          <button type="submit" className="active" disabled={!draft.name.trim() || draft.password.length < 8}>Anlegen</button>
        </div>
      </form>
    </section>
  );
}
