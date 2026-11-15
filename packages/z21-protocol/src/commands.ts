import { encodeFrame, encodeX } from "./frame.js";
import { encodeName } from "./devices.js";

export type SpeedSteps = 14 | 28 | 128;

/** Loco addresses >= 128 are sent with the two top bits of the MSB set. */
export function locoAddr(addr: number): [number, number] {
  if (addr < 1 || addr > 9999) throw new RangeError(`Lokadresse ${addr} liegt nicht zwischen 1 und 9999`);
  return addr >= 128 ? [(addr >> 8) | 0xc0, addr & 0xff] : [0, addr];
}

export const Broadcast = {
  /** power, short circuit, programming, emergency stop */
  Basic: 0x00000001,
  RMBus: 0x00000002,
  RailComSubscribed: 0x00000004,
  SystemState: 0x00000100,
  /** fast clock time messages (FW >= 1.43) */
  FastClock: 0x00000010,
  /** loco info for ALL locos, not only subscribed ones (FW >= 1.20) */
  AllLocos: 0x00010000,
  /** CAN booster system state (FW >= 1.41) */
  CanBooster: 0x00020000,
  /** RailCom data of ALL locos without subscribing (FW >= 1.29, PC software only) */
  AllRailCom: 0x00040000,
  /** CAN occupancy detectors, LAN_CAN_DETECTOR (FW >= 1.30) */
  CanDetector: 0x00080000,
  /** LocoNet messages except locos and turnouts */
  LocoNet: 0x01000000,
  LocoNetLocos: 0x02000000,
  LocoNetSwitches: 0x04000000,
  /** LocoNet occupancy detectors, LAN_LOCONET_DETECTOR (FW >= 1.22) */
  LocoNetDetector: 0x08000000,
} as const;

/** Detector poll types for LAN_LOCONET_DETECTOR */
export const LocoNetDetectorPoll = { Sic: 0x80, ReportAddress: 0x81, Lissy: 0x82 } as const;

/** CAN network id meaning "all CAN occupancy detectors" */
export const CAN_ALL_DETECTORS = 0xd000;

/** LocoNet checksum: one's complement of the XOR of all preceding bytes. */
export const locoNetChecksum = (bytes: ArrayLike<number>): number => {
  let x = 0;
  for (let i = 0; i < bytes.length; i++) x ^= bytes[i]!;
  return ~x & 0xff;
};

/** POM address bytes for accessory decoders: aaaaaAAAACDDD = ((addr & 0x1FF) << 4) | CDDD */
function accessoryPomAddr(decoderAddr: number, output?: number): [number, number] {
  const v = ((decoderAddr & 0x1ff) << 4) | (output === undefined ? 0 : 0x08 | (output & 7));
  return [v >> 8, v & 0xff];
}

