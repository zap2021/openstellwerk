import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BackupService, registerBackupRoutes } from "./backup.js";
import { CameraStore } from "./cameras.js";
import { Garage } from "./garage.js";
import { SignalBox } from "./layout.js";
import { Station } from "./station.js";

const dir = mkdtempSync(path.join(tmpdir(), "backup-"));
const garage = new Garage();
const station = new Station(garage);
const box = new SignalBox(station, path.join(dir, "layout.json"));
const cameras = new CameraStore();
const app = Fastify();

const layout = {
  cols: 8, rows: 4,
  tiles: [{ id: "g1", x: 0, y: 0, kind: "straight", rot: 0 }, { id: "g2", x: 1, y: 0, kind: "straight", rot: 0 }],
  routes: [], blocks: [{ id: "b1", name: "Gleis 1", tileIds: ["g1"] }],
};

beforeAll(async () => {
  registerBackupRoutes(app, new BackupService(garage, box, cameras, () => station.notify()));
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
  expect(res.json()).toEqual({ restored: { garage: 2, layout: 2, cameras: 1 } });
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
  await bad((b) => { delete b.garage; delete b.layout; delete b.cameras; }, /nichts/);
  expect((await restore({ backup: null })).statusCode).toBe(400);
});
