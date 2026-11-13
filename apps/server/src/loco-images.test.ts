import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Garage } from "./garage.js";
import { checkJpeg, LocoImageStore, MAX_IMAGE_BYTES, parseAddress, registerLocoImageRoutes, syncGarageImages } from "./loco-images.js";

/** A stand-in for a JPEG: right start and end markers, enough bytes. The server never decodes the picture. */
const jpeg = (size = 300, fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 6, fill), Buffer.from([0xff, 0xd9])]);

describe("checkJpeg", () => {
  it("accepts a JPEG and refuses everything else with a clear message", () => {
    expect(() => checkJpeg(jpeg())).not.toThrow();
    const bad = (b: unknown, status: number, msg: RegExp) => expect(() => checkJpeg(b)).toThrow(expect.objectContaining({ statusCode: status, message: expect.stringMatching(msg) }));
    bad(Buffer.from("GIF89a" + "x".repeat(200)), 400, /kein gültiges JPEG/);
    bad(jpeg(50), 400, /kein gültiges JPEG/); // too small
    bad(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300, 1)]), 400, /kein gültiges JPEG/); // no end marker
    bad(jpeg(MAX_IMAGE_BYTES + 1), 413, /zu groß/);
    bad("not a buffer", 400, /kein gültiges JPEG/);
    bad(undefined, 400, /kein gültiges JPEG/);
    expect(() => checkJpeg(jpeg(MAX_IMAGE_BYTES))).not.toThrow(); // exactly the limit is fine
  });
  it("parses addresses strictly (the file name is built from this number only)", () => {
    expect(parseAddress("77")).toBe(77);
    for (const bad of ["0", "10000", "-1", "1.5", "../x", "7 7", "", "abc", "٣"]) expect(() => parseAddress(bad), bad).toThrow(/zwischen 1 und 9999/);
  });
});

describe.each([["in memory", undefined], ["on disk", "dir"]] as const)("LocoImageStore %s", (_n, mode) => {
  const dir = mode ? mkdtempSync(path.join(tmpdir(), "images-")) : undefined;
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const store = new LocoImageStore(dir && path.join(dir, "loco-images"));

  it("stores, returns and removes a picture; every upload gets a new version", () => {
    expect(store.has(5)).toBe(false);
    const v1 = store.set(5, jpeg(300, 1));
    expect(store.has(5)).toBe(true);
    expect(store.get(5)!.equals(jpeg(300, 1))).toBe(true);
    expect(store.version(5)).toBe(v1);
    const v2 = store.set(5, jpeg(300, 2)); // same millisecond is possible: the version must still differ
    expect(v2).toBeGreaterThan(v1);
    expect(store.get(5)!.equals(jpeg(300, 2))).toBe(true);
    expect(store.addresses()).toEqual([5]);
    expect(store.remove(5)).toBe(true);
    expect(store.remove(5)).toBe(false);
    expect(store.get(5)).toBeUndefined();
  });
  it("refuses an invalid picture and keeps the old one", () => {
    store.set(6, jpeg(300, 3));
    expect(() => store.set(6, Buffer.from("nope"))).toThrow(/kein gültiges JPEG/);
    expect(store.get(6)!.equals(jpeg(300, 3))).toBe(true);
    store.remove(6);
  });
});

