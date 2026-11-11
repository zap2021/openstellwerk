import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BackupService, registerBackupRoutes } from "./backup.js";
import { CameraStore } from "./cameras.js";
import { Garage } from "./garage.js";
import { SignalBox } from "./layout.js";
import { Station } from "./station.js";
import { TrainStore } from "./trains.js";
import { TimetableRunner } from "./timetable.js";

const dir = mkdtempSync(path.join(tmpdir(), "backup-"));
const garage = new Garage();
const station = new Station(garage);
const box = new SignalBox(station, path.join(dir, "layout.json"));
const cameras = new CameraStore();
const trains = new TrainStore();
const runner = new TimetableRunner(station, box, trains);
const app = Fastify();

const layout = {
  cols: 8, rows: 4,
  tiles: [{ id: "g1", x: 0, y: 0, kind: "straight", rot: 0 }, { id: "g2", x: 1, y: 0, kind: "straight", rot: 0 }],
  routes: [], blocks: [{ id: "b1", name: "Gleis 1", tileIds: ["g1"] }],
};

beforeAll(async () => {
  registerBackupRoutes(app, new BackupService(garage, box, cameras, trains, runner, () => station.notify()));
  await app.ready();
  garage.upsert(3, { name: "V 200", functionNames: { 0: "Licht", 2: "Horn" }, source: "manual" });
  garage.upsert(1000, { name: "Dampflok" });
  box.save(layout);
  cameras.save({ name: "Bahnhof", kind: "snapshot", url: "http://cam.local/snap.jpg", username: "u", password: "geheim" });
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const get = async (qs = "") => (await app.inject({ method: "GET", url: `/api/backup${qs}` })).json();
const restore = (payload: object) => app.inject({ method: "POST", url: "/api/backup/restore", payload });

it("contains locos with names and function labels, the diagram with blocks and the cameras", async () => {
  const res = await app.inject({ method: "GET", url: "/api/backup" });
  expect(res.headers["content-disposition"]).toMatch(/attachment; filename="z21-web-backup-\d{4}-\d\d-\d\d\.json"/);
  const b = res.json();
  expect(b).toMatchObject({ format: "z21-web-backup", version: 1 });
  expect(b.garage.map((l: { address: number }) => l.address)).toEqual([3, 1000]);
  expect(b.garage[0]).toMatchObject({ name: "V 200", sources: ["manual"], functionNames: { 0: "Licht", 2: "Horn" } });
  expect(b.layout.blocks).toHaveLength(1);
  expect(b.cameras[0]).toMatchObject({ name: "Bahnhof", url: "http://cam.local/snap.jpg", username: "u" });
});

it("leaves camera passwords out unless asked", async () => {
  expect((await get()).cameras[0].password).toBeUndefined();
  expect((await get("?passwords=1")).cameras[0].password).toBe("geheim");
});

it("restores everything into a fresh state and keeps the camera password without losing it", async () => {
  const backup = await get(); // without passwords
  garage.remove(3); garage.upsert(7, { name: "Fremd" });
  box.save({ ...layout, blocks: [], tiles: layout.tiles.slice(0, 1) });
  cameras.replaceAll([]);
  cameras.save({ id: undefined, name: "Alt", kind: "mjpeg", url: "http://x.local/" });
  const camId = backup.cameras[0].id as string;
  cameras.replaceAll([{ id: camId, name: "Vorher", kind: "mjpeg", url: "http://y.local/", password: "altes-passwort" }]);

  const res = await restore({ backup });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ restored: { garage: 2, layout: 2, cameras: 1, trains: 0, timetable: 0 } });
  expect(garage.list().map((l) => l.address)).toEqual([3, 1000]);
  expect(garage.get(3)?.functionNames).toEqual({ 0: "Licht", 2: "Horn" });
  expect(box.get().blocks).toHaveLength(1);
  expect(cameras.list()).toMatchObject([{ id: camId, name: "Bahnhof", kind: "snapshot", password: "altes-passwort" }]); // password of same id survives
});

it("restores a backup that carries passwords", async () => {
  cameras.save({ id: cameras.list()[0]!.id, password: "geheim" });
  const backup = await get("?passwords=1");
  cameras.replaceAll([]);
  await restore({ backup });
  expect(cameras.list()[0]!.password).toBe("geheim");
});

it("restores only the chosen parts", async () => {
  const backup = await get();
  garage.upsert(55, { name: "Neu" });
  cameras.replaceAll([]);
  const res = await restore({ backup, parts: ["cameras"] });
  expect(res.json()).toEqual({ restored: { cameras: 1 } });
  expect(garage.get(55)).toBeDefined(); // garage untouched
});

it("rejects broken files and changes nothing, even when another part is fine", async () => {
  const good = await get();
  const before = JSON.stringify([garage.list(), box.get(), cameras.list()]);
  const bad = async (patch: (b: Record<string, unknown>) => void, message: RegExp) => {
    const b = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    patch(b);
    const res = await restore({ backup: b });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(message);
    expect(JSON.stringify([garage.list(), box.get(), cameras.list()])).toBe(before);
  };
  await bad((b) => { b.format = "etwas-anderes"; }, /keine Sicherungsdatei/);
  await bad((b) => { b.version = 2; }, /Sicherungsversion 2/);
  await bad((b) => { b.garage = [{ address: 0 }]; }, /Adresse/);
  await bad((b) => { b.garage = [{ address: 5 }, { address: 5 }]; }, /doppelt/);
  await bad((b) => { (b.layout as { cols: number }).cols = 1; }, /Spaltenzahl/); // garage is valid, layout is not
  await bad((b) => { (b.cameras as { url: string }[])[0]!.url = "rtsp://cam"; }, /Kamera 1.*RTSP/);
  await bad((b) => { delete b.garage; delete b.layout; delete b.cameras; delete b.trains; delete b.timetable; }, /nichts/);
  expect((await restore({ backup: null })).statusCode).toBe(400);
});

