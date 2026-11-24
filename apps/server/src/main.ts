import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Server as HttpsServer } from "node:https";
import Fastify, { type FastifyServerOptions } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { Station } from "./station.js";
import { Garage } from "./garage.js";
import { LocoImageStore, registerLocoImageRoutes, syncGarageImages } from "./loco-images.js";
import { registerMaintenanceRoutes } from "./maintenance.js";
import { readVersion } from "./version.js";
import { AutoDriver, orderFor } from "./auto-drive.js";
import { JourneyRunner, registerJourneyRoutes } from "./journeys.js";
import { CalibrationRunner, CalibrationStore, registerCalibrationRoutes } from "./calibration.js";
import type { Train } from "@openstellwerk/timetable";
import { EventLog, registerHistoryRoutes } from "./history.js";
import { UpdateService, registerUpdateRoutes } from "./update.js";
import { LayoutRuleEngine, LayoutRuleStore, locosInBlock, registerLayoutRuleRoutes } from "./layout-rules.js";
import { CameraStore, registerCameraRoutes } from "./cameras.js";
import { discover } from "./z21-client.js";
import { setting } from "./env.js";
import { exposureProblem, registerAuth, requestPath } from "./auth.js";
import { ConnectionMemory } from "./connection-memory.js";
import { Reconnector } from "./reconnect.js";
import { FeedbackService, registerFeedbackRoutes } from "./feedback.js";
import { bool } from "./validate.js";
import { UserStore } from "./users.js";
import { registerLayoutRoutes, SignalBox } from "./layout.js";
import { Demo, registerDemoRoutes } from "./demo.js";
import { BackupService, registerBackupRoutes } from "./backup.js";
import { registerTrainRoutes, TrainStore } from "./trains.js";
import { AchievementStore, registerAchievementRoutes } from "./achievements.js";
import { detectEvents } from "./automations.js";
import { AutomationEngine, AutomationStore, registerAutomationRoutes } from "./automations.js";
import { registerTimetableRoutes, TimetableRunner } from "./timetable.js";
import { readTls, tlsFilesFromEnv, watchTls } from "./tls.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1"; // local unless explicitly opened up (then a password is required)
const PASSWORD = setting("PASSWORD") || undefined;

const dataDir = process.env.DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
const connectionMemory = new ConnectionMemory(path.join(dataDir, "connection.json"));

/* Benutzer: ohne users.json und mit OPENSTELLWERK_PASSWORD entsteht beim ersten Start ein Admin "admin" mit diesem Passwort. */
const users = new UserStore(path.join(dataDir, "users.json"));
if (users.count() === 0 && PASSWORD) {
  try {
    users.create({ name: "admin", displayName: "Administrator", role: "admin", password: PASSWORD });
    console.warn('Benutzer "admin" angelegt (Passwort aus OPENSTELLWERK_PASSWORD). Danach gilt das Konto, nicht mehr die Umgebungsvariable.');
  } catch (e) { console.error("Admin konnte nicht angelegt werden:", (e as Error).message); process.exit(1); }
}

const problem = exposureProblem({ host: HOST, password: PASSWORD ?? (users.count() > 0 ? "users" : undefined), allowOpen: setting("ALLOW_OPEN") === "1" });
if (problem) { console.error(problem); process.exit(1); }

const tlsFiles = tlsFilesFromEnv(process.env);
const app = Fastify({
  // "warn" in production: one log line per request would wear the Pi's SD card (the camera polls every second)
  logger: { level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "warn" : "info") },
  trustProxy: process.env.TRUST_PROXY === "1",
  ...(tlsFiles ? { https: readTls(tlsFiles) } : {}),
} as FastifyServerOptions);
if (tlsFiles) watchTls(app.server as unknown as HttpsServer, tlsFiles, (err) => (err ? app.log.error(err, "TLS reload failed") : app.log.warn("TLS certificate reloaded")));