export const cmd = {
  getSerialNumber: () => encodeFrame(0x10),
  getHwInfo: () => encodeFrame(0x1a),
  logoff: () => encodeFrame(0x30),
  getVersion: () => encodeX(0x21, [0x21]),
  getStatus: () => encodeX(0x21, [0x24]),
  trackPowerOn: () => encodeX(0x21, [0x81]),
  trackPowerOff: () => encodeX(0x21, [0x80]),
  emergencyStop: () => encodeX(0x80),
  setBroadcastFlags: (flags: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(flags >>> 0);
    return encodeFrame(0x50, b);
  },
  getBroadcastFlags: () => encodeFrame(0x51),
  getSystemState: () => encodeFrame(0x85),

  getLocoInfo: (addr: number) => encodeX(0xe3, [0xf0, ...locoAddr(addr)]),
  /** speed: 0 = stop, 1..126 (128 steps). `emergency` sends the e-stop value. */
  setLocoDrive: (addr: number, speed: number, forward: boolean, steps: SpeedSteps = 128, emergency = false) => {
    const code = steps === 14 ? 0x10 : steps === 28 ? 0x12 : 0x13;
    const v = emergency ? 1 : speed === 0 ? 0 : speed + 1;
    return encodeX(0xe4, [code, ...locoAddr(addr), (forward ? 0x80 : 0) | (v & 0x7f)]);
  },
  /** fn 0..28, action: off | on | toggle */
  setLocoFunction: (addr: number, fn: number, action: "off" | "on" | "toggle") => {
    const t = action === "off" ? 0 : action === "on" ? 1 : 2;
    return encodeX(0xe4, [0xf8, ...locoAddr(addr), (t << 6) | (fn & 0x3f)]);
  },

  getCode: () => encodeFrame(0x18),
  getFirmwareVersion: () => encodeX(0xf1, [0x0a]),

  /** Loco/accessory output format is stored persistently in the Z21. Loco addresses >= 256 are always DCC. */
  getLocoMode: (addr: number) => encodeFrame(0x60, [addr >> 8, addr & 0xff]),
  setLocoMode: (addr: number, mode: "dcc" | "mm") => encodeFrame(0x61, [addr >> 8, addr & 0xff, mode === "mm" ? 1 : 0]),
  /** turnout addresses 1-based like everywhere else */
  getTurnoutMode: (addr: number) => encodeFrame(0x70, [(addr - 1) >> 8, (addr - 1) & 0xff]),
  setTurnoutMode: (addr: number, mode: "dcc" | "mm") => encodeFrame(0x71, [(addr - 1) >> 8, (addr - 1) & 0xff, mode === "mm" ? 1 : 0]),

  /** FW >= 1.43: DCC e-stop for one loco only */
  locoEStop: (addr: number) => encodeX(0x92, [...locoAddr(addr)]),
  /** FW >= 1.43: remove the loco from the Z21 refresh cycle */
  purgeLoco: (addr: number) => encodeX(0xe3, [0x44, ...locoAddr(addr)]),
  /** group: 0x20 F0-F4, 0x21 F5-F8, 0x22 F9-F12, 0x23 F13-F20, 0x28 F21-F28, 0x29 F29-F36 (FW >= 1.42) ... */
  setLocoFunctionGroup: (addr: number, group: number, bits: number) => encodeX(0xe4, [group, ...locoAddr(addr), bits & 0xff]),
  /** FW >= 1.42; state address 29..32767 */
  setLocoBinaryState: (addr: number, stateAddr: number, on: boolean) =>
    encodeX(0xe5, [0x5f, ...locoAddr(addr), (on ? 0x80 : 0) | (stateAddr & 0x7f), stateAddr >> 7]),

  /** Programming on the main (POM). CV numbers 1-based. No feedback except pomReadByte (needs RailCom). */
  pomWriteByte: (addr: number, cv: number, value: number) =>
    encodeX(0xe6, [0x30, ...locoAddr(addr), 0xec | (((cv - 1) >> 8) & 3), (cv - 1) & 0xff, value & 0xff]),
  pomWriteBit: (addr: number, cv: number, bit: number, value: boolean) =>
    encodeX(0xe6, [0x30, ...locoAddr(addr), 0xe8 | (((cv - 1) >> 8) & 3), (cv - 1) & 0xff, (value ? 8 : 0) | (bit & 7)]),
  pomReadByte: (addr: number, cv: number) =>
    encodeX(0xe6, [0x30, ...locoAddr(addr), 0xe4 | (((cv - 1) >> 8) & 3), (cv - 1) & 0xff, 0]),
  /** decoderAddr 0..511, output 0..7 or undefined for the whole decoder */
  pomAccessoryWriteByte: (decoderAddr: number, output: number | undefined, cv: number, value: number) =>
    encodeX(0xe6, [0x31, ...accessoryPomAddr(decoderAddr, output), 0xec | (((cv - 1) >> 8) & 3), (cv - 1) & 0xff, value & 0xff]),
  pomAccessoryWriteBit: (decoderAddr: number, output: number | undefined, cv: number, bit: number, value: boolean) =>
    encodeX(0xe6, [0x31, ...accessoryPomAddr(decoderAddr, output), 0xe8 | (((cv - 1) >> 8) & 3), (cv - 1) & 0xff, (value ? 8 : 0) | (bit & 7)]),
  pomAccessoryReadByte: (decoderAddr: number, output: number | undefined, cv: number) =>
    encodeX(0xe6, [0x31, ...accessoryPomAddr(decoderAddr, output), 0xe4 | (((cv - 1) >> 8) & 3), (cv - 1) & 0xff, 0]),

  /** Motorola 6021 register programming, register 1..79 */
  mmWriteByte: (reg: number, value: number) => encodeX(0x24, [0xff, 0, reg - 1, value & 0xff]),
  /** DCC register mode (very old decoders), register 1..8 */
  dccReadRegister: (reg: number) => encodeX(0x22, [0x11, reg]),
  dccWriteRegister: (reg: number, value: number) => encodeX(0x23, [0x12, reg, value & 0xff]),

  /** DCCext accessories / signals. addr is the displayed 1-based address; the wire address is RCN-213 raw (= addr + 3). */
  setExtAccessory: (addr: number, value: number) => encodeX(0x54, [(addr + 3) >> 8, (addr + 3) & 0xff, value & 0xff, 0]),
  getExtAccessoryInfo: (addr: number) => encodeX(0x44, [(addr + 3) >> 8, (addr + 3) & 0xff, 0]),
  /** RCN-213 emergency stop for all extended accessory decoders (raw address 2047) */
  extAccessoryEStop: () => encodeX(0x54, [0x07, 0xff, 0x00, 0]),

  /** R-BUS: group 0 = modules 1..10, group 1 = modules 11..20 */
  rmbusGetData: (group: 0 | 1) => encodeFrame(0x81, [group]),
  /** Start (1..20) or end (0) the programming sequence for ONE connected module */
  rmbusProgramModule: (address: number) => encodeFrame(0x82, [address]),

  fastClockGet: () => encodeFrame(0xcc, [0x21, 0x2a, 0x0b]),
  fastClockStart: () => encodeFrame(0xcc, [0x21, 0x2c, 0x0d]),
  fastClockStop: () => encodeFrame(0xcc, [0x21, 0x2d, 0x0c]),
  /** weekday 0 = Monday .. 6; rate 0..63 (1 = real time) */
  fastClockSet: (weekday: number, hour: number, minute: number, rate: number) => {
    const body = [0x24, 0x2b, ((weekday & 7) << 5) | (hour & 0x1f), minute & 0x3f, rate & 0x3f];
    return encodeFrame(0xcc, [...body, body.reduce((a, b) => a ^ b, 0)]);
  },
  fastClockSettingsGet: () => encodeFrame(0xce, [0x04]),
  fastClockSettingsSet: (settings: number, rate?: number, start?: { weekday: number; hour: number; minute: number }) => {
    const data = [settings & 0xff];
    if (rate !== undefined) {
      data.push(rate & 0x3f);
      if (start) data.push(((start.weekday & 7) << 5) | (start.hour & 0x1f), start.minute & 0x3f);
    }
    return encodeFrame(0xcf, data);
  },

  /** CAN boosters (via Z21, FW >= 1.41): NId 0xC101..0xC1FF */
  canDeviceGetDescription: (nid: number) => encodeFrame(0xc8, [nid & 0xff, nid >> 8]),
  canDeviceSetDescription: (nid: number, name: string) => encodeFrame(0xc9, [nid & 0xff, nid >> 8, ...encodeName(name, 16)]),
  /** power: 0x00 all off, 0xFF all on; 0x10/0x11 output 1 off/on, 0x20/0x22 output 2 off/on (FW >= 1.42) */
  canBoosterSetTrackPower: (nid: number, power: number) => encodeFrame(0xcb, [nid & 0xff, nid >> 8, power]),

  /** zLink boosters 10806/7/9 (directly, via 10838 Z21 pro LINK) */
  boosterGetDescription: () => encodeFrame(0xb8),
  boosterSetDescription: (name: string) => encodeFrame(0xb9, encodeName(name, 32)),
  boosterGetSystemState: () => encodeFrame(0xbb),
  /** port 1, 2 or 3 (all); on/off */
  boosterSetPower: (port: 1 | 2 | 3, on: boolean) => encodeFrame(0xb2, [port, on ? 1 : 0]),
  /** zLink decoders 10836/10837 */
  decoderGetDescription: () => encodeFrame(0xd8),
  decoderSetDescription: (name: string) => encodeFrame(0xd9, encodeName(name, 32)),
  decoderGetSystemState: () => encodeFrame(0xdb),
  zlinkGetHwInfo: () => encodeFrame(0xe8, [0x06]),

  /** Public turnout addresses are 1-based, the wire format is 0-based. */
  getTurnoutInfo: (addr: number) => encodeX(0x43, [(addr - 1) >> 8, (addr - 1) & 0xff]),
  setTurnout: (addr: number, output: 0 | 1, activate: boolean, queue = false) =>
    encodeX(0x53, [(addr - 1) >> 8, (addr - 1) & 0xff, 0x80 | (queue ? 0x20 : 0) | (activate ? 0x08 : 0) | output]),

  /** addr 0 = next loco from the Z21's circular buffer */
  railComGetData: (addr = 0) => encodeFrame(0x89, [0x01, addr & 0xff, addr >> 8]),

  /** `message` is the LocoNet message WITHOUT checksum; it is appended here. */
  loconetFromLan: (message: number[]) => encodeFrame(0xa2, [...message, locoNetChecksum(message)]),
  loconetDispatch: (addr: number) => encodeFrame(0xa3, [addr & 0xff, addr >> 8]),
  /** reportAddress only for type 0x81 (default 1017); the wire value is address - 1 per spec 9.5 */
  loconetDetector: (type: number, reportAddress = 0) => {
    const wire = type === LocoNetDetectorPoll.ReportAddress ? reportAddress - 1 : reportAddress;
    return encodeFrame(0xa4, [type, wire & 0xff, wire >> 8]);
  },
  canDetector: (nid = CAN_ALL_DETECTORS) => encodeFrame(0xc4, [0x00, nid & 0xff, nid >> 8]),

  /** CV numbers are 1-based, the wire format is 0-based. */
  cvRead: (cv: number) => encodeX(0x23, [0x11, (cv - 1) >> 8, (cv - 1) & 0xff]),
  cvWrite: (cv: number, value: number) => encodeX(0x24, [0x12, (cv - 1) >> 8, (cv - 1) & 0xff, value & 0xff]),
};
