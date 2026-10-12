import { ChecksumError, decodeX, encodeFrame, encodeX, type Frame } from "./frame.js";
import { decodeLocoNet, type LocoNetDecoded } from "./loconet.js";
import {
  bcd, encodeName, parseBoosterState, parseCanBooster, parseDecoderState, parseFastClock, parseFastClockSettings,
  parseName, parseRmBus, parseZLinkHwInfo,
  type BoosterSystemState, type CanBoosterState, type DecoderState, type FastClockSettings, type FastClockTime,
  type RmBusData, type ZLinkHwInfo,
} from "./devices.js";

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

export interface RailComData {
  address: number;
  receiveCounter: number;
  errorCounter: number;
  /** undefined if the decoder does not report it */
  speed?: number;
  qos?: number;
}

export type LocoNetDirection = "rx" | "tx" | "lan";

export type LocoNetDetectorEvent =
  | { kind: "occupancy"; occupied: boolean }
  | { kind: "transponder"; present: boolean; locoAddress: number }
  | { kind: "lissyLoco"; locoAddress: number; forward?: boolean; classInfo: number }
  | { kind: "lissyBlock"; occupied: boolean }
  | { kind: "lissySpeed"; speed: number }
  | { kind: "other"; type: number; info: number[] };

export interface CanDetectorValue {
  nid: number;
  /** configurable module address */
  moduleAddress: number;
  port: number;
  /** occupancy report */
  occupancy?: { occupied: boolean; voltage: boolean; overload: number };
  /** RailCom loco list chunk (type 0x11..0x1F); address 0 ends the list */
  locos?: { address: number; direction: "forward" | "backward" | "unknown" }[];
  type: number;
}

export type Message =
  | { type: "code"; code: "none" | "startLocked" | "startUnlocked" | number }
  | { type: "firmwareVersion"; version: string }
  | { type: "unknownCommand" }
  | { type: "locoMode"; address: number; mode: "dcc" | "mm" }
  | { type: "turnoutMode"; address: number; mode: "dcc" | "mm" }
  | { type: "extAccessory"; address: number; value: number; valid: boolean }
  | { type: "rmbus"; data: RmBusData }
  | { type: "fastClock"; time: FastClockTime }
  | { type: "fastClockSettings"; settings: FastClockSettings }
  | { type: "canDeviceName"; nid: number; name: string }
  | { type: "canBooster"; state: CanBoosterState }
  | { type: "deviceName"; device: "booster" | "decoder"; name: string }
  | { type: "boosterState"; state: BoosterSystemState }
  | { type: "decoderState"; state: DecoderState }
  | { type: "zlinkHwInfo"; info: ZLinkHwInfo }
  | { type: "railcom"; data: RailComData }
  | { type: "loconet"; direction: LocoNetDirection; bytes: number[]; decoded: LocoNetDecoded }
  | { type: "loconetDetector"; feedbackAddress: number; event: LocoNetDetectorEvent }
  | { type: "canDetector"; value: CanDetectorValue }
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

const toBcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | n % 10;