const garageFile = process.env.GARAGE_FILE ?? path.join(dataDir, "garage.json");
const station = new Station(new Garage(garageFile));
await app.register(websocket);
const auth = registerAuth(app, { password: users.count() > 0 ? undefined : PASSWORD, users, requireHttps: setting("REQUIRE_HTTPS") === "1" });
// Wer einer Lok zuletzt einen Fahrbefehl gegeben hat, bekommt die Erfolge für Anfahren und Halten.
app.addHook("preHandler", async (req) => {
  if (!req.user || req.method !== "POST") return;
  const m = /^\/api\/loco\/(\d+)\/(?:drive|stop|estop|function\/\d+|function-group)$/.exec(requestPath(req.url) ?? "");
  if (m) achievements.touch(Number(m[1]), req.user.id);
});

/** What the fields of a request are called in the interface (error messages are shown to the user as they are). */
const FIELD: Record<string, string> = {
  address: "Adresse", value: "Wert", cv: "CV", register: "Register", weekday: "Wochentag", reportAddress: "Meldeadresse", rate: "Faktor",
  output: "Ausgang", minute: "Minute", hour: "Stunde", decoder: "Decoder", bit: "Bit", from: "Anfang des Bereichs", to: "Ende des Bereichs",
  state: "Zustand", speed: "Fahrstufe", settings: "Einstellungen", power: "Leistung", port: "Port", nid: "NID", group: "Gruppe",
  function: "Funktion", byte: "Byte", bits: "Bits",
};
const int = (v: unknown, min: number, max: number, name: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`${FIELD[name] ?? name}: ganze Zahl von ${min} bis ${max} erwartet`), { statusCode: 400 });
  return n;
};

app.get("/api/state", async () => station.snapshot());
const appVersion = readVersion();
app.get("/api/version", async () => ({ version: appVersion }));
app.get("/api/discover", async () => discover());

app.post<{ Body: { host: string; port?: number } }>("/api/connect", async (req) => {
  await demo.stop(); // a real connection replaces the demo
  await station.connect(String(req.body.host), req.body.port);
  connectionMemory.remember(String(req.body.host), req.body.port); // nach einem Neustart wieder vorbelegen
  return station.snapshot();
});
const reconnector = new Reconnector({
  last: () => connectionMemory.get(),
  busy: () => station.snapshot().connected || demo.active,
  connect: async (host, port) => { await station.connect(host, port); },
});
/** Für alle Angemeldeten: die hinterlegte Zentrale wieder verbinden (nach der Anmeldung, oder per Knopf, wenn sie vorher aus war). */
app.post("/api/reconnect", async () => { await reconnector.attempt(); return station.snapshot(); });
app.post("/api/disconnect", async () => { await demo.stop(); station.client.disconnect(); return station.snapshot(); });

app.post<{ Body: { on: boolean } }>("/api/power", async (req) => { station.setPower(bool(req.body?.on, "Leistung")); return { ok: true }; });
app.post("/api/estop", async () => { station.emergencyStop(); return { ok: true }; });

app.get<{ Params: { addr: string } }>("/api/loco/:addr", async (req) => station.getLoco(int(req.params.addr, 1, 9999, "address")));
app.post<{ Params: { addr: string }; Body: { speed: number; forward: boolean } }>("/api/loco/:addr/drive", async (req) => {
  station.drive(int(req.params.addr, 1, 9999, "address"), int(req.body.speed, 0, 126, "speed"), bool(req.body.forward, "Fahrtrichtung"));
  return { ok: true };
});
app.post<{ Params: { addr: string }; Body: { forward: boolean } }>("/api/loco/:addr/stop", async (req) => {
  station.stopLoco(int(req.params.addr, 1, 9999, "address"), !!req.body.forward);
  return { ok: true };
});
app.post<{ Params: { addr: string; fn: string }; Body: { action: "on" | "off" | "toggle" } }>("/api/loco/:addr/function/:fn", async (req) => {
  station.setFunction(int(req.params.addr, 1, 9999, "address"), int(req.params.fn, 0, 28, "function"), req.body.action ?? "toggle");
  return { ok: true };
});

