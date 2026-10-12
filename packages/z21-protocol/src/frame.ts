/** Z21 LAN frame: [len u16le][header u16le][data...]; len includes the 4 header bytes. */
export interface Frame {
  header: number;
  data: Buffer;
}

export const Z21_PORT = 21105;
export const Z21_PORT_ALT = 21106;

export function encodeFrame(header: number, data: Buffer | number[] = []): Buffer {
  const body = Buffer.from(data);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt16LE(out.length, 0);
  out.writeUInt16LE(header, 2);
  body.copy(out, 4);
  return out;
}

/** One UDP datagram may contain several frames back to back. */
export function decodeFrames(buf: Buffer): Frame[] {
  const frames: Frame[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt16LE(off);
    if (len < 4 || off + len > buf.length) break;
    frames.push({ header: buf.readUInt16LE(off + 2), data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return frames;
}

export const xor = (bytes: ArrayLike<number>): number => {
  let x = 0;
  for (let i = 0; i < bytes.length; i++) x ^= bytes[i]!;
  return x;
};

/** LAN_X_* frame (header 0x40): data = [xHeader, ...db, xor(xHeader..db)] */
export function encodeX(xHeader: number, db: number[] = []): Buffer {
  const body = [xHeader, ...db];
  return encodeFrame(0x40, [...body, xor(body)]);
}

export class ChecksumError extends Error {}

/** Splits an X-Bus payload into header + data bytes and verifies the XOR. */
export function decodeX(data: Buffer): { xHeader: number; db: number[] } {
  if (data.length < 2) throw new ChecksumError("X-Bus frame too short");
  const body = [...data.subarray(0, data.length - 1)];
  if (xor(body) !== data[data.length - 1]) throw new ChecksumError("X-Bus checksum mismatch");
  return { xHeader: body[0]!, db: body.slice(1) };
}
