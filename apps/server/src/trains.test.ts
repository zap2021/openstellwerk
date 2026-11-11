import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, expect, it, vi } from "vitest";
import { registerTrainRoutes, TrainStore } from "./trains.js";

const dir = mkdtempSync(path.join(tmpdir(), "trains-"));
const file = path.join(dir, "trains.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(f?: string) {
  const store = new TrainStore(f);
  const removed: string[] = [];
  const app = Fastify();
  registerTrainRoutes(app, store, { blockIds: () => new Set(["b1", "b2"]), onRemove: (id) => removed.push(id), hasActiveDeparture: () => false });
  await app.ready();
  return { store, app, removed };
}

it("creates, changes, lists and deletes trains", async () => {
  const { app, removed } = await setup();
  const created = await app.inject({ method: "POST", url: "/api/trains", payload: { name: "ICE", address: 3, number: "ICE 1" } });
  expect(created.statusCode).toBe(200);
  const t = created.json();
  expect(t.id).toMatch(/^[0-9a-f]{8}$/);
  const upd = await app.inject({ method: "PUT", url: `/api/trains/${t.id}`, payload: { name: "ICE 2", address: 3 } });
  expect(upd.json()).toMatchObject({ id: t.id, name: "ICE 2", address: 3 });
  expect((await app.inject({ url: "/api/trains" })).json()).toHaveLength(1);
  const del = await app.inject({ method: "DELETE", url: `/api/trains/${t.id}` });
  expect(del.json()).toEqual({ removed: true });
  expect(removed).toEqual([t.id]); // (g)
  expect((await app.inject({ url: "/api/trains" })).json()).toHaveLength(0);
});

it("rejects a duplicate loco address with 409 and bad input with 400", async () => {
  const { app } = await setup();
  await app.inject({ method: "POST", url: "/api/trains", payload: { name: "A", address: 3 } });
  const dup = await app.inject({ method: "POST", url: "/api/trains", payload: { name: "B", address: 3 } });
  expect(dup.statusCode).toBe(409);
  expect(dup.json().message).toContain("Lokadresse 3");
  expect((await app.inject({ method: "POST", url: "/api/trains", payload: { name: "", address: 4 } })).statusCode).toBe(400);
});

it("sets and clears the location by route", async () => {
  const { app } = await setup();
  const t = (await app.inject({ method: "POST", url: "/api/trains", payload: { name: "A", address: 3 } })).json();
  const put = (id: string, blockId: string | null) => app.inject({ method: "PUT", url: `/api/trains/${id}/location`, payload: { blockId } });
  const r = await put(t.id, "b1");
  expect(r.json().location).toMatchObject({ blockId: "b1", source: "manual" });
  expect(r.json().location.uncertain).toBeUndefined();
  expect((await put(t.id, null)).json().location).toBeUndefined();
  expect((await put(t.id, "nope")).statusCode).toBe(400);
  expect((await put("zzz", "b1")).statusCode).toBe(404);
});

it("marks locations uncertain after a reload; carried clears it; dropUnknownBlocks; replaceAll", async () => {
  const { store } = await setup(file);
  const t = store.save({ name: "A", address: 3 });
  store.setLocation(t.id, "b1");
  await wait(350);
  const again = new TrainStore(file);
  expect(again.get(t.id)?.location).toMatchObject({ blockId: "b1", uncertain: true });
  again.setCarried(t.id, "b2");
  expect(again.get(t.id)?.location).toMatchObject({ blockId: "b2", source: "carried" });
  expect(again.get(t.id)?.location?.uncertain).toBeUndefined();
  again.setDetected(t.id, "b1");
  expect(again.get(t.id)?.location?.source).toBe("detected");
  again.markUncertain(t.id);
  expect(again.get(t.id)?.location?.uncertain).toBe(true);
  again.dropUnknownBlocks(new Set(["b2"]));
  expect(again.get(t.id)?.location).toBeUndefined();
  again.setLocation(t.id, "b2");
  again.replaceAll([{ ...again.get(t.id)!, name: "N" }]);
  expect(again.get(t.id)).toMatchObject({ name: "N" });
  expect(again.get(t.id)?.location).toBeUndefined();
  await wait(350);
  expect(JSON.parse(readFileSync(file, "utf8"))[0].name).toBe("N");
});

/** Writes `bytes` as trains.json in a fresh folder, loads a store from it and returns the folder's other files. */
function loadBroken(bytes: string) {
  const d = mkdtempSync(path.join(tmpdir(), "trains-bad-"));
  const f = path.join(d, "trains.json");
  writeFileSync(f, bytes);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const store = new TrainStore(f);
    const copies = readdirSync(d).filter((n) => /^trains\.json\.invalid-\d+\.json$/.test(n));
    return { store, copies: copies.map((n) => readFileSync(path.join(d, n), "utf8")), logs: log.mock.calls.map((c) => c.join(" ")), cleanup: () => rmSync(d, { recursive: true, force: true }) };
  } finally { log.mockRestore(); }
}

it("keeps an unparseable trains.json as a .invalid copy and starts empty", () => {
  const bytes = '[{"id":"a1", "name": "ICE", ';
  const r = loadBroken(bytes);
  try {
    expect(r.store.list()).toEqual([]);
    expect(r.copies).toEqual([bytes]);
    expect(r.logs.some((l) => l.startsWith("trains.json nicht lesbar:"))).toBe(true);
    expect(r.logs.some((l) => l.includes(".invalid-"))).toBe(true); // tells where the copy is
  } finally { r.cleanup(); }
});

it("keeps a trains.json with a duplicate address as a .invalid copy and starts empty", () => {
  const bytes = JSON.stringify([{ id: "a1", name: "A", address: 3 }, { id: "a2", name: "B", address: 3 }]);
  const r = loadBroken(bytes);
  try {
    expect(r.store.list()).toEqual([]);
    expect(r.copies).toEqual([bytes]);
  } finally { r.cleanup(); }
});

it("a missing trains.json is silent and leaves no copy", () => {
  const d = mkdtempSync(path.join(tmpdir(), "trains-none-"));
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(new TrainStore(path.join(d, "trains.json")).list()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(readdirSync(d)).toEqual([]);
  } finally { log.mockRestore(); rmSync(d, { recursive: true, force: true }); }
});