app.post<{ Params: { addr: string }; Body: { output: 0 | 1 } }>("/api/turnout/:addr", async (req) => {
  const addr = int(req.params.addr, 1, 16384, "address");
  box.assertAddressFree("turnout", addr); // a turnout locked by an interlocked route must not be moved by hand
  station.setTurnout(addr, int(req.body.output, 0, 1, "output") as 0 | 1);
  return { ok: true };
});

app.put<{ Body: Partial<Record<"railcom" | "loconet" | "detectors" | "rmbus" | "boosters" | "clock", boolean>> }>("/api/monitors", async (req) => {
  const patch: Record<string, boolean> = {};
  for (const k of ["railcom", "loconet", "detectors", "rmbus", "boosters", "clock"] as const) if (req.body?.[k] !== undefined) patch[k] = !!req.body[k];
  station.setMonitors(patch);
  return station.snapshot().monitors;
});

app.post<{ Body: { addr?: number } }>("/api/railcom/poll", async (req) => {
  station.pollRailCom(int(req.body?.addr ?? 0, 0, 9999, "address"));
  return { ok: true };
});

app.post<{ Body: { bytes: number[] } }>("/api/loconet/send", async (req) => {
  if (!Array.isArray(req.body?.bytes)) throw Object.assign(new Error("Bytes: Liste von Zahlen erwartet"), { statusCode: 400 });
  try { station.sendLocoNet(req.body.bytes.map((b) => int(b, 0, 255, "byte"))); }
  catch (e) { throw Object.assign(e as Error, { statusCode: 400 }); }
  return { ok: true };
});

app.post<{ Body: { kind: "sic" | "report" | "lissy" | "can"; reportAddress?: number } }>("/api/detectors/poll", async (req) => {
  const { kind, reportAddress } = req.body ?? {};
  if (kind === "can") station.pollCanDetectors();
  else if (kind === "sic") station.pollLocoNetDetectors("Sic");
  else if (kind === "report") station.pollLocoNetDetectors("ReportAddress", int(reportAddress ?? 1017, 1, 65535, "reportAddress"));
  else if (kind === "lissy") station.pollLocoNetDetectors("Lissy", int(reportAddress ?? 1, 0, 65535, "reportAddress"));
  else throw Object.assign(new Error("Unbekannte Art"), { statusCode: 400 });
  return { ok: true };
});

app.get<{ Params: { cv: string } }>("/api/cv/:cv", async (req) => {
  const cv = int(req.params.cv, 1, 1024, "cv");
  return { cv, value: await station.readCv(cv) };
});
app.put<{ Params: { cv: string }; Body: { value: number } }>("/api/cv/:cv", async (req) => {
  const cv = int(req.params.cv, 1, 1024, "cv");
  return { cv, value: await station.writeCv(cv, int(req.body.value, 0, 255, "value")) };
});

/* ---------- settings ---------- */
const mode = (v: unknown) => {
  if (v !== "dcc" && v !== "mm") throw Object.assign(new Error("Format muss DCC oder Motorola sein"), { statusCode: 400 });
  return v;
};
app.get<{ Params: { addr: string } }>("/api/loco/:addr/mode", async (req) => ({ mode: await station.readLocoMode(int(req.params.addr, 1, 9999, "address")) }));
app.put<{ Params: { addr: string }; Body: { mode: string } }>("/api/loco/:addr/mode", async (req) => {
  station.setLocoMode(int(req.params.addr, 1, 9999, "address"), mode(req.body?.mode));
  return { ok: true };
});
app.get<{ Params: { addr: string } }>("/api/turnout/:addr/mode", async (req) => ({ mode: await station.readTurnoutMode(int(req.params.addr, 1, 16384, "address")) }));
app.put<{ Params: { addr: string }; Body: { mode: string } }>("/api/turnout/:addr/mode", async (req) => {
  station.setTurnoutMode(int(req.params.addr, 1, 16384, "address"), mode(req.body?.mode));
  return { ok: true };
});

/* ---------- more driving ---------- */
/* ---------- history: what the layout and the server did ---------- */
const history = new EventLog(path.join(dataDir, "history.json"));
registerHistoryRoutes(app, history);
let wasConnected = false;
station.on("state", (st) => {
  if (st.connected === wasConnected) return;
  wasConnected = st.connected;
  history.add("verbindung", st.connected ? `Verbunden mit ${st.demo || st.host === "127.0.0.1" ? "der simulierten Zentrale (Demo)" : st.host ?? "der Zentrale"}` : "Verbindung getrennt", st.connected);
});

