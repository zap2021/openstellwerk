import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Camera } from "./api";
import { sure } from "./confirm";

type Run = (p: Promise<unknown>) => Promise<void>;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? undefined; } catch { return undefined; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function useCameras() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const reload = useCallback(() => api<Camera[]>("GET", "/api/cameras").then(setCameras).catch(() => undefined), []);
  useEffect(() => { void reload(); }, [reload]);
  return { cameras, reload };
}

/** Shows one camera. The server proxies the image so credentials never reach the browser. */
export function CameraView({ cam }: { cam: Camera }) {
  const [src, setSrc] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const busy = useRef(false);

  const feed = `/api/camera/${cam.id}/feed`;
  const explain = () => {
    // An <img> error carries no reason; ask the proxy once and show its message.
    const ctl = new AbortController();
    fetch(feed, { signal: ctl.signal })
      .then(async (r) => { setProblem(r.ok ? "Bild konnte nicht dargestellt werden" : ((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`)); ctl.abort(); })
      .catch(() => setProblem("Kamera nicht erreichbar"));
  };

  useEffect(() => {
    setProblem(undefined);
    if (cam.kind === "mjpeg") { setSrc(`${feed}?n=${nonce}`); return; }
    if (cam.kind !== "snapshot") return;
    let alive = true;
    const tick = () => {
      if (busy.current) return;
      busy.current = true;
      const img = new Image();
      const url = `${feed}?t=${Date.now()}`;
      img.onload = () => { busy.current = false; if (alive) { setSrc(url); setProblem(undefined); } };
      img.onerror = () => { busy.current = false; if (alive) { setSrc(undefined); explain(); } };
      img.src = url;
    };
    tick();
    const t = window.setInterval(tick, cam.refreshMs ?? 1000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam.id, cam.kind, cam.url, cam.refreshMs, nonce]);

  return (
    <div className="camview">
      {cam.kind === "iframe"
        ? <iframe src={cam.url} title={cam.name} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" />
        : problem
          ? <div className="cam-problem">{problem}<br /><button onClick={() => setNonce((n) => n + 1)}>Erneut versuchen</button></div>
          : src && <img src={src} alt={cam.name} onError={() => { setSrc(undefined); explain(); }} />}
    </div>
  );
}

const EMPTY = { name: "", kind: "mjpeg" as Camera["kind"], url: "", username: "", password: "", refreshMs: 1000, insecureTls: false };

const REOLINK = (host: string) => `https://${host || "IP-DER-KAMERA"}/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=openstellwerk&user={user}&password={password}`;

export function CamerasTab({ cameras, reload, run }: { cameras: Camera[]; reload: () => void; run: Run }) {
  const [selected, setSelected] = useState<string>();
  const [form, setForm] = useState(EMPTY);
  const cam = cameras.find((c) => c.id === selected);

  const edit = (c?: Camera) => {
    setSelected(c?.id);
    setForm(c ? { name: c.name, kind: c.kind, url: c.url, username: c.username ?? "", password: "", refreshMs: c.refreshMs ?? 1000, insecureTls: !!c.insecureTls } : EMPTY);
  };
  const save = () => run(
    api<Camera>(selected ? "PUT" : "POST", selected ? `/api/cameras/${selected}` : "/api/cameras", {
      name: form.name, kind: form.kind, url: form.url, username: form.username,
      refreshMs: form.kind === "snapshot" ? Number(form.refreshMs) : undefined,
      insecureTls: form.insecureTls,
      ...(form.password ? { password: form.password } : {}),
    }).then((c) => { reload(); setSelected(c.id); setForm({ ...form, password: "" }); }),
  );
  const f = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <section className="drive">
      <aside className="panel locos">
        <h2>Kameras</h2>
        <ul className="loco-list">
          {cameras.length === 0 && <li className="empty">Noch keine Kamera eingerichtet.</li>}
          {cameras.map((c) => (
            <li key={c.id}>
              <button className={`loco-item ${selected === c.id ? "active" : ""}`} onClick={() => edit(c)}>
                <span className="meta"><strong>{c.name}</strong><small>{{ mjpeg: "MJPEG-Stream", snapshot: "Standbild", iframe: "Webseite" }[c.kind]}</small></span>
              </button>
            </li>
          ))}
        </ul>
        <button onClick={() => edit()}>+ Neue Kamera</button>
      </aside>

      <div className="controls">
        <div className="panel">
          <h2>{selected ? "Kamera bearbeiten" : "Neue Kamera"}</h2>
          <div className="form">
            <label>Name <input value={form.name} onChange={f("name")} placeholder="z. B. Bahnhof" maxLength={40} /></label>
            <label>Typ
              <select value={form.kind} onChange={f("kind")}>
                <option value="mjpeg">MJPEG-Stream (Live-Video)</option>
                <option value="snapshot">Standbild (JPEG, wird aktualisiert)</option>
                <option value="iframe">Webseite der Kamera einbetten</option>
              </select>
            </label>
            <label className="wide">Adresse (URL) <input value={form.url} onChange={f("url")} placeholder="http://192.168.178.50/video.mjpg" /></label>
            {form.kind !== "iframe" && (
              <>
                <label>Benutzer <input value={form.username} onChange={f("username")} autoComplete="off" /></label>
                <label>Passwort <input type="password" value={form.password} onChange={f("password")} autoComplete="new-password" placeholder={cam?.hasPassword ? "unverändert" : ""} /></label>
              </>
            )}
            {form.url.startsWith("https:") && (
              <label className="check wide"><input type="checkbox" checked={form.insecureTls} onChange={(e) => setForm({ ...form, insecureTls: e.target.checked })} /> Selbstsigniertes Zertifikat zulassen (nur im eigenen Netz)</label>
            )}
            {form.kind === "snapshot" && <label>Aktualisierung (ms) <input type="number" min={200} max={60000} step={100} value={form.refreshMs} onChange={f("refreshMs")} /></label>}
          </div>
          <div className="row">
            <button className="active" onClick={save}>Speichern</button>
            <button title="Standbild-Adresse für Reolink-Kameras einsetzen" onClick={() => setForm({ ...form, kind: "snapshot", url: REOLINK(form.url.replace(/^https?:\/\//, "").split("/")[0] ?? ""), insecureTls: true })}>Reolink-Vorlage</button>
            {selected && cam?.hasPassword && <button onClick={() => run(api("PUT", `/api/cameras/${selected}`, { password: "" }).then(() => reload()))}>Passwort entfernen</button>}
            {selected && <button className="danger" onClick={() => sure(`Kamera „${cam?.name}“ löschen?`) && run(api("DELETE", `/api/cameras/${selected}`).then(() => { edit(); reload(); }))}>Löschen</button>}
          </div>
          <p className="hint">
            Der Server holt das Bild und reicht es weiter, die Zugangsdaten bleiben auf dem Server (<code>apps/server/data/cameras.json</code>, nicht in Git, im Klartext).
            Unterstützt wird HTTP Basic-Authentifizierung. RTSP-Kameras kann der Browser nicht anzeigen – dafür den Stream z. B. mit go2rtc oder ffmpeg in MJPEG umwandeln.
            In der Adresse stehen <code>{`{user}`}</code> und <code>{`{password}`}</code> für die Felder Benutzer/Passwort – für Kameras, die den Login in der URL erwarten. Der Typ „Webseite“ bindet die Kamera-Oberfläche direkt ein (nicht jede Kamera erlaubt das).
          </p>
        </div>
        {cam && <div className="panel"><h2>Vorschau</h2><CameraView key={`${cam.id}${cam.url}${cam.kind}${cam.refreshMs}`} cam={cam} /></div>}
      </div>
    </section>
  );
}

/** Camera sidebar: always visible next to every tab. */
export function CameraSidebar({ cameras, onConfigure }: { cameras: Camera[]; onConfigure: () => void }) {
  const [id, setId] = useState(store.get("openstellwerk.dockCam"));
  const cam = cameras.find((c) => c.id === id) ?? cameras[0];
  return (
    <aside className={`camside${cameras.length > 0 ? " has-cam" : ""}`}>
      <div className="panel">
        <div className="head">
          <h2>Kamera</h2>
          {cameras.length > 1 && (
            <select value={cam?.id} onChange={(e) => { setId(e.target.value); store.set("openstellwerk.dockCam", e.target.value); }}>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <button onClick={onConfigure} title="Kameras einrichten">⚙</button>
        </div>
        {cam
          ? <CameraView key={`${cam.id}${cam.url}${cam.kind}${cam.refreshMs}`} cam={cam} />
          : <p className="hint">Noch keine Kamera eingerichtet. Mit ⚙ geht es zur Einrichtung.</p>}
      </div>
    </aside>
  );
}