it("keeps the picture across a restart and leaves no temporary files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "images-"));
  try {
    const a = new LocoImageStore(path.join(dir, "loco-images"));
    const v = a.set(12, jpeg(400, 9));
    const b = new LocoImageStore(path.join(dir, "loco-images"));
    expect(b.get(12)!.equals(jpeg(400, 9))).toBe(true);
    expect(b.version(12)).toBe(v);
    expect(readdirSync(path.join(dir, "loco-images"))).toEqual(["12.jpg"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe("routes", () => {
  const garage = new Garage();
  const images = new LocoImageStore();
  const app = Fastify();
  let changes = 0;
  beforeAll(async () => { registerLocoImageRoutes(app, garage, images, () => { changes++; }); await app.ready(); });
  afterAll(() => app.close());
  const put = (addr: string, payload: Buffer | string, type = "image/jpeg") => app.inject({ method: "PUT", url: `/api/garage/${addr}/image`, payload, headers: { "content-type": type } });

  it("uploads a picture, creates the garage entry and announces the new version", async () => {
    const before = changes;
    const r = await put("77", jpeg(500, 4));
    expect(r.statusCode).toBe(200);
    const { imageVersion } = r.json();
    expect(garage.get(77)).toMatchObject({ address: 77, imageVersion, sources: ["manual"] });
    expect(changes).toBe(before + 1);

    const got = await app.inject({ method: "GET", url: "/api/garage/77/image" });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(jpeg(500, 4))).toBe(true);
    expect(got.headers["content-type"]).toBe("image/jpeg");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(got.headers["etag"]).toBe(`"${imageVersion}"`);

    const again = (await put("77", jpeg(500, 5))).json().imageVersion;
    expect(again).toBeGreaterThan(imageVersion);
    expect(garage.get(77)!.imageVersion).toBe(again);
  });
  it("keeps name and function labels of an existing loco when a picture is added", async () => {
    garage.upsert(78, { name: "BR 218", functionNames: { 0: "Licht" }, source: "scan" });
    await put("78", jpeg());
    expect(garage.get(78)).toMatchObject({ name: "BR 218", functionNames: { 0: "Licht" }, sources: ["scan"] });
  });
  it("refuses wrong content, too large pictures, a wrong content type and bad addresses", async () => {
    const bad = await put("79", Buffer.from("GIF89a" + "x".repeat(300)));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/kein gültiges JPEG/);
    const big = await put("79", jpeg(MAX_IMAGE_BYTES + 5));
    expect(big.statusCode).toBe(413);
    expect(big.json().message).toMatch(/zu groß/);
    expect((await put("79", "plain text", "text/plain")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await put("0", jpeg())).statusCode).toBe(400);
    expect((await put("abc", jpeg())).statusCode).toBe(400);
    expect(garage.get(79)).toBeUndefined(); // nothing was created by the failed uploads
    expect(images.has(79)).toBe(false);
  });
  it("answers 404 without a picture and removes one on request", async () => {
    expect((await app.inject({ method: "GET", url: "/api/garage/500/image" })).statusCode).toBe(404);
    const del = await app.inject({ method: "DELETE", url: "/api/garage/77/image" });
    expect(del.json()).toEqual({ removed: true });
    expect(garage.get(77)!.imageVersion).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/garage/77/image" })).statusCode).toBe(404);
  });
  it("removing is idempotent and clears a stale version", async () => {
    expect((await app.inject({ method: "DELETE", url: "/api/garage/500/image" })).json()).toEqual({ removed: false });
    garage.upsert(501, { source: "manual" });
    garage.setImageVersion(501, 123); // claims a picture that is not there
    expect((await app.inject({ method: "DELETE", url: "/api/garage/501/image" })).statusCode).toBe(200);
    expect(garage.get(501)!.imageVersion).toBeUndefined();
  });
  it("answers 304 when the ETag still matches", async () => {
    await put("77", jpeg());
    const res = await app.inject({ method: "GET", url: "/api/garage/77/image" });
    expect(res.statusCode).toBe(200);
    const again = await app.inject({ method: "GET", url: "/api/garage/77/image", headers: { "if-none-match": res.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
  });
  it("leaves no picture behind when the garage cannot be updated", async () => {
    const spy = vi.spyOn(garage, "setImageVersion").mockImplementation(() => { throw new Error("disk full"); });
    const res = await put("88", jpeg());
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(images.has(88)).toBe(false);
  });
});

describe("syncGarageImages", () => {
  it("drops pictures of locos that are gone, adds versions of files, clears versions without a file", () => {
    const garage = new Garage();
    const images = new LocoImageStore();
    garage.upsert(1, { source: "manual" });
    garage.upsert(2, { source: "manual" });
    garage.setImageVersion(2, 123); // claims a picture that is not there
    const v = images.set(1, jpeg()); // a picture whose version the garage does not know
    images.set(3, jpeg()); // a picture of a loco that is not listed
    syncGarageImages(garage, images);
    expect(garage.get(1)!.imageVersion).toBe(v);
    expect(garage.get(2)!.imageVersion).toBeUndefined();
    expect(images.has(3)).toBe(false);
  });
});