/* ---------- signal box: track diagram, routes ---------- */
const box = new SignalBox(station, path.join(dataDir, "layout.json"));
registerLayoutRoutes(app, box);
const routeName = (id: string) => box.get().routes.find((r) => r.id === id)?.name ?? id;
const ENDED = { completed: "Zug angekommen, aufgelöst", released: "aufgelöst", forced: "Notauflösung", fault: "nach Störung aufgelöst" } as const;
box.onEnded((e) => history.add("fahrstrasse", `„${routeName(e.routeId)}“: ${ENDED[e.reason]}`, e.reason === "completed" || e.reason === "released"));

/* ---------- automations per loco ---------- */
const automationStore = new AutomationStore(path.join(dataDir, "automations.json"));
const automations = new AutomationEngine(automationStore, (a, fn, act) => station.setFunction(a, fn, act));
const achievements = new AchievementStore(path.join(dataDir, "achievements.json"), () => station.notify(), (id) => users.get(id)?.displayName);
station.addExtra(() => ({ achievements: achievements.view(), lastHost: connectionMemory.get()?.host, lastPort: connectionMemory.get()?.port }));
registerAchievementRoutes(app, achievements);
station.on("locoChange", (prev, next) => { automations.onLoco(prev, next); achievements.onLocoEvents(detectEvents(prev, next), achievements.actorOf(next.address)); });
station.on("locosReset", () => automations.cancelPending());
station.on("state", (s) => { if (s.timetable) achievements.onInstances(s.timetable.instances); });
registerAutomationRoutes(app, automationStore);

/* ---------- trains and timetable ---------- */
const trains = new TrainStore(path.join(dataDir, "trains.json"));

