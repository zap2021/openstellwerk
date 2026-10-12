/** Parsers/types for fast clock, R-BUS, CAN boosters and zLink devices (spec chapters 7, 10.2, 11, 12). */

export const bcd = (b: number) => (b >> 4) * 10 + (b & 0x0f);

/* ---------- fast clock ---------- */

export const FastClockFlag = {
  LocoNet: 0x01,
  XBus: 0x02,
  Dcc: 0x08,
  MrClock: 0x10,
  HaltOnEmergency: 0x40,
  Enabled: 0x80,
} as const;

export interface FastClockTime {
  /** 0 = Monday .. 6 = Sunday */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  /** acceleration factor, 1 = real time */
  rate: number;
  /** the fast clock is not running (disabled or rate 0) */
  stopped: boolean;
  /** temporarily paused, e.g. by emergency stop or short circuit */
  halted: boolean;
  settings: number;
}

export interface FastClockSettings {
  settings: number;
  rate: number;
  startWeekday: number;
  startHour: number;
  startMinute: number;
}

export function parseFastClock(d: Buffer): FastClockTime {
  return {
    weekday: d[2]! >> 5,
    hour: d[2]! & 0x1f,
    minute: d[3]! & 0x3f,
    second: d[4]! & 0x3f,
    stopped: !!(d[4]! & 0x80),
    halted: !!(d[4]! & 0x40),
    rate: d[5]! & 0x3f,
    settings: d[6]!,
  };
}

export function parseFastClockSettings(d: Buffer): FastClockSettings {
  return { settings: d[0]!, rate: d[1]!, startWeekday: d[2]! >> 5, startHour: d[2]! & 0x1f, startMinute: d[3]! & 0x3f };
}

/* ---------- R-BUS feedback ---------- */

export interface RmBusData {
  /** 0 = modules 1..10, 1 = modules 11..20 */
  group: number;
  /** one byte per module, one bit per input */
  modules: { module: number; inputs: boolean[] }[];
}

export function parseRmBus(d: Buffer): RmBusData {
  const group = d[0]!;
  const modules = [];
  for (let i = 0; i < 10; i++) {
    const b = d[1 + i] ?? 0;
    modules.push({ module: group * 10 + i + 1, inputs: Array.from({ length: 8 }, (_, bit) => !!(b & (1 << bit))) });
  }
  return { group, modules };
}

/* ---------- names ---------- */

/** Names are null-terminated ISO-8859-1; 0xFF in the first byte means "never stored". */
export function parseName(d: Buffer): string {
  if (d.length === 0 || d[0] === 0xff) return "";
  const end = d.indexOf(0);
  return d.subarray(0, end < 0 ? d.length : end).toString("latin1");
}

