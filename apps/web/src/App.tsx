import { useState } from "react";
import { api, useStation, type LocoNetLine, type SessionUser, type StationState } from "./api";
import { ProfilePage } from "./profile";
import { AdminView } from "./admin";
import { SignalsTab } from "./devices";
import { DriveTab, ModeSelect } from "./drive";
import { Login, useSession } from "./login";
import { DisplayView, LayoutTab } from "./layout";
import { CameraSidebar, useCameras } from "./camera";
import { TimetableOperate } from "./timetable";
import { useRoute, type Route } from "./route";

type Run = (p: Promise<unknown>) => Promise<void>;
const post = (url: string, body?: unknown) => api("POST", url, body);
const put = (url: string, body?: unknown) => api("PUT", url, body);

/** Everyday operation. Everything else is in the administration (admin.tsx). */
type OperatePage = "drive" | "layout" | "timetable" | "turnouts" | "signals";
const OPERATE: [OperatePage, string][] = [["drive", "Fahren"], ["layout", "Stellwerk"], ["timetable", "Fahrplan"], ["turnouts", "Weichen"], ["signals", "Signale"]];

/** A Z21 offers everything; a zLink decoder only its signals, a booster nothing to operate. */
function operatePages(state?: StationState): [OperatePage, string][] {
  if (!state?.connected) return [];
  const kind = state.hw?.kind;
  if (kind === "booster") return [];
  if (kind === "decoder") return OPERATE.filter(([id]) => id === "signals");
  return OPERATE;
}

function Main({ logout, user, refresh }: { logout?: () => void; user?: SessionUser; refresh: () => void }) {
  const { state, wire, loconet, online, clearWire, clearLoconet } = useStation();
  const [route, go] = useRoute();
  const { cameras, reload: reloadCameras } = useCameras();
  const [error, setError] = useState<string>();
  const run: Run = async (p) => { try { setError(undefined); await p; } catch (e) { setError((e as Error).message); } };

  const connected = !!state?.connected;
  const kind = state?.hw?.kind;
  const isAdmin = !user || user.role === "admin"; // without accounts (shared password) everybody administers
  const admin = route.area === "admin" && isAdmin;
  const profile = route.area === "profile" && !!user;

  return (
    <div className={`shell${admin ? " wide" : ""}`}>
      <div className="app">
        <header>
          <h1>Z21 Web</h1>
          <span className={`dot ${connected ? "ok" : online ? "warn" : "bad"}`} />
          {state?.demo && <span className="demo-badge" title="Simulierte Zentrale ohne Hardware">DEMO</span>}
          <span className="status">{state?.demo ? "Simulierte Zentrale" : connected ? `${state?.hw?.hwName ?? "Z21"} @ ${state?.host}` : online ? "nicht mit Zentrale verbunden" : "Server offline"}</span>
          <div className="areas" role="tablist" aria-label="Bereich">
            <button role="tab" aria-selected={!admin && !profile} className={!admin && !profile ? "active" : ""} onClick={() => go({ area: "operate" })}>Bedienen</button>
            {isAdmin && <button role="tab" aria-selected={admin} className={admin ? "active" : ""} onClick={() => go({ area: "admin" })}>Verwaltung</button>}
          </div>
          {connected && kind !== "decoder" && state && <PowerBar state={state} run={run} />}
          {user && <button className={profile ? "active" : ""} onClick={() => go({ area: "profile" })} title="Profil und Erfolge">{user.displayName}{user.role === "admin" ? " (Admin)" : ""}</button>}
          {logout && <button onClick={logout} title="Abmelden">Abmelden</button>}
        </header>
        {error && <div className="error" onClick={() => setError(undefined)}>{error}</div>}
        {profile && user ? (
          <ProfilePage user={user} state={state} run={run} done={refresh} />
        ) : admin ? (
          <AdminView
            me={user} state={state} wire={wire} loconet={loconet as LocoNetLine[]} clearWire={clearWire} clearLoconet={clearLoconet}
            cameras={cameras} reloadCameras={reloadCameras} run={run} page={route.area === "admin" ? route.page : undefined} go={go}
          />
        ) : (
          <Operate state={state} online={online} run={run} go={go} />
        )}
      </div>
      {!admin && !profile && <CameraSidebar cameras={cameras} onConfigure={() => go({ area: "admin", page: "cameras" })} />}
    </div>
  );
}