/* ---------- driving by itself: speed tables, the auto driver, journeys to a chosen block ---------- */
const later = () => { setImmediate(() => station.notify()); }; // never notify from inside a state handler
const calibrationStore = new CalibrationStore(path.join(dataDir, "calibration.json"), later);
const calibrationRunner = new CalibrationRunner(calibrationStore, {
  layout: () => box.get(), drive: (a, sp, f) => station.drive(a, sp, f), changed: later,
  log: (addr, text, ok) => history.add("einmessen", `Lok ${addr}: ${text}`, ok),
});
const trainName = (id: string) => trains.get(id)?.name ?? id;
const routeStatus = (id: string) => box.routeStates().find((r) => r.routeId === id)?.status;
const driver = new AutoDriver({
  layout: () => box.get(), routeStatus, drive: (a, sp, f) => station.drive(a, sp, f), changed: later,
  log: (o, text, ok) => history.add("fahrautomat", `${trainName(o.trainId)} (Lok ${o.address}) auf „${routeName(o.routeId)}“: ${text}`, ok),
});
const driveOrder = (train: Train, routeId: string, forward: boolean) => orderFor(train, routeId, forward, calibrationStore.get(train.address));
const runner = new TimetableRunner(station, box, trains, path.join(dataDir, "timetable.json"), {
  onDeparture: (trip, train) => driver.assign(driveOrder(train, trip.routeId, trip.drive === "forward")),
  trainBusy: (id) => journeys.isActive(id),
});
const journeys: JourneyRunner = new JourneyRunner({
  layout: () => box.get(),
  trains: () => trains.list(),
  connected: () => station.client.connected,
  requestRoute: (id) => box.tryRequestRoute(id),
  releaseRoute: (id) => { box.releaseRoute(id); },
  routeStatus,
  setCarried: (id, blockId) => trains.setCarried(id, blockId),
  busy: (id) => runner.trainHasActiveDeparture(id),
  drive: (j, routeId, train) => driver.assign(driveOrder(train, routeId, j.drive === "forward")),
  stopDriving: (id, text) => driver.cancel(id, text),
  changed: later,
  log: (j, text, ok) => history.add("zielfahrt", `${trainName(j.trainId)} nach „${(box.get().blocks ?? []).find((b) => b.id === j.targetBlockId)?.name ?? j.targetBlockId}“: ${text}`, ok),
});
/* Fahrplan: jede Abfahrt, die endet, kommt einmal in den Verlauf. */
const seenInstances = new Map<string, string>();
station.on("state", (st) => {
  const list = st.timetable?.instances ?? [];
  for (const i of list) {
    const before = seenInstances.get(i.id);
    seenInstances.set(i.id, i.status);
    if (before === undefined || before === i.status || (i.status !== "done" && i.status !== "failed" && i.status !== "cancelled")) continue;
    const trip = runner.get().trips.find((t) => t.id === i.tripId);
    history.add("fahrplan", `${trip ? trainName(trip.trainId) : i.tripId}${trip ? ` auf „${routeName(trip.routeId)}“` : ""}: ${i.status === "done" ? "Fahrt beendet" : i.status === "cancelled" ? "entfallen" : `Störung${i.reason ? ` – ${i.reason}` : ""}`}`, i.status === "done");
  }
  for (const id of seenInstances.keys()) if (!list.some((i) => i.id === id)) seenInstances.delete(id);
});
box.onEnded((e) => journeys.onEnded(e));
station.on("state", (st) => { driver.onState(st); calibrationRunner.onState(st); });
station.on("locoChange", (prev, next) => driver.onLoco(prev, next));
setInterval(() => { const st = station.snapshot(); journeys.tick(); driver.onState(st); calibrationRunner.onState(st); }, 1000).unref(); // time limits need a clock
station.addExtra(() => ({ journeys: journeys.list(), autoDrive: driver.view(), calibration: { tables: calibrationStore.all(), run: calibrationRunner.view() } }));
registerJourneyRoutes(app, journeys);
registerCalibrationRoutes(app, calibrationStore, calibrationRunner);
registerTrainRoutes(app, trains, { blockIds: () => new Set((box.get().blocks ?? []).map((b) => b.id)), onRemove: (id) => runner.removeTripsOf(id), hasActiveDeparture: (id) => runner.trainHasActiveDeparture(id) });
registerTimetableRoutes(app, runner);
runner.start();
const demo = new Demo(station, box, 1, runner); // used by /api/connect above, which only runs after start-up
registerDemoRoutes(app, demo);

/* ---------- layout rules: a detector triggers turnouts, signals, routes or a loco stop ---------- */
const ruleStore = new LayoutRuleStore(path.join(dataDir, "layout-rules.json"), () => layoutRules.cancelPending());
const layoutRules: LayoutRuleEngine = new LayoutRuleEngine(ruleStore, () => box.get(), {
  setTile: (id, state) => box.setTile(id, state), // refuses tiles locked by a route
  requestRoute: (id) => box.tryRequestRoute(id),
  releaseRoute: (id) => { box.releaseRoute(id); },
  activeRoutes: () => box.routeStates().map((r) => r.routeId),
  locosIn: (blockId) => locosInBlock(box.get(), station.snapshot(), trains.list(), blockId),
  stopLoco: (addr) => station.stopLoco(addr, station.snapshot().locos.find((l) => l.address === addr)?.forward ?? true),
}, Date.now, 2000, () => {}, (rule, text, ok) => history.add("regel", `${rule.name}: ${text}`, ok));
station.addExtra(() => ({ macros: layoutRules.macros() }));
station.on("state", (s) => layoutRules.onState(s));
registerLayoutRuleRoutes(app, ruleStore, layoutRules);

/* ---------- cameras ---------- */
const cameraStore = new CameraStore(path.join(dataDir, "cameras.json"));
registerCameraRoutes(app, cameraStore);

/* ---------- loco pictures ---------- */
const locoImages = new LocoImageStore(path.join(dataDir, "loco-images"));
syncGarageImages(station.garage, locoImages);
registerLocoImageRoutes(app, station.garage, locoImages, () => station.notify());

/* ---------- backup: everything the user maintains that the Z21 does not store ---------- */
registerBackupRoutes(app, new BackupService(station.garage, box, cameraStore, trains, runner, locoImages, () => station.notify(), { automations: automationStore, achievements, users, layoutRules: ruleStore, calibration: calibrationStore }));