/* ---------- trains and timetable ---------- */
const trainsOf = () => trains.list().map(({ location: _l, ...t }) => t);
const setup = () => {
  trains.replaceAll([]); runner.replaceAll({ trips: [], lateLimit: 5 });
  box.save({ ...layout, routes: [{ id: "r1", name: "1 nach 1", from: "b1", to: "b1", steps: [] }] });
  trains.replaceAll([{ id: "t1", name: "RE 1", address: 3 }]);
  runner.replaceAll({ trips: [{ id: "f1", trainId: "t1", routeId: "r1", departure: 480, dwell: 2 }], lateLimit: 7 });
};

it("round-trips trains (without location) and the timetable", async () => {
  setup();
  trains.setLocation("t1", "b1");
  const b = await get();
  expect(b.trains).toHaveLength(1);
  expect(b.trains[0].location).toBeUndefined();
  expect(b.timetable).toEqual({ trips: [{ id: "f1", trainId: "t1", routeId: "r1", departure: 480, dwell: 2 }], settings: { lateLimit: 7 } });
  const expected = trainsOf();
  trains.replaceAll([]); runner.replaceAll({ trips: [], lateLimit: 5 });
  const res = await restore({ backup: b });
  expect(res.json()).toEqual({ restored: { garage: expect.any(Number), layout: 2, cameras: 1, trains: 1, timetable: 1 } });
  expect(trainsOf()).toEqual(expected);
  expect(runner.get().trips).toEqual(b.timetable.trips);
  expect(runner.get().lateLimit).toBe(7);
});

it("restores an old backup without trains and timetable and leaves them alone", async () => {
  setup();
  const b = await get(); delete b.trains; delete b.timetable;
  const res = await restore({ backup: b });
  expect(res.statusCode).toBe(200);
  expect(res.json().restored.trains).toBeUndefined();
  expect(trains.list()).toHaveLength(1);
  expect(runner.get().trips).toHaveLength(1);
});

it("rejects a trip with an unknown train and changes nothing", async () => {
  setup();
  const b = await get();
  b.timetable.trips[0].trainId = "gibtsnicht";
  garage.upsert(77, { name: "Bleibt" });
  const res = await restore({ backup: b });
  expect(res.statusCode).toBe(400);
  expect(res.json().message).toMatch(/Zug nicht gefunden/);
  expect(garage.get(77)).toBeDefined();
  expect(trains.list()).toHaveLength(1);
  expect(runner.get().lateLimit).toBe(7);
  const c = await get(); c.timetable.settings.lateLimit = 9999;
  expect((await restore({ backup: c })).statusCode).toBe(400);
});

it("restoring only trains fails when a current trip points to a removed train", async () => {
  setup();
  const b = await get();
  b.trains = [{ id: "t2", name: "Anderer", address: 4 }];
  const res = await restore({ backup: b, parts: ["trains"] });
  expect(res.statusCode).toBe(400);
  expect(res.json().message).toBe("Fahrt f1 verweist auf einen Zug, den es nach der Wiederherstellung nicht mehr gibt");
  expect(trains.list().map((t) => t.id)).toEqual(["t1"]);
  b.trains = [{ id: "t1", name: "Umbenannt", address: 3 }];
  expect((await restore({ backup: b, parts: ["trains"] })).statusCode).toBe(200);
  expect(runner.get().trips).toHaveLength(1);
});

it("refuses to restore the timetable while a departure is running, changing nothing", async () => {
  setup();
  const b = await get();
  garage.upsert(78, { name: "Auch bleibt" });
  b.garage = [{ address: 5 }];
  const spy = vi.spyOn(runner, "hasRunningDeparture").mockReturnValue(true);
  const res = await restore({ backup: b });
  spy.mockRestore();
  expect(res.statusCode).toBe(409);
  expect(garage.get(78)).toBeDefined();
  expect(garage.get(5)).toBeUndefined();
});

it("restoring only the layout fails when a current trip points to a route that will be gone", async () => {
  setup();
  const b = await get();
  b.layout.routes = [];
  garage.upsert(79, { name: "Bleibt ebenfalls" });
  const res = await restore({ backup: b, parts: ["garage", "layout"] });
  expect(res.statusCode).toBe(400);
  expect(res.json().message).toBe("Fahrt f1 verweist auf eine Fahrstraße, die es nach der Wiederherstellung nicht mehr gibt");
  expect(box.get().routes.map((r) => r.id)).toEqual(["r1"]); // nothing changed
  expect(garage.get(79)).toBeDefined();
  expect(runner.get().trips).toHaveLength(1);

  // layout and trains together, timetable left out: the current trips are still checked against the new routes
  expect((await restore({ backup: b, parts: ["layout", "trains"] })).statusCode).toBe(400);
  expect(box.get().routes.map((r) => r.id)).toEqual(["r1"]);

  // with the timetable from the same file the trips are checked as part of it (and fail there)
  expect((await restore({ backup: b, parts: ["layout", "timetable"] })).statusCode).toBe(400);

  // a layout that keeps the route is fine
  b.layout.routes = [{ id: "r1", name: "umbenannt", from: "b1", to: "b1", steps: [] }];
  expect((await restore({ backup: b, parts: ["layout"] })).statusCode).toBe(200);
  expect(box.get().routes[0]!.name).toBe("umbenannt");
});