function Operate({ state, online, run, go }: { state?: StationState; online: boolean; run: Run; go: (r: Route) => void }) {
  const pages = operatePages(state);
  const [tab, setTab] = useState<OperatePage>("drive");
  const current: OperatePage | undefined = pages.some(([id]) => id === tab) ? tab : pages[0]?.[0];
  if (!state || !current) return <NotReady state={state} online={online} run={run} go={go} />;
  return (
    <>
      <nav className="operatenav">
        {pages.map(([id, label]) => <button key={id} className={current === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      <main>
        {current === "drive" && <DriveTab state={state} run={run} />}
        {current === "layout" && <LayoutTab state={state} run={run} />}
        {current === "timetable" && <TimetableOperate state={state} run={run} />}
        {current === "turnouts" && <TurnoutsTab state={state} run={run} />}
        {current === "signals" && <SignalsTab state={state} run={run} />}
      </main>
    </>
  );
}

/** Nothing to operate yet: say why and offer the way forward instead of showing empty tabs. */
function NotReady({ state, online, run, go }: { state?: StationState; online: boolean; run: Run; go: (r: Route) => void }) {
  if (!online) return <div className="panel notready"><h2>Server nicht erreichbar</h2><p className="hint">Die Verbindung zum Server ist unterbrochen. Die Seite verbindet sich von selbst wieder.</p></div>;
  if (state?.connected) {
    return (
      <div className="panel notready">
        <h2>Dieses Gerät hat keine Bedienung</h2>
        <p className="hint">Einstellungen und Status findest du in der Verwaltung.</p>
        <div className="row"><button className="active" onClick={() => go({ area: "admin", page: "device" })}>Zur Verwaltung</button></div>
      </div>
    );
  }
  return (
    <div className="panel notready">
      <h2>Nicht mit einer Zentrale verbunden</h2>
      <p className="hint">Verbinde dich mit deiner Z21, oder probiere alles ohne Hardware im Demo-Modus aus.</p>
      <div className="row">
        <button className="active" onClick={() => go({ area: "admin", page: "station" })}>Mit Zentrale verbinden</button>
        <button onClick={() => run(post("/api/demo", { on: true }))}>Demo starten</button>
      </div>
    </div>
  );
}

/** Read-only second screen, opened as /#/anzeige. */
function Display() {
  const { state } = useStation();
  return <DisplayView state={state} />;
}

/** Shows the login form when the server asks for a password, the application otherwise. */
export function App() {
  const session = useSession();
  const [route] = useRoute();
  if (!session.known) return null;
  if (!session.authenticated) return <Login onDone={session.refresh} usersMode={session.usersMode} />;
  if (route.area === "display") return <Display />;
  return <Main logout={session.required ? session.logout : undefined} user={session.user} refresh={session.refresh} />;
}

function PowerBar({ state, run }: { state: StationState; run: Run }) {
  const on = state.power === "on";
  return (
    <div className="power">
      <span className={`pill ${state.power}`}>{state.power ?? "?"}</span>
      <button onClick={() => run(post("/api/power", { on: !on }))}>{on ? "Gleisspannung aus" : "Gleisspannung ein"}</button>
      <button className="danger" onClick={() => run(post("/api/estop"))}>NOT-HALT</button>
    </div>
  );
}

function TurnoutsTab({ state, run }: { state: StationState; run: Run }) {
  const [addr, setAddr] = useState(1);
  return (
    <section>
      <div className="row">
        <label>Weichenadresse <input type="number" min={1} value={addr} onChange={(e) => setAddr(Number(e.target.value))} /></label>
        <button onClick={() => run(post(`/api/turnout/${addr}`, { output: 0 }))}>Ausgang 1 (0)</button>
        <button onClick={() => run(post(`/api/turnout/${addr}`, { output: 1 }))}>Ausgang 2 (1)</button>
        <label>Format <ModeSelect value={addr >= 257 ? "dcc" : state.modes.turnout[addr]} onChange={(m) => run(put(`/api/turnout/${addr}/mode`, { mode: m }))} /></label>
        <button onClick={() => run(api("GET", `/api/turnout/${addr}/mode`))}>Format lesen</button>
      </div>
      <p>Letzter bekannter Stand: {state.turnouts[addr] ?? "–"}</p>
      <p className="hint">Welcher Ausgang „gerade“ oder „abzweigend“ ist, hängt von der Verdrahtung ab – die Zentrale weiß das nicht. Adressen ab 257 sind immer DCC.</p>
    </section>
  );
}
