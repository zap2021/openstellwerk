import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Garage } from "./garage.js";

/** Pictures are small JPEGs (the browser shrinks them); anything bigger is refused. */
export const MAX_IMAGE_BYTES = 200 * 1024;
const MIN_IMAGE_BYTES = 100;

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Only real JPEG files get in: start marker FF D8 FF, end marker FF D9, sane size. The bytes are never interpreted, only passed on. */
export function checkJpeg(buf: unknown): Buffer {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_IMAGE_BYTES) throw fail(400, "Das ist kein gültiges JPEG-Bild");
  if (buf.length > MAX_IMAGE_BYTES) throw fail(413, "Das Bild ist zu groß (höchstens 200 KB)");
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) throw fail(400, "Das ist kein gültiges JPEG-Bild");
  return buf;
}

export function parseAddress(v: unknown): number {
  const n = typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw fail(400, "Lokadresse muss zwischen 1 und 9999 liegen");
  return n;
}

/**
 * One small JPEG per loco, kept as <dir>/<address>.jpg. The file name comes only from a checked integer, never from
 * request text. Without a directory (tests) the pictures live in memory.
 */
export class LocoImageStore {
  private mem = new Map<number, { bytes: Buffer; version: number }>();

  constructor(private dir?: string) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  private file(address: number) { return path.join(this.dir!, `${parseAddress(address)}.jpg`); }

  has(address: number): boolean { return this.dir ? existsSync(this.file(address)) : this.mem.has(address); }

  get(address: number): Buffer | undefined {
    if (!this.dir) return this.mem.get(address)?.bytes;
    try { return readFileSync(this.file(address)); } catch { return undefined; }
  }

  /** The version of the stored picture (ms timestamp); changes with every upload. */
  version(address: number): number | undefined {
    if (!this.dir) return this.mem.get(address)?.version;
    try { return Math.round(statSync(this.file(address)).mtimeMs); } catch { return undefined; }
  }

  /** Store (replace) the picture; returns its new version. Written to a temporary file first, so a failure leaves the old picture. */
  set(address: number, jpeg: Buffer): number {
    checkJpeg(jpeg);
    if (!this.dir) {
      const version = Math.max(Date.now(), (this.mem.get(address)?.version ?? 0) + 1);
      this.mem.set(address, { bytes: Buffer.from(jpeg), version });
      return version;
    }
    const target = this.file(address);
    const before = this.version(address) ?? 0;
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, jpeg);
    renameSync(tmp, target);
    // The version is the file's modification time, read back from the file system so that set() and version() always agree.
    // Two uploads must differ for the browser's cache; on a file system with coarse timestamps the time is pushed on until it does.
    let wanted = Math.max(Date.now(), before + 1);
    for (let step = 1; ; step++) {
      utimesSync(target, new Date(wanted), new Date(wanted));
      const actual = this.version(address)!;
      if (actual > before || step >= 4) return actual;
      wanted += 1000 * step;
    }
  }

  remove(address: number): boolean {
    if (!this.dir) return this.mem.delete(address);
    const had = this.has(address);
    rmSync(this.file(address), { force: true });
    return had;
  }

  /** Addresses that have a picture. */
  addresses(): number[] {
    if (!this.dir) return [...this.mem.keys()].sort((a, b) => a - b);
    return readdirSync(this.dir).map((f) => /^(\d{1,4})\.jpg$/.exec(f)?.[1]).filter((x): x is string => !!x).map(Number).filter((n) => n >= 1 && n <= 9999).sort((a, b) => a - b);
  }
}

/**
 * Make the garage agree with the files: a picture of a loco that is no longer listed is removed, a listed loco gets the
 * version of its picture, a version without a file is cleared. Used at start-up and after a restore.
 */
export function syncGarageImages(garage: Garage, images: LocoImageStore) {
  const known = new Set(garage.list().map((l) => l.address));
  for (const a of images.addresses()) if (!known.has(a)) images.remove(a);
  for (const l of garage.list()) garage.setImageVersion(l.address, images.has(l.address) ? images.version(l.address) : undefined);
}

export function registerLocoImageRoutes(app: FastifyInstance, garage: Garage, images: LocoImageStore, changed: () => void) {
  // The picture comes as the raw request body. The limit is generous here; checkJpeg gives the clear 413 message.
  app.addContentTypeParser("image/jpeg", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.put<{ Params: { addr: string } }>("/api/garage/:addr/image", async (req) => {
    const address = parseAddress(req.params.addr);
    const jpeg = checkJpeg(req.body);
    if (!garage.get(address)) garage.upsert(address, { source: "manual" });
    const previous = images.get(address);
    try {
      const version = images.set(address, jpeg);
      garage.setImageVersion(address, version);
      changed();
      return { imageVersion: version };
    } catch (e) {
      // Do not leave a picture the garage does not know about.
      try { if (previous) images.set(address, previous); else images.remove(address); } catch { /* keep the original error */ }
      throw e;
    }
  });

  app.get<{ Params: { addr: string } }>("/api/garage/:addr/image", async (req, reply) => {
    const address = parseAddress(req.params.addr);
    const bytes = images.get(address);
    if (!bytes) throw fail(404, "Kein Bild vorhanden");
    const etag = `"${images.version(address)}"`;
    reply.header("etag", etag).header("cache-control", "no-cache").header("x-content-type-options", "nosniff");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply
      .header("content-type", "image/jpeg")
      .header("content-security-policy", "default-src 'none'; sandbox");
    return reply.send(bytes);
  });

  // Idempotent: also cleans a stale version in the garage when the file is already gone.
  app.delete<{ Params: { addr: string } }>("/api/garage/:addr/image", async (req) => {
    const address = parseAddress(req.params.addr);
    const removed = images.remove(address);
    garage.setImageVersion(address, undefined);
    changed();
    return { removed };
  });
}