/* Repository auf GitHub. Ein Eintrag aus der Zeit vor dem Umzug (Forgejo, sebastian/…) wird ignoriert. */
const updateRepo = (() => { const r = setting("UPDATE_REPO"); return r && !/^sebastian\/(z21-web|openstellwerk)$/.test(r) ? r : "zap2021/openstellwerk"; })();

/* ---------- Problem melden: Issue auf GitHub, mit dem Zugriffstoken des Updates (issue #24) ---------- */
registerFeedbackRoutes(app, new FeedbackService({
  repo: updateRepo,
  token: setting("UPDATE_TOKEN") || undefined,
}));

/* ---------- update: new versions from GitHub (issue #1) ---------- */
const updates = new UpdateService({
  repo: updateRepo,
  token: setting("UPDATE_TOKEN") || undefined,
  installDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  workDir: path.join(dataDir, "update"),
  current: appVersion,
}, {
  blocked: () => (box.routeStates().length ? "Es sind noch Fahrstraßen angefordert; zuerst auflösen"
    : journeys.list().some((j) => j.status === "waiting" || j.status === "set") ? "Es läuft eine Zielfahrt"
    : runner.hasRunningDeparture() ? "Es läuft gerade eine Fahrt im Fahrplan"
    : calibrationRunner.view()?.running ? "Es läuft eine Messreihe" : undefined),
  log: (text, ok) => history.add("update", text, ok),
});
registerUpdateRoutes(app, updates);
station.addExtra(() => ({ update: updates.summary() }));
if (setting("UPDATE_CHECK") !== "0") updates.startChecking();

/* ---------- network settings (read-only) ---------- */
registerMaintenanceRoutes(app, station);

/* ---------- garage: known locos, discovery ---------- */
app.post<{ Body: { from?: number; to?: number } }>("/api/garage/scan", async (req) => {
  const from = int(req.body?.from ?? 1, 1, 9999, "from");
  const to = int(req.body?.to ?? from + 49, from, 9999, "to");
  station.startScan(from, to);
  return { ok: true };
});
app.delete("/api/garage/scan", async () => { station.stopScan(); return { ok: true }; });
app.post("/api/garage/read-prog", async () => station.readProgrammedAddress());
app.post<{ Body: { address: number; name?: string } }>("/api/garage", async (req) =>
  station.setGarageEntry(int(req.body?.address, 1, 9999, "address"), { name: req.body?.name === undefined ? undefined : String(req.body.name), source: "manual" }));
app.put<{ Params: { addr: string }; Body: { name?: string; functionNames?: Record<number, string> } }>("/api/garage/:addr", async (req) =>
  station.setGarageEntry(int(req.params.addr, 1, 9999, "address"), {
    name: req.body?.name === undefined ? undefined : String(req.body.name),
    functionNames: req.body?.functionNames && typeof req.body.functionNames === "object" ? req.body.functionNames : undefined,
  }));
app.delete<{ Params: { addr: string } }>("/api/garage/:addr", async (req) => {
  const address = int(req.params.addr, 1, 9999, "address");
  locoImages.remove(address); // the picture goes with the loco
  return { removed: station.removeGarageEntry(address) };
});

app.post<{ Params: { addr: string } }>("/api/loco/:addr/estop", async (req) => { station.locoEStop(int(req.params.addr, 1, 9999, "address")); return { ok: true }; });
app.post<{ Params: { addr: string } }>("/api/loco/:addr/purge", async (req) => { station.purgeLoco(int(req.params.addr, 1, 9999, "address")); return { ok: true }; });
app.post<{ Params: { addr: string }; Body: { group: number; bits: number } }>("/api/loco/:addr/function-group", async (req) => {
  station.setFunctionGroup(int(req.params.addr, 1, 9999, "address"), int(req.body?.group, 0x20, 0x51, "group"), int(req.body?.bits, 0, 255, "bits"));
  return { ok: true };
});
app.post<{ Params: { addr: string }; Body: { state: number; on: boolean } }>("/api/loco/:addr/binary-state", async (req) => {
  station.setBinaryState(int(req.params.addr, 1, 9999, "address"), int(req.body?.state, 29, 32767, "state"), bool(req.body?.on, "Zustand"));
  return { ok: true };
});

