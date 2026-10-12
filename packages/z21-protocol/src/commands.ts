import { encodeFrame, encodeX } from "./frame.js";

export type SpeedSteps = 14 | 28 | 128;

/** Loco addresses >= 128 are sent with the two top bits of the MSB set. */
export function locoAddr(addr: number): [number, number] {
  if (addr < 1 || addr > 9999) throw new RangeError(`loco address out of range: ${addr}`);
  return addr >= 128 ? [(addr >> 8) | 0xc0, addr & 0xff] : [0, addr];
}

export const Broadcast = {
  /** power, short circuit, programming, emergency stop */
  Basic: 0x00000001,
  RMBus: 0x00000002,
  RailComSubscribed: 0x00000004,
  SystemState: 0x00000100,
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
