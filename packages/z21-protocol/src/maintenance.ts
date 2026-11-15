/**
 * Z21 maintenance channel (UDP 21106), READ-ONLY subset.
 * Reconstructed by static analysis of Z21_Maintenance.exe, see docs/maintenance-protocol-notes.md.
 * NOT verified against hardware yet. Deliberately contains no write commands.
 */

export const MAINTENANCE_PORT = 21106;

/** Read commands (write = +0x10, reset = +0x20 exist in the original tool and are intentionally not implemented). */
export const MaintenanceRead = { mac: 0x181, ip: 0x182, description: 0x183, controlBlock: 0x184 } as const;

const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
const initState = (key: number) => ((((key ^ 0x731b) & 0xffff) | (((key ^ 0xc57a) & 0xffff) << 16)) >>> 0);

/** Chained word cipher over the payload (bytes 8..), whole 32-bit words only, key = the frame's sequence word. */
export function encryptWords(buf: Uint8Array, key: number): Uint8Array {
  const out = Uint8Array.from(buf);
  const v = new DataView(out.buffer);
  let s = initState(key);
  for (let i = 0; i + 4 <= out.length; i += 4) {
    const c = (rol((v.getUint32(i, true) ^ s) >>> 0, 19) ^ s) >>> 0;
    v.setUint32(i, c, true);
    s = c;
  }
  return out;
}

export function decryptWords(buf: Uint8Array, key: number): Uint8Array {
  const out = Uint8Array.from(buf);
  const v = new DataView(out.buffer);
  let s = initState(key);
  for (let i = 0; i + 4 <= out.length; i += 4) {
    const c = v.getUint32(i, true);
    v.setUint32(i, (rol((c ^ s) >>> 0, 13) ^ s) >>> 0, true);
    s = c;
  }
  return out;
}

/** Request header: len(2) cmd(2) reserved(2) seq(2) param(4)=0 expectedLen(4); bit 15 of len marks the encrypted tail. */
export function buildReadRequest(cmd: number, expectedLength: number, seq: number): Buffer {
  const f = Buffer.alloc(16);
  f.writeUInt16LE(0x10, 0);
  f.writeUInt16LE(cmd, 2);
  f.writeUInt16LE(seq & 0xffff, 6);
  f.writeUInt32LE(expectedLength, 12);
  f.set(encryptWords(f.subarray(8, 16), seq), 8);
  f.writeUInt16LE(0x10 | 0x8000, 0);
  return f;
}

export interface MaintenanceResponse {
  cmd: number;
  /** 0 = ok */
  result: number;
  seq: number;
  data: Buffer;
}

export function parseMaintenanceResponse(pkt: Buffer): MaintenanceResponse {
  if (pkt.length < 8) throw new RangeError("Antwort vom Wartungsport ist kürzer als ihr Kopf (8 Bytes)");
  const rawLen = pkt.readUInt16LE(0);
  const len = Math.min(rawLen & 0x7fff, pkt.length);
  const seq = pkt.readUInt16LE(6);
  const b = Buffer.from(pkt.subarray(0, len));
  if (rawLen & 0x8000 && len > 8) b.set(decryptWords(b.subarray(8, len), seq), 8);
  const dataLen = len >= 16 ? Math.min(b.readUInt32LE(12), len - 16) : 0;
  return { cmd: b.readUInt16LE(2), result: b.readUInt16LE(4), seq, data: Buffer.from(b.subarray(16, 16 + dataLen)) };
}

export interface NetworkSettings {
  /** the 12 data bytes as received */
  raw: string;
  /** bytes taken in wire order (a.b.c.d = byte0..3) */
  asIs: { ip: string; mask: string; gateway: string };
  /** bytes reversed (little-endian DWORD printed high byte first) */
  reversed: { ip: string; mask: string; gateway: string };
}

const dotted = (b: Buffer, o: number, rev: boolean) => (rev ? [b[o + 3], b[o + 2], b[o + 1], b[o]] : [b[o], b[o + 1], b[o + 2], b[o + 3]]).join(".");

export function parseNetworkSettings(data: Buffer): NetworkSettings {
  if (data.length < 12) throw new RangeError("Die Netzwerkeinstellungen müssen 12 Bytes lang sein");
  const pick = (rev: boolean) => ({ ip: dotted(data, 0, rev), mask: dotted(data, 4, rev), gateway: dotted(data, 8, rev) });
  return { raw: data.subarray(0, 12).toString("hex"), asIs: pick(false), reversed: pick(true) };
}
