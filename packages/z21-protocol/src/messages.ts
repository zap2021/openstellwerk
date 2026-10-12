import { ChecksumError, decodeX, encodeFrame, encodeX, type Frame } from "./frame.js";

export type TrackPower = "off" | "on" | "shortCircuit" | "programming" | "emergencyStop";

export interface LocoInfo {
  address: number;
  steps: 14 | 28 | 128 | 0;
  busy: boolean;
  forward: boolean;
  /** 0 = stop, 1..126 on 128-step locos; raw value for 14/28 steps */
  speed: number;
  emergencyStop: boolean;
  /** index = function number F0..F28 */
  functions: boolean[];
}

export interface SystemState {
  mainCurrent: number; // mA
  progCurrent: number; // mA
  filteredMainCurrent: number; // mA
  temperature: number; // °C
  supplyVoltage: number; // mV
  vccVoltage: number; // mV
  centralState: number;
  centralStateEx: number;
  capabilities: number;
}

export type Message =
  | { type: "serial"; serial: number }
  | { type: "hwinfo"; hwType: number; hwName: string; fwVersion: string }
  | { type: "version"; xbusVersion: string; commandStationId: number }
  | { type: "trackPower"; state: TrackPower }
  | { type: "status"; emergencyStop: boolean; trackVoltageOff: boolean; shortCircuit: boolean; programmingMode: boolean }
  | { type: "locoInfo"; info: LocoInfo }
  | { type: "turnoutInfo"; address: number; position: "unknown" | "p0" | "p1" | "invalid" }
  | { type: "cv"; cv: number; value: number }
  | { type: "cvError"; reason: "shortCircuit" | "noAck" }
  | { type: "broadcastFlags"; flags: number }
  | { type: "systemState"; state: SystemState }
  | { type: "unknown"; header: number; data: Buffer };

export const HW_TYPES: Record<number, string> = {
  0x200: "Z21 (alt)",
  0x201: "Z21 (alt)",
  0x202: "SmartRail",
  0x203: "z21 small",
  0x204: "z21 start",
  0x205: "singleBooster",
  0x206: "dualBooster",
  0x211: "Z21 XL",
  0x212: "XL Booster",
  0x301: "Z21 switch decoder",
  0x302: "Z21 signal decoder",
};

const bcd = (b: number) => (b >> 4) * 10 + (b & 0x0f);
const toBcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | n % 10;

export function parseLocoInfo(db: number[]): LocoInfo {
  const address = ((db[0]! & 0x3f) << 8) | db[1]!;
  const s = db[2]! & 0x07;
  const steps = s === 0 ? 14 : s === 2 ? 28 : s === 4 ? 128 : 0;
  const v = db[3]! & 0x7f;
  const functions: boolean[] = [!!(db[4]! & 0x10)];
  for (let i = 0; i < 4; i++) functions.push(!!(db[4]! & (1 << i)));
  for (const byte of [db[5] ?? 0, db[6] ?? 0, db[7] ?? 0]) for (let i = 0; i < 8; i++) functions.push(!!(byte & (1 << i)));
  return {
    address,
    steps,
    busy: !!(db[2]! & 0x08),
    forward: !!(db[3]! & 0x80),
    speed: steps === 128 ? (v <= 1 ? 0 : v - 1) : v,
    emergencyStop: v === 1,
    functions,
  };
}

function parseX(data: Buffer): Message {
  const { xHeader, db } = decodeX(data);
  switch (xHeader) {
    case 0x61:
      if (db[0] === 0x00) return { type: "trackPower", state: "off" };
      if (db[0] === 0x01) return { type: "trackPower", state: "on" };
      if (db[0] === 0x02) return { type: "trackPower", state: "programming" };
      if (db[0] === 0x08) return { type: "trackPower", state: "shortCircuit" };
      if (db[0] === 0x12) return { type: "cvError", reason: "shortCircuit" };
      if (db[0] === 0x13) return { type: "cvError", reason: "noAck" };
      break;
    case 0x62:
      return {
        type: "status",
        emergencyStop: !!(db[1]! & 0x01),
        trackVoltageOff: !!(db[1]! & 0x02),
        shortCircuit: !!(db[1]! & 0x04),
        programmingMode: !!(db[1]! & 0x20),
      };
    case 0x63:
      if (db[0] === 0x21) return { type: "version", xbusVersion: db[1]!.toString(16), commandStationId: db[2]! };
      break;
    case 0x81:
      return { type: "trackPower", state: "emergencyStop" };
    case 0x64:
      if (db[0] === 0x14) return { type: "cv", cv: ((db[1]! << 8) | db[2]!) + 1, value: db[3]! };
      break;
    case 0x43: {
      const z = db[2]! & 0x03;
      return {
        type: "turnoutInfo",
        address: ((db[0]! << 8) | db[1]!) + 1,
        position: (["unknown", "p0", "p1", "invalid"] as const)[z]!,
      };
    }
    case 0xef:
      return { type: "locoInfo", info: parseLocoInfo(db) };
  }
  return { type: "unknown", header: 0x40, data };
}