/** Encodes a device name, zero padded to `size`. Quote and backslash are forbidden by the spec. */
export function encodeName(name: string, size: number): Buffer {
  if (/["\\]/.test(name)) throw new RangeError('name must not contain " or \\');
  const raw = Buffer.from(name, "latin1");
  if (raw.length >= size) throw new RangeError(`name too long (max ${size - 1} characters)`);
  const out = Buffer.alloc(size);
  raw.copy(out);
  return out;
}

/* ---------- CAN booster (10.2) ---------- */

export interface CanBoosterState {
  nid: number;
  /** 1 or 2 */
  outputPort: number;
  /** raw Booster_State bits */
  state: number;
  brakeGenerator: boolean;
  shortCircuit: boolean;
  trackVoltageOff: boolean;
  railComActive: boolean;
  outputDisabled: boolean;
  voltage: number; // mV
  current: number; // mA
}

export function parseCanBooster(d: Buffer): CanBoosterState {
  const state = d.readUInt16LE(4);
  return {
    nid: d.readUInt16LE(0),
    outputPort: d.readUInt16LE(2),
    state,
    brakeGenerator: !!(state & 0x0001),
    shortCircuit: !!(state & 0x0020),
    trackVoltageOff: !!(state & 0x0080),
    outputDisabled: !!(state & 0x0100),
    railComActive: !!(state & 0x0800),
    voltage: d.readUInt16LE(6),
    current: d.readUInt16LE(8),
  };
}

/* ---------- zLink booster (11.2) ---------- */

export interface BoosterSystemState {
  current: [number, number]; // mA per output
  filteredCurrent: [number, number];
  temperature: [number, number]; // °C
  supplyVoltage: number; // mV
  voltage: [number, number]; // mV per output
  centralState: number;
  centralStateEx: number;
  centralStateEx2: number;
  centralStateEx3: number;
  /** derived flags */
  trackVoltageOff: boolean;
  shortCircuit: [boolean, boolean];
  outputDisabled: [boolean, boolean];
  railComActive: [boolean, boolean];
}

export function parseBoosterState(d: Buffer): BoosterSystemState {
  const ex = d[19]!, ex2 = d[20]!, ex3 = d[22]!, cs = d[18]!;
  return {
    current: [d.readInt16LE(0), d.readInt16LE(2)],
    filteredCurrent: [d.readInt16LE(4), d.readInt16LE(6)],
    temperature: [d.readInt16LE(8), d.readInt16LE(10)],
    supplyVoltage: d.readUInt16LE(12),
    voltage: [d.readUInt16LE(14), d.readUInt16LE(16)],
    centralState: cs,
    centralStateEx: ex,
    centralStateEx2: ex2,
    centralStateEx3: ex3,
    trackVoltageOff: !!(cs & 0x02),
    shortCircuit: [!!(ex & 0x04), !!(ex & 0x08)],
    outputDisabled: [!!(ex3 & 0x10), !!(ex3 & 0x20)],
    railComActive: [!!(ex2 & 0x01), !!(ex2 & 0x02)],
  };
}

/* ---------- zLink decoders (11.3) ---------- */

export const OutputState = { 0x00: "unknown", 0x11: "red active", 0x01: "red inactive", 0x12: "green active", 0x02: "green inactive" } as Record<number, string>;
export const OutputConfig = ["pulse", "alternating blinker", "blinker with fade", "momentary (10775)", "continuous", "continuous with fade"];

export interface SwitchDecoderState {
  kind: "switch";
  current: number;
  filteredCurrent: number;
  voltage: number;
  centralState: number;
  centralStateEx: number;
  outputs: { state: string; config: string; dimm: number }[];
  address: number;
  address2: number;
  dimmedMask: number;
  trackVoltageOff: boolean;
  shortCircuit: boolean;
  configMode: boolean;
}

export interface SignalDecoderState {
  kind: "signal";
  voltage: number;
  centralState: number;
  centralStateEx: number;
  /** A1..A8, B1..B8 */
  outputsOn: boolean[];
  outputsBlinking: boolean[];
  signalCount: number;
  signals: { dccExt: number; aspectIndex: number; signalId: number; initAspect: number }[];
  address: number;
  trackVoltageOff: boolean;
  shortCircuit: boolean;
  configMode: boolean;
}

export type DecoderState = SwitchDecoderState | SignalDecoderState;

export function parseDecoderState(d: Buffer): DecoderState | undefined {
  const cs = d[6]!, ex = d[7]!;
  const base = { centralState: cs, centralStateEx: ex, trackVoltageOff: !!(cs & 0x02), shortCircuit: !!(cs & 0x04), configMode: !!(cs & 0x10) };
  if (d.length >= 44) {
    return {
      kind: "switch", ...base,
      current: d.readInt16LE(0), filteredCurrent: d.readInt16LE(2), voltage: d.readUInt16LE(4),
      outputs: Array.from({ length: 8 }, (_, i) => ({
        state: OutputState[d[8 + i]!] ?? `0x${d[8 + i]!.toString(16)}`,
        config: OutputConfig[d[16 + i]!] ?? `${d[16 + i]}`,
        dimm: d[24 + i]!,
      })),
      address: d.readUInt16LE(32), address2: d.readUInt16LE(34), dimmedMask: d[42]!,
    };
  }
  if (d.length >= 42) {
    const bits = (b0: number, b1: number) => Array.from({ length: 16 }, (_, i) => !!((i < 8 ? b0 : b1) & (1 << (i % 8))));
    const count = d[23]!;
    return {
      kind: "signal", ...base,
      voltage: d.readUInt16LE(4),
      outputsOn: bits(d[8]!, d[9]!), outputsBlinking: bits(d[10]!, d[11]!),
      signalCount: count,
      signals: Array.from({ length: 4 }, (_, i) => ({ dccExt: d[12 + i]!, aspectIndex: d[16 + i]!, signalId: d[24 + i]!, initAspect: d[28 + i]! })).slice(0, count || 4),
      address: d.readUInt16LE(32),
    };
  }
  return undefined;
}

export interface ZLinkHwInfo {
  hwId: number;
  fwVersion: string;
  mac: string;
  name: string;
}

export function parseZLinkHwInfo(d: Buffer): ZLinkHwInfo {
  const str = (from: number, len: number) => {
    const s = d.subarray(from, from + len);
    const z = s.indexOf(0);
    return s.subarray(0, z < 0 ? s.length : z).toString("latin1");
  };
  // d[0] = 0x06 message type, then Z_Hw_Info
  return {
    hwId: d.readUInt16LE(1),
    fwVersion: `${d[3]}.${d[4]}.${d.readUInt16LE(5)}`,
    mac: str(7, 18),
    name: str(25, 33),
  };
}
