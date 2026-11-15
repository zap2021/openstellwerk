import dgram from "node:dgram";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildReadRequest, decryptWords, encryptWords, MaintenanceRead, parseMaintenanceResponse, parseNetworkSettings } from "@openstellwerk/protocol";
import Fastify from "fastify";
import { readNetworkSettings, registerMaintenanceRoutes } from "./maintenance.js";

it("matches the reference vectors of the original tool's cipher", () => {
  expect(buildReadRequest(0x182, 12, 0x1234).toString("hex")).toBe("10808201000034125cdb30deda2ab604");
  expect(decryptWords(encryptWords(Uint8Array.from({ length: 16 }, (_, i) => i), 0x4711), 0x4711)).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i));
});

it("parses both byte orders of the IP block", () => {
  const n = parseNetworkSettings(Buffer.from([192, 168, 178, 198, 255, 255, 255, 0, 192, 168, 178, 1]));
  expect(n.asIs).toEqual({ ip: "192.168.178.198", mask: "255.255.255.0", gateway: "192.168.178.1" });
  expect(n.reversed.ip).toBe("198.178.168.192");
});

/** A fake station answering like we believe the real one does (encrypted reply, IP stored little-endian). */
const fake = dgram.createSocket("udp4");
beforeAll(() => new Promise<void>((r) => {
  fake.on("message", (buf, rinfo) => {
    const req = parseMaintenanceResponse(buf);
    const data = req.cmd === MaintenanceRead.ip ? Buffer.from([1, 0, 0, 127, 0, 255, 255, 255, 1, 0, 0, 127]) : Buffer.from([1, 2, 3, 4, 5, 6]);
    const f = Buffer.alloc(16 + data.length);
    f.writeUInt16LE(16 + data.length, 0); f.writeUInt16LE(req.cmd, 2); f.writeUInt16LE(0, 4); f.writeUInt16LE(req.seq, 6); f.writeUInt32LE(data.length, 12);
    data.copy(f, 16);
    f.set(encryptWords(f.subarray(8), req.seq), 8);
    f.writeUInt16LE((16 + data.length) | 0x8000, 0);
    fake.send(f, rinfo.port, rinfo.address);
  });
  fake.bind(21777, "127.0.0.1", r);
}));
afterAll(() => fake.close());

it("reads settings and MAC over the maintenance channel and detects the byte order", async () => {
  const info = await readNetworkSettings("127.0.0.1", { port: 21777, timeoutMs: 1000 });
  expect(info.mac).toBe("01:02:03:04:05:06");
  expect(info.verifiedOrder).toBe("reversed");
  expect(info.reversed.ip).toBe("127.0.0.1");
});

it("reports a clear timeout when nothing answers", async () => {
  await expect(readNetworkSettings("127.0.0.1", { port: 21778, timeoutMs: 300 })).rejects.toMatchObject({ statusCode: 504 });
});

it("does not mistake its own request for the answer when the target is the local machine (issue #2)", async () => {
  // Default port 21106 on 127.0.0.1: the request is sent from local port 21106 to itself. The echo has the same
  // address and sequence number as a real answer, but it is not one.
  await expect(readNetworkSettings("127.0.0.1", { timeoutMs: 300 })).rejects.toMatchObject({ statusCode: 504 });
});

it("names what it ignored when nothing valid arrives, so a timeout can be diagnosed (issue #2)", async () => {
  const stray = dgram.createSocket("udp4");
  await new Promise<void>((r) => {
    stray.on("message", (buf, rinfo) => {
      const wrong = Buffer.from(buf);
      wrong.writeUInt16LE((wrong.readUInt16LE(6) + 1) & 0xffff, 6); // an answer to some other request
      stray.send(wrong, rinfo.port, rinfo.address);
    });
    stray.bind(21779, "127.0.0.1", r);
  });
  try {
    const err = await readNetworkSettings("127.0.0.1", { port: 21779, timeoutMs: 300 }).catch((e) => e as Error);
    expect(err).toMatchObject({ statusCode: 504 });
    expect((err as Error).message).toMatch(/Keine Antwort/);
    expect((err as Error).message).toMatch(/1 andere\(s\) Datagramm\(e\) ignoriert/);
    expect((err as Error).message).toMatch(/127\.0\.0\.1:\d+/); // where it came from
  } finally { stray.close(); }
});

it("refuses the network query in demo mode with a clear message, and without a connection (issue #2)", async () => {
  const app = Fastify();
  const station = { demo: true, client: { host: "127.0.0.1" } };
  registerMaintenanceRoutes(app, station as never);
  const demo = await app.inject({ method: "GET", url: "/api/network" });
  expect(demo.statusCode).toBe(409);
  expect(demo.json().message).toMatch(/Demo-Modus/);
  station.demo = false;
  station.client.host = undefined as never;
  expect((await app.inject({ method: "GET", url: "/api/network" })).statusCode).toBe(409);
  await app.close();
});
