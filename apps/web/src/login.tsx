import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

interface Session { required: boolean; authenticated: boolean }

export function useSession() {
  const [session, setSession] = useState<Session>();
  const refresh = useCallback(() => {
    // an old server without /api/session, or one that is offline: show the app, it reports "Server offline" itself
    void api<Session>("GET", "/api/session").then(setSession).catch(() => setSession({ required: false, authenticated: true }));
  }, []);
  useEffect(() => {
    refresh();
    const lost = () => setSession((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener("z21-unauthorized", lost);
    return () => window.removeEventListener("z21-unauthorized", lost);
  }, [refresh]);
  const logout = () => { void api("POST", "/api/logout").catch(() => undefined).then(refresh); };
  return { known: !!session, required: !!session?.required, authenticated: !!session?.authenticated, refresh, logout };
}

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    api("POST", "/api/login", { password })
      .then(onDone)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>Z21 Web</h1>
      <label>Passwort
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
      </label>
      {error && <div className="error">{error}</div>}
      <button className="active" type="submit" disabled={busy || !password}>Anmelden</button>
      {location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname) && (
        <p className="hint">Die Verbindung ist nicht verschlüsselt (kein HTTPS). Das Passwort ist im Netz mitlesbar.</p>
      )}
    </form>
  );
}