export function parseFrame(f: Frame): Message {
  const d = f.data;
  try {
    switch (f.header) {
      case 0x10:
        return { type: "serial", serial: d.readUInt32LE(0) };
      case 0x1a: {
        const hwType = d.readUInt32LE(0);
        const fw = d.readUInt32LE(4);
        return {
          type: "hwinfo",
          hwType,
          hwName: HW_TYPES[hwType] ?? `0x${hwType.toString(16)}`,
          fwVersion: `${bcd((fw >> 8) & 0xff)}.${bcd(fw & 0xff).toString().padStart(2, "0")}`,
        };
      }
      case 0x51:
        return { type: "broadcastFlags", flags: d.readUInt32LE(0) };
      case 0x84:
        return {
          type: "systemState",
          state: {
            mainCurrent: d.readInt16LE(0),
            progCurrent: d.readInt16LE(2),
            filteredMainCurrent: d.readInt16LE(4),
            temperature: d.readInt16LE(6),
            supplyVoltage: d.readUInt16LE(8),
            vccVoltage: d.readUInt16LE(10),
            centralState: d[12]!,
            centralStateEx: d[13]!,
            capabilities: d[15] ?? 0,
          },
        };
      case 0x40:
        return parseX(d);
    }
  } catch (e) {
    if (!(e instanceof ChecksumError) && !(e instanceof RangeError)) throw e;
  }
  return { type: "unknown", header: f.header, data: d };
}

/* ---- builders used by the simulator (command station -> client) ---- */

export const reply = {
  serial: (serial: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(serial);
    return encodeFrame(0x10, b);
  },
  hwinfo: (hwType: number, fwMajor: number, fwMinor: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(hwType, 0);
    b.writeUInt32LE((toBcd(fwMajor) << 8) | toBcd(fwMinor), 4);
    return encodeFrame(0x1a, b);
  },
  broadcastFlags: (flags: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(flags >>> 0);
    return encodeFrame(0x51, b);
  },
  version: () => encodeX(0x63, [0x21, 0x30, 0x12]),
  trackPower: (s: TrackPower) =>
    s === "emergencyStop"
      ? encodeX(0x81, [0x00])
      : encodeX(0x61, [{ off: 0, on: 1, programming: 2, shortCircuit: 8 }[s]]),
  status: (centralState: number) => encodeX(0x62, [0x22, centralState]),
  cv: (cv: number, value: number) => encodeX(0x64, [0x14, (cv - 1) >> 8, (cv - 1) & 0xff, value]),
  cvError: (reason: "shortCircuit" | "noAck") => encodeX(0x61, [reason === "noAck" ? 0x13 : 0x12]),
  turnoutInfo: (addr: number, position: 0 | 1 | 2) => encodeX(0x43, [(addr - 1) >> 8, (addr - 1) & 0xff, position]),
  locoInfo: (i: LocoInfo) => {
    const f = (from: number, to: number) => {
      let b = 0;
      for (let n = from; n <= to; n++) if (i.functions[n]) b |= 1 << (n - from);
      return b;
    };
    const msb = i.address >= 128 ? (i.address >> 8) | 0xc0 : 0;
    const v = i.emergencyStop ? 1 : i.speed === 0 ? 0 : i.speed + 1;
    return encodeX(0xef, [
      msb, i.address & 0xff, 4 | (i.busy ? 8 : 0),
      (i.forward ? 0x80 : 0) | v,
      (i.functions[0] ? 0x10 : 0) | f(1, 4), f(5, 12), f(13, 20), f(21, 28),
    ]);
  },
  systemState: (s: SystemState) => {
    const b = Buffer.alloc(16);
    b.writeInt16LE(s.mainCurrent, 0);
    b.writeInt16LE(s.progCurrent, 2);
    b.writeInt16LE(s.filteredMainCurrent, 4);
    b.writeInt16LE(s.temperature, 6);
    b.writeUInt16LE(s.supplyVoltage, 8);
    b.writeUInt16LE(s.vccVoltage, 10);
    b[12] = s.centralState;
    b[13] = s.centralStateEx;
    b[15] = s.capabilities;
    return encodeFrame(0x84, b);
  },
};