/* ---------- DCCext accessories / signals ---------- */
app.post<{ Params: { addr: string }; Body: { value: number } }>("/api/accessory/:addr", async (req) => {
  const addr = int(req.params.addr, 1, 2044, "address");
  box.assertAddressFree("ext", addr);
  station.setExtAccessory(addr, int(req.body?.value, 0, 255, "value"));
  return { ok: true };
});
app.get<{ Params: { addr: string } }>("/api/accessory/:addr", async (req) => station.getExtAccessory(int(req.params.addr, 1, 2044, "address")));
app.post("/api/accessory-estop", async () => { station.extAccessoryEStop(); return { ok: true }; });

/* ---------- programming ---------- */
app.get<{ Params: { addr: string; cv: string } }>("/api/pom/:addr/:cv", async (req) => {
  const cv = int(req.params.cv, 1, 1024, "cv");
  return { cv, value: await station.pomRead(int(req.params.addr, 1, 9999, "address"), cv) };
});
app.put<{ Params: { addr: string; cv: string }; Body: { value?: number; bit?: number; bitValue?: boolean } }>("/api/pom/:addr/:cv", async (req) => {
  const addr = int(req.params.addr, 1, 9999, "address"), cv = int(req.params.cv, 1, 1024, "cv");
  if (req.body?.bit !== undefined) station.pomWriteBit(addr, cv, int(req.body.bit, 0, 7, "bit"), !!req.body.bitValue);
  else station.pomWrite(addr, cv, int(req.body?.value, 0, 255, "value"));
  return { ok: true };
});
const accOutput = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : int(v, 0, 7, "output"));
app.get<{ Params: { dec: string; cv: string }; Querystring: { output?: string } }>("/api/pom-accessory/:dec/:cv", async (req) => {
  const cv = int(req.params.cv, 1, 1024, "cv");
  return { cv, value: await station.pomAccessoryRead(int(req.params.dec, 0, 511, "decoder"), accOutput(req.query.output), cv) };
});
app.put<{ Params: { dec: string; cv: string }; Body: { output?: number; value?: number; bit?: number; bitValue?: boolean } }>("/api/pom-accessory/:dec/:cv", async (req) => {
  const dec = int(req.params.dec, 0, 511, "decoder"), cv = int(req.params.cv, 1, 1024, "cv"), out = accOutput(req.body?.output);
  if (req.body?.bit !== undefined) station.pomAccessoryWriteBit(dec, out, cv, int(req.body.bit, 0, 7, "bit"), !!req.body.bitValue);
  else station.pomAccessoryWrite(dec, out, cv, int(req.body?.value, 0, 255, "value"));
  return { ok: true };
});
app.get<{ Params: { reg: string } }>("/api/register/:reg", async (req) => {
  const reg = int(req.params.reg, 1, 8, "register");
  return { register: reg, value: await station.readRegister(reg) };
});
app.put<{ Params: { reg: string }; Body: { value: number } }>("/api/register/:reg", async (req) => {
  const reg = int(req.params.reg, 1, 8, "register");
  return { register: reg, value: await station.writeRegister(reg, int(req.body?.value, 0, 255, "value")) };
});
app.put<{ Params: { reg: string }; Body: { value: number } }>("/api/mm-register/:reg", async (req) => {
  await station.mmWrite(int(req.params.reg, 1, 79, "register"), int(req.body?.value, 0, 255, "value"));
  return { ok: true, note: "finished; the decoder gives no feedback" };
});

/* ---------- R-BUS ---------- */
app.post("/api/rmbus/poll", async () => { station.pollRmBus(); return { ok: true }; });
app.post<{ Body: { address: number } }>("/api/rmbus/program", async (req) => {
  station.rmbusProgramModule(int(req.body?.address, 0, 20, "address"));
  return { ok: true };
});

