import dgram from "node:dgram";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildReadRequest, decryptWords, encryptWords, MaintenanceRead, parseMaintenanceResponse, parseNetworkSettings } from "@z21/protocol";
import { readNetworkSettings } from "./maintenance.js";

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