export function parseLocoInfo(db: number[]): LocoInfo {
  const address = ((db[0]! & 0x3f) << 8) | db[1]!;
  const s = db[2]! & 0x07;
  const steps = s === 0 ? 14 : s === 2 ? 28 : s === 4 ? 128 : 0;
  const v = db[3]! & 0x7f;
  const functions: boolean[] = [!!(db[4]! & 0x10)];
  for (let i = 0; i < 4; i++) functions.push(!!(db[4]! & (1 << i)));
  for (const byte of [db[5] ?? 0, db[6] ?? 0, db[7] ?? 0]) for (let i = 0; i < 8; i++) functions.push(!!(byte & (1 << i)));
  if (db.length > 8) for (let i = 0; i < 3; i++) functions.push(!!(db[8]! & (1 << i))); // F29..F31, FW >= 1.42
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
    case 0xf3:
      if (db[0] === 0x0a) return { type: "firmwareVersion", version: `${bcd(db[1]!)}.${bcd(db[2]!).toString().padStart(2, "0")}` };
      break;
    case 0x44:
      return { type: "extAccessory", address: ((db[0]! << 8) | db[1]!) - 3, value: db[2]!, valid: db[3] === 0 };
    case 0x61:
      if (db[0] === 0x82) return { type: "unknownCommand" };
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

export function parseRailCom(d: Buffer): RailComData {
  // The structure may grow in future firmware: read only the fields we know.
  const opt = d.length > 9 ? d[9]! : 0;
  return {
    address: d.readUInt16LE(0),
    receiveCounter: d.readUInt32LE(2),
    errorCounter: d.readUInt16LE(6),
    speed: opt & 0x03 ? d[10] : undefined,
    qos: opt & 0x04 ? d[11] : undefined,
  };
}

export function parseDetectorEvent(type: number, info: number[]): LocoNetDetectorEvent {
  switch (type) {
    case 0x01: return { kind: "occupancy", occupied: info[0] === 1 };
    case 0x02:
    case 0x03: return { kind: "transponder", present: type === 0x02, locoAddress: info[0]! | (info[1]! << 8) };
    case 0x10: {
      const e = info[2] ?? 0;
      return { kind: "lissyLoco", locoAddress: info[0]! | (info[1]! << 8), forward: e & 0x40 ? !(e & 0x20) : undefined, classInfo: e & 0x0f };
    }
    case 0x11: return { kind: "lissyBlock", occupied: info[0] === 1 };
    case 0x12: return { kind: "lissySpeed", speed: info[0]! | (info[1]! << 8) };
  }
  return { kind: "other", type, info };
}

const canLoco = (v: number) => ({
  address: v & 0x3fff,
  direction: (v & 0x8000 ? (v & 0x4000 ? "backward" : "forward") : "unknown") as "forward" | "backward" | "unknown",
});

export function parseCanDetector(d: Buffer): CanDetectorValue {
  const type = d[5]!;
  const v1 = d.readUInt16LE(6), v2 = d.readUInt16LE(8);
  const out: CanDetectorValue = { nid: d.readUInt16LE(0), moduleAddress: d.readUInt16LE(2), port: d[4]!, type };
  if (type === 0x01) out.occupancy = { occupied: (v1 & 0x1000) !== 0, voltage: (v1 & 0x0100) !== 0, overload: (v1 & 0xff00) === 0x1200 ? v1 & 0xff : 0 };
  else if (type >= 0x11 && type <= 0x1f) out.locos = [v1, v2].map(canLoco);
  return out;
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
      case 0x18:
        return { type: "code", code: d[0] === 0 ? "none" : d[0] === 1 ? "startLocked" : d[0] === 2 ? "startUnlocked" : d[0]! };
      case 0x60:
      case 0x70:
        return { type: f.header === 0x60 ? "locoMode" : "turnoutMode", address: ((d[0]! << 8) | d[1]!) + (f.header === 0x70 ? 1 : 0), mode: d[2] === 1 ? "mm" : "dcc" };
      case 0x80:
        return { type: "rmbus", data: parseRmBus(d) };
      case 0xcd:
        return { type: "fastClock", time: parseFastClock(d) };
      case 0xce:
        return { type: "fastClockSettings", settings: parseFastClockSettings(d) };
      case 0xc8:
        return { type: "canDeviceName", nid: d.readUInt16LE(0), name: parseName(d.subarray(2)) };
      case 0xca:
        return { type: "canBooster", state: parseCanBooster(d) };
      case 0xb8:
        return { type: "deviceName", device: "booster", name: parseName(d) };
      case 0xd8:
        return { type: "deviceName", device: "decoder", name: parseName(d) };
      case 0xba:
        return { type: "boosterState", state: parseBoosterState(d) };
      case 0xda: {
        const state = parseDecoderState(d);
        if (state) return { type: "decoderState", state };
        break;
      }
      case 0xe8:
        if (d[0] === 0x06) return { type: "zlinkHwInfo", info: parseZLinkHwInfo(d) };
        break;
      case 0x88:
        return { type: "railcom", data: parseRailCom(d) };
      case 0xa0:
      case 0xa1:
      case 0xa2: {
        const bytes = [...d];
        return { type: "loconet", direction: f.header === 0xa0 ? "rx" : f.header === 0xa1 ? "tx" : "lan", bytes, decoded: decodeLocoNet(bytes) };
      }
      case 0xa4:
        return { type: "loconetDetector", feedbackAddress: d.readUInt16LE(1), event: parseDetectorEvent(d[0]!, [...d.subarray(3)]) };
      case 0xc4:
        return { type: "canDetector", value: parseCanDetector(d) };
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
  code: (code: number) => encodeFrame(0x18, [code]),
  firmwareVersion: (major: number, minor: number) => encodeX(0xf3, [0x0a, toBcd(major), toBcd(minor)]),
  unknownCommand: () => encodeX(0x61, [0x82]),
  mode: (header: 0x60 | 0x70, wireAddr: number, mode: "dcc" | "mm") => encodeFrame(header, [wireAddr >> 8, wireAddr & 0xff, mode === "mm" ? 1 : 0]),
  extAccessory: (addr: number, value: number, valid = true) =>
    encodeX(0x44, [(addr + 3) >> 8, (addr + 3) & 0xff, value, valid ? 0 : 0xff]),
  rmbus: (group: number, bytes: number[]) => encodeFrame(0x80, [group, ...Array.from({ length: 10 }, (_, i) => bytes[i] ?? 0)]),
  fastClock: (t: { weekday: number; hour: number; minute: number; second: number; rate: number; stopped: boolean; halted: boolean; settings: number }) => {
    const body = [0x66, 0x25, (t.weekday << 5) | t.hour, t.minute, (t.stopped ? 0x80 : 0) | (t.halted ? 0x40 : 0) | t.second, t.rate, t.settings];
    return encodeFrame(0xcd, [...body, body.reduce((a, b) => a ^ b, 0)]);
  },
  fastClockSettings: (settings: number, rate: number, weekday: number, hour: number, minute: number) =>
    encodeFrame(0xce, [settings, rate, (weekday << 5) | hour, minute]),
  canDeviceName: (nid: number, name: string) => encodeFrame(0xc8, [nid & 0xff, nid >> 8, ...encodeName(name, 16)]),
  canBooster: (nid: number, port: number, state: number, voltage: number, current: number) => {
    const b = Buffer.alloc(10);
    b.writeUInt16LE(nid, 0); b.writeUInt16LE(port, 2); b.writeUInt16LE(state, 4); b.writeUInt16LE(voltage, 6); b.writeUInt16LE(current, 8);
    return encodeFrame(0xca, b);
  },
  deviceName: (device: "booster" | "decoder", name: string) => encodeFrame(device === "booster" ? 0xb8 : 0xd8, encodeName(name, 32)),
  /** raw 24 byte BoosterSystemState */
  boosterState: (b: Buffer) => encodeFrame(0xba, b),
  /** raw 44 (switch) or 42 (signal) byte decoder state */
  decoderState: (b: Buffer) => encodeFrame(0xda, b),
  zlinkHwInfo: (hwId: number, major: number, minor: number, build: number, mac: string, name: string) => {
    const b = Buffer.alloc(59);
    b[0] = 0x06;
    b.writeUInt16LE(hwId, 1); b[3] = major; b[4] = minor; b.writeUInt16LE(build, 5);
    b.write(mac, 7, 18, "latin1"); b.write(name, 25, 33, "latin1");
    return encodeFrame(0xe8, b);
  },
  railcom: (r: RailComData) => {
    const b = Buffer.alloc(13);
    b.writeUInt16LE(r.address, 0);
    b.writeUInt32LE(r.receiveCounter, 2);
    b.writeUInt16LE(r.errorCounter, 6);
    b[9] = (r.speed !== undefined ? 0x01 : 0) | (r.qos !== undefined ? 0x04 : 0);
    b[10] = r.speed ?? 0;
    b[11] = r.qos ?? 0;
    return encodeFrame(0x88, b);
  },
  /** message must include its checksum byte */
  loconet: (direction: LocoNetDirection, bytes: number[]) =>
    encodeFrame(direction === "rx" ? 0xa0 : direction === "tx" ? 0xa1 : 0xa2, bytes),
  loconetDetector: (type: number, feedbackAddress: number, info: number[]) =>
    encodeFrame(0xa4, [type, feedbackAddress & 0xff, feedbackAddress >> 8, ...info]),
  /** value1/value2 raw as defined by LAN_CAN_DETECTOR */
  canDetector: (nid: number, moduleAddress: number, port: number, type: number, value1: number, value2 = 0) => {
    const b = Buffer.alloc(10);
    b.writeUInt16LE(nid, 0);
    b.writeUInt16LE(moduleAddress, 2);
    b[4] = port;
    b[5] = type;
    b.writeUInt16LE(value1, 6);
    b.writeUInt16LE(value2, 8);
    return encodeFrame(0xc4, b);
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
