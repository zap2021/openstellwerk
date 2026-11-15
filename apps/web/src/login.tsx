import { useCallback, useEffect, useState } from "react";
import { api, type SessionUser } from "./api";

interface Session { required: boolean; authenticated: boolean; users?: boolean; user?: SessionUser }

export function useSession() {
  const [session, setSession] = useState<Session>();
  const refresh = useCallback(() => {
    // an old server without /api/session, or one that is offline: show the app, it reports "Server offline" itself
    void api<Session>("GET", "/api/session").then(setSession).catch(() => setSession({ required: false, authenticated: true }));
  }, []);
  useEffect(() => {
    refresh();
    const lost = () => setSession((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener("openstellwerk-unauthorized", lost);
    return () => window.removeEventListener("openstellwerk-unauthorized", lost);
  }, [refresh]);
  const logout = () => { void api("POST", "/api/logout").catch(() => undefined).then(refresh); };
  return { known: !!session, required: !!session?.required, usersMode: !!session?.users, user: session?.user, authenticated: !!session?.authenticated, refresh, logout };
}

export function Login({ onDone, usersMode }: { onDone: () => void; usersMode?: boolean }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    api("POST", "/api/login", usersMode ? { name, password } : { password })
      .then(onDone)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>OpenStellwerk</h1>
      {usersMode && <label>Benutzername
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="username" />
      </label>}
      <label>Passwort
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!usersMode} autoComplete="current-password" />
      </label>
      {error && <div className="error">{error}</div>}
      <button className="active" type="submit" disabled={busy || !password || (usersMode && !name.trim())}>Anmelden</button>
      {location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname) && (
        <p className="hint">Die Verbindung ist nicht verschlüsselt (kein HTTPS). Das Passwort ist im Netz mitlesbar.</p>
      )}
    </form>
  );
}