/* ---------- fast clock ---------- */
app.post("/api/clock/poll", async () => { station.getClock(); return { ok: true }; });
app.post("/api/clock/start", async () => { station.startClock(); return { ok: true }; });
app.post("/api/clock/stop", async () => { station.stopClock(); return { ok: true }; });
app.put<{ Body: { weekday: number; hour: number; minute: number; rate: number } }>("/api/clock", async (req) => {
  const b = req.body ?? ({} as never);
  station.setClock(int(b.weekday, 0, 6, "weekday"), int(b.hour, 0, 23, "hour"), int(b.minute, 0, 59, "minute"), int(b.rate, 0, 63, "rate"));
  return { ok: true };
});
app.put<{ Body: { settings: number; rate?: number; start?: { weekday: number; hour: number; minute: number } } }>("/api/clock/settings", async (req) => {
  const b = req.body ?? ({} as never);
  const start = b.start && { weekday: int(b.start.weekday, 0, 6, "weekday"), hour: int(b.start.hour, 0, 23, "hour"), minute: int(b.start.minute, 0, 59, "minute") };
  station.setClockSettings(int(b.settings, 0, 255, "settings"), b.rate === undefined ? undefined : int(b.rate, 0, 63, "rate"), start);
  return { ok: true };
});

/* ---------- CAN boosters (via Z21) ---------- */
const nid = (v: unknown) => int(v, 0xc101, 0xc1ff, "nid");
const name = (v: unknown) => {
  if (typeof v !== "string") throw Object.assign(new Error("Name: Text erwartet"), { statusCode: 400 });
  return v;
};
const bad = (e: unknown) => Object.assign(e as Error, { statusCode: 400 });
app.post<{ Params: { nid: string } }>("/api/can-boosters/:nid/refresh", async (req) => { station.getCanBoosterName(nid(req.params.nid)); return { ok: true }; });
app.put<{ Params: { nid: string }; Body: { name: string } }>("/api/can-boosters/:nid/name", async (req) => {
  try { station.setCanBoosterName(nid(req.params.nid), name(req.body?.name)); } catch (e) { throw bad(e); }
  return { ok: true };
});
app.put<{ Params: { nid: string }; Body: { power: number } }>("/api/can-boosters/:nid/power", async (req) => {
  station.setCanBoosterPower(nid(req.params.nid), int(req.body?.power, 0, 255, "power"));
  return { ok: true };
});

/* ---------- zLink devices ---------- */
app.post("/api/device/refresh", async () => { station.refreshDevice(); return { ok: true }; });
app.put<{ Body: { name: string } }>("/api/device/name", async (req) => {
  try { station.setDeviceName(name(req.body?.name)); } catch (e) { throw bad(e); }
  return { ok: true };
});
app.put<{ Body: { port: 1 | 2 | 3; on: boolean } }>("/api/device/booster-power", async (req) => {
  station.setBoosterPower(int(req.body?.port, 1, 3, "port") as 1 | 2 | 3, bool(req.body?.on, "Leistung"));
  return { ok: true };
});

app.get("/ws", { websocket: true }, (socket, req) => {
  auth.trackSocket(req, socket);
  const send = (o: unknown) => socket.readyState === 1 && socket.send(JSON.stringify(o, (_, v) => (v?.type === "Buffer" ? undefined : v)));
  send({ kind: "state", state: station.snapshot() });
  const onState = (state: unknown) => send({ kind: "state", state });
  const onWire = (w: unknown) => send({ kind: "wire", wire: w });
  const onLocoNet = (line: unknown) => send({ kind: "loconet", line });
  station.on("loconet", onLocoNet);
  station.on("state", onState);
  station.client.on("wire", onWire);
  socket.on("close", () => { station.off("state", onState); station.client.off("wire", onWire); station.off("loconet", onLocoNet); });
});

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) await app.register(fastifyStatic, { root: webDist });

await app.listen({ port: PORT, host: HOST });
app.log.warn(`OpenStellwerk: ${tlsFiles ? "https" : "http"}://${HOST}:${PORT} – Anmeldung ${users.count() > 0 || PASSWORD ? "aktiv" : "aus"}`);
