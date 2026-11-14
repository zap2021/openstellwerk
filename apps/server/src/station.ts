import { EventEmitter } from "node:events";
import type { RouteState } from "@z21/interlocking";
import type { TimetableSnapshot } from "@z21/timetable";
import {
  Broadcast, cmd, LocoNetDetectorPoll,
  type BoosterSystemState, type CanBoosterState, type DecoderState, type FastClockSettings, type FastClockTime,
  type ZLinkHwInfo, type CanDetectorValue, type LocoInfo, type LocoNetDecoded, type LocoNetDetectorEvent, type LocoNetDirection,
  type Layout, type Message, type RailComData, type SystemState, type TrackPower,
} from "@z21/protocol";
import { Z21Client } from "./z21-client.js";
import type { AchievementView } from "./achievements.js";
import type { Journey } from "./journeys.js";
import type { DriveResult, DriveView } from "./auto-drive.js";
import type { Calibration, MeasureView } from "./calibration.js";
import { Garage, type GarageLoco, type GarageSource } from "./garage.js";

/** Progress of the address scan that looks for locos the command station already knows about. */
export interface ScanState {
  running: boolean;
  from: number;
  to: number;
  current: number;
  found: number[];
  error?: string;
}

/** A queried address always gets an answer; only a non-idle state tells that someone actually uses this loco. */
export const isActiveLoco = (l: LocoInfo) => l.busy || l.speed > 0 || l.emergencyStop || l.functions.some(Boolean);

const MAX_SCAN = 500;

/** A programming failure is a normal outcome (nothing on the track, short circuit), not a server error. */
const cvFailure = (reason: "noAck" | "shortCircuit") =>
  Object.assign(new Error(reason === "noAck" ? "No decoder acknowledge" : "Short circuit on programming track"), { statusCode: 422 });

/** Flags that are always on. Monitors add their own on demand, because they can create a lot of traffic. */
const BASE_FLAGS = Broadcast.Basic | Broadcast.SystemState | Broadcast.AllLocos;

export interface Monitors {
  railcom: boolean;
  loconet: boolean;
  detectors: boolean;
  rmbus: boolean;
  boosters: boolean;
  clock: boolean;
}

const NO_MONITORS: Monitors = { railcom: false, loconet: false, detectors: false, rmbus: false, boosters: false, clock: false };

export type DeviceKind = "z21" | "booster" | "decoder";
const kindOf = (hwType: number): DeviceKind =>
  hwType === 0x205 || hwType === 0x206 || hwType === 0x212 ? "booster" : hwType === 0x301 || hwType === 0x302 ? "decoder" : "z21";

export interface CanBoosterEntry {
  nid: number;
  name?: string;
  outputs: (CanBoosterState & { ts: number })[];
}

export interface LocoNetLine {
  ts: number;
  direction: LocoNetDirection;
  bytes: number[];
  decoded: LocoNetDecoded;
}

export interface RailComEntry extends RailComData {
  ts: number;
}

export interface LocoNetDetectorState {
  feedbackAddress: number;
  occupied: boolean;
  /** last transponder / LISSY loco address seen */
  locoAddress?: number;
  forward?: boolean;
  speed?: number;
  ts: number;
}

export interface CanDetectorState {
  nid: number;
  moduleAddress: number;
  ports: { port: number; occupied: boolean; voltage: boolean; overload: number; locos: { address: number; direction: string }[] }[];
  ts: number;
}

export interface StationState {
  connected: boolean;
  host?: string;
  hw?: { hwName: string; fwVersion: string; hwType: number; kind: DeviceKind };
  serial?: number;
  /** from LAN_X_GET_FIRMWARE_VERSION */
  firmwareVersion?: string;
  unlockCode?: string | number;
  power?: TrackPower;
  systemState?: SystemState;
  locos: LocoInfo[];
  turnouts: Record<number, string>;
  monitors: Monitors;
  railcom: RailComEntry[];
  loconetDetectors: LocoNetDetectorState[];
  canDetectors: CanDetectorState[];
  rmbus: { module: number; inputs: boolean[] }[];
  clock?: { time?: FastClockTime; settings?: FastClockSettings };
  canBoosters: CanBoosterEntry[];
  /** zLink device (booster / decoder behind a 10838 Z21 pro LINK) */
  device?: { name?: string; link?: ZLinkHwInfo; boosterState?: BoosterSystemState; decoderState?: DecoderState };
  extAccessories: Record<number, number>;
  modes: { loco: Record<number, string>; turnout: Record<number, string> };
  garage: GarageLoco[];
  scan?: ScanState;
  layout?: Layout;
  routeRun?: RouteRun;
  /** Interlocked routes that are not idle (see @z21/interlocking). */
  interlocking?: RouteState[];
  /** true while the built-in simulator stands in for a real command station */
  demo?: boolean;
  /** Timetable clock, trains and upcoming departures (see TimetableRunner). */
  timetable?: TimetableSnapshot;
  achievements?: AchievementView;
  /** Installed and newest published version (see UpdateService). */
  update?: { current: string; latest?: string; available: boolean };
  /** Layout rules with a manual trigger: buttons in the operating view (see LayoutRuleEngine.macros). */
  macros?: { id: string; name: string }[];
  /** Journeys to a chosen block (see JourneyRunner). */
  journeys?: Journey[];
  /** Locos the server drives right now and how the last drives ended (see AutoDriver). */
  autoDrive?: { jobs: DriveView[]; results: DriveResult[] };
  /** Speed tables per loco address and the measuring run, if any (see calibration.ts). */
  calibration?: { tables: Record<string, Calibration>; run?: MeasureView };
}

/** Progress of a route that is being set. */
export interface RouteRun { routeId: string; done: number; total: number; running: boolean; error?: string }

/** Holds the live model of the connected command station and exposes high-level operations. */
export class Station extends EventEmitter<{ state: [StationState]; loconet: [LocoNetLine]; connected: []; locoChange: [LocoInfo | undefined, LocoInfo]; locosReset: [] }> {
  /** Set by the demo mode; shown in the snapshot so the UI can say it is not real. */
  demo = false;
  /** Parts that other modules (signal box, timetable, ...) add to the snapshot; later ones win. */
  private extras: (() => Partial<StationState>)[] = [];
  /** Monitors that must stay on no matter which tab is open (the track diagram needs its detectors). */
  private pinned: Partial<Monitors> = {};
  readonly client = new Z21Client();
  private hw?: StationState["hw"];
  private serial?: number;
  private power?: TrackPower;
  private systemState?: SystemState;
  private locos = new Map<number, LocoInfo>();
  private turnouts: Record<number, string> = {};
  private monitors: Monitors = { ...NO_MONITORS };
  private firmwareVersion?: string;
  private unlockCode?: string | number;
  private rmbus = new Map<number, boolean[]>();
  private clock?: { time?: FastClockTime; settings?: FastClockSettings };
  private canBoosters = new Map<number, CanBoosterEntry>();
  private device: NonNullable<StationState["device"]> = {};
  private extAccessories: Record<number, number> = {};
  private modes: StationState["modes"] = { loco: {}, turnout: {} };
  private railcom = new Map<number, RailComEntry>();
  private loconetDetectors = new Map<number, LocoNetDetectorState>();
  private canDetectors = new Map<string, CanDetectorState>();
  /** CAN loco lists arrive in chunks (type 0x11..0x1F); collected per port until the terminating 0 */
  private canLocoChunks = new Map<string, { type: number; address: number; direction: string }[]>();

  private scanState?: ScanState;
  private scanAbort = false;

  constructor(readonly garage = new Garage()) {
    super();
    this.client.on("message", (m) => this.apply(m));
    this.client.on("close", () => {
      this.monitors = { ...NO_MONITORS };
      this.emit("state", this.snapshot());
    });
  }

  snapshot(): StationState {
    return {
      connected: this.client.connected,
      host: this.client.host,
      hw: this.hw,
      serial: this.serial,
      firmwareVersion: this.firmwareVersion,
      unlockCode: this.unlockCode,
      power: this.power,
      systemState: this.systemState,
      locos: [...this.locos.values()],
      turnouts: this.turnouts,
      monitors: this.monitors,
      railcom: [...this.railcom.values()].sort((a, b) => b.ts - a.ts),
      loconetDetectors: [...this.loconetDetectors.values()].sort((a, b) => a.feedbackAddress - b.feedbackAddress),
      canDetectors: [...this.canDetectors.values()].sort((a, b) => a.nid - b.nid),
      rmbus: [...this.rmbus].sort(([a], [b]) => a - b).map(([module, inputs]) => ({ module, inputs })),
      clock: this.clock,
      canBoosters: [...this.canBoosters.values()].sort((a, b) => a.nid - b.nid),
      device: Object.keys(this.device).length ? this.device : undefined,
      extAccessories: this.extAccessories,
      modes: this.modes,
      garage: this.garage.list(),
      scan: this.scanState,
      demo: this.demo || undefined,
      ...Object.assign({}, ...this.extras.map((f) => f())),
    };
  }

  /** Lets a module contribute fields to the snapshot that every browser receives. */
  addExtra(fn: () => Partial<StationState>): void {
    this.extras.push(fn);
  }

  private apply(m: Message) {
    const ts = Date.now();
    switch (m.type) {
      case "serial": this.serial = m.serial; break;
      case "hwinfo": {
        const kind = kindOf(m.hwType);
        this.hw = { hwName: m.hwName, fwVersion: m.fwVersion, hwType: m.hwType, kind };
        this.queryDevice(kind);
        break;
      }
      case "firmwareVersion": this.firmwareVersion = m.version; break;
      case "code": this.unlockCode = m.code; break;
      case "rmbus": for (const mod of m.data.modules) this.rmbus.set(mod.module, mod.inputs); break;
      case "fastClock": this.clock = { ...this.clock, time: m.time }; break;
      case "fastClockSettings": this.clock = { ...this.clock, settings: m.settings }; break;
      case "canDeviceName": this.canBooster(m.nid).name = m.name; break;
      case "canBooster": {
        const b = this.canBooster(m.state.nid);
        b.outputs[m.state.outputPort - 1] = { ...m.state, ts };
        break;
      }
      case "deviceName": this.device = { ...this.device, name: m.name }; break;
      case "boosterState": this.device = { ...this.device, boosterState: m.state }; break;
      case "decoderState": this.device = { ...this.device, decoderState: m.state }; break;
      case "zlinkHwInfo": this.device = { ...this.device, link: m.info }; break;
      case "extAccessory": if (m.valid) this.extAccessories = { ...this.extAccessories, [m.address]: m.value }; break;
      case "locoMode": this.modes = { ...this.modes, loco: { ...this.modes.loco, [m.address]: m.mode } }; break;
      case "turnoutMode": this.modes = { ...this.modes, turnout: { ...this.modes.turnout, [m.address]: m.mode } }; break;
      case "trackPower": this.power = m.state; break;
      case "status":
        this.power = m.emergencyStop ? "emergencyStop" : m.shortCircuit ? "shortCircuit"
          : m.programmingMode ? "programming" : m.trackVoltageOff ? "off" : "on";
        break;
      case "systemState": this.systemState = m.state; break;
      case "locoInfo": {
        const prev = this.locos.get(m.info.address);
        this.locos.set(m.info.address, m.info);
        if (isActiveLoco(m.info)) this.remember(m.info.address, "active");
        this.emit("locoChange", prev, m.info); // automations listen here
        break;
      }
      case "turnoutInfo": this.turnouts[m.address] = m.position; break;
      case "railcom": this.railcom.set(m.data.address, { ...m.data, ts }); this.remember(m.data.address, "railcom"); break;
      case "loconet":
        this.emit("loconet", { ts, direction: m.direction, bytes: m.bytes, decoded: m.decoded });
        return; // log only, no state change
      case "loconetDetector": this.applyLocoNetDetector(m.feedbackAddress, m.event, ts); break;
      case "canDetector": this.applyCan(m.value, ts); break;
      default: return;
    }
    this.emit("state", this.snapshot());
  }

  /** Keep every loco that was ever seen in use, so the list does not shrink when a signal goes quiet. */
  private remember(address: number, source: GarageSource) {
    if (address < 1 || address > 9999 || this.garage.get(address)?.sources.includes(source)) return;
    this.garage.upsert(address, { source });
  }

  private applyLocoNetDetector(feedbackAddress: number, e: LocoNetDetectorEvent, ts: number) {
    const cur = this.loconetDetectors.get(feedbackAddress) ?? { feedbackAddress, occupied: false, ts };
    const next = { ...cur, ts };
    switch (e.kind) {
      case "occupancy": case "lissyBlock": next.occupied = e.occupied; break;
      case "transponder": next.occupied = e.present; next.locoAddress = e.locoAddress; this.remember(e.locoAddress, "detector"); break;
      case "lissyLoco": next.locoAddress = e.locoAddress; next.forward = e.forward; this.remember(e.locoAddress, "detector"); break;
      case "lissySpeed": next.speed = e.speed; break;
      default: return;
    }
    this.loconetDetectors.set(feedbackAddress, next);
  }

  private applyCan(v: CanDetectorValue, ts: number) {
    const key = `${v.nid}`;
    const mod = this.canDetectors.get(key) ?? { nid: v.nid, moduleAddress: v.moduleAddress, ports: [], ts };
    mod.moduleAddress = v.moduleAddress;
    mod.ts = ts;
    let port = mod.ports.find((p) => p.port === v.port);
    if (!port) {
      port = { port: v.port, occupied: false, voltage: false, overload: 0, locos: [] };
      mod.ports.push(port);
      mod.ports.sort((a, b) => a.port - b.port);
    }
    if (v.occupancy) {
      Object.assign(port, v.occupancy);
      if (!v.occupancy.occupied) port.locos = [];
    } else if (v.locos) {
      // a chunk is complete when it contains address 0; the list replaces the previous one
      const k = `${v.nid}/${v.port}`;
      const acc = this.canLocoChunks.get(k) ?? [];
      const idx = v.type - 0x11;
      acc.splice(idx * 2, 2, ...v.locos.map((l) => ({ type: v.type, ...l })));
      this.canLocoChunks.set(k, acc);
      if (v.locos.some((l) => l.address === 0)) {
        port.locos = acc.filter((l) => l.address !== 0).map(({ address, direction }) => ({ address, direction }));
        for (const l of port.locos) this.remember(l.address, "detector");
        this.canLocoChunks.delete(k);
      }
    }
    this.canDetectors.set(key, mod);
  }

  private canBooster(nid: number): CanBoosterEntry {
    let b = this.canBoosters.get(nid);
    if (!b) {
      this.canBoosters.set(nid, (b = { nid, outputs: [] }));
      // the status broadcast carries no name: ask for it once, spaced out (the spec warns against back-to-back requests)
      setTimeout(() => { try { this.getCanBoosterName(nid); } catch { /* disconnected */ } }, 100 * this.canBoosters.size);
    }
    return b;
  }

  /** Ask a freshly connected device for the data its panel needs. */
  private queryDevice(kind: DeviceKind) {
    try {
      this.client.send(cmd.getFirmwareVersion());
      this.client.send(cmd.getCode());
      if (kind === "booster") { this.client.send(cmd.boosterGetDescription()); this.client.send(cmd.boosterGetSystemState()); }
      if (kind === "decoder") { this.client.send(cmd.decoderGetDescription()); this.client.send(cmd.decoderGetSystemState()); }
      if (kind !== "z21") this.client.send(cmd.zlinkGetHwInfo());
    } catch { /* disconnected meanwhile */ }
  }

  async connect(host: string, port?: number) {
    this.scanAbort = true;
    this.scanState = undefined;
    this.locos.clear();
    this.emit("locosReset");
    this.turnouts = {};
    this.railcom.clear();
    this.loconetDetectors.clear();
    this.canDetectors.clear();
    this.canLocoChunks.clear();
    this.monitors = { ...NO_MONITORS };
    this.firmwareVersion = undefined;
    this.unlockCode = undefined;
    this.clock = undefined;
    this.rmbus.clear();
    this.canBoosters.clear();
    this.device = {};
    this.extAccessories = {};
    this.modes = { loco: {}, turnout: {} };
    this.hw = undefined;
    this.serial = undefined;
    await this.client.connect(host, port, BASE_FLAGS);
    this.setMonitors({}); // pinned subscriptions (e.g. the diagram's detectors) must be on from the start
    this.emit("state", this.snapshot());
    this.emit("connected");
  }

  /** Publish the snapshot again (after something outside the station changed, e.g. the track diagram). */
  notify() { this.emit("state", this.snapshot()); }

  pinMonitors(pinned: Partial<Monitors>) {
    this.pinned = pinned;
    if (this.client.connected) this.setMonitors({});
  }

  /** Ask for the position of these turnouts; the answers arrive as normal turnout messages. */
  refreshTurnouts(addresses: number[]) {
    addresses.forEach((addr, i) => setTimeout(() => { try { this.client.send(cmd.getTurnoutInfo(addr)); } catch { /* disconnected */ } }, i * 25));
  }

  /** Switch the optional (traffic-heavy) subscriptions on or off. */
  setMonitors(patch: Partial<Monitors>) {
    this.monitors = { ...this.monitors, ...patch };
    const on = (k: keyof Monitors) => this.monitors[k] || !!this.pinned[k];
    let flags = BASE_FLAGS;
    if (on("railcom")) flags |= Broadcast.RailComSubscribed | Broadcast.AllRailCom;
    if (on("loconet")) flags |= Broadcast.LocoNet | Broadcast.LocoNetLocos | Broadcast.LocoNetSwitches;
    if (on("detectors")) flags |= Broadcast.LocoNetDetector | Broadcast.CanDetector;
    if (on("rmbus")) flags |= Broadcast.RMBus;
    if (on("boosters")) flags |= Broadcast.CanBooster;
    if (on("clock")) flags |= Broadcast.FastClock;
    this.client.setFlags(flags);
    this.emit("state", this.snapshot());
  }

  /** Raw LocoNet message WITHOUT checksum. This writes onto the layout's LocoNet bus. */
  sendLocoNet(message: number[]) {
    if (message.length < 1 || message.length > 126) throw new RangeError("LocoNet message must be 1..126 bytes (without checksum)");
    if (message[0]! < 0x80 || message.slice(1).some((b) => b < 0 || b > 0x7f)) {
      throw new RangeError("first byte must be an opcode (>= 0x80), all following bytes must be <= 0x7F");
    }
    this.client.send(cmd.loconetFromLan(message));
  }

  pollRailCom(addr = 0) { this.client.send(cmd.railComGetData(addr)); }
  pollLocoNetDetectors(type: keyof typeof LocoNetDetectorPoll = "Sic", reportAddress = 0) {
    this.client.send(cmd.loconetDetector(LocoNetDetectorPoll[type], reportAddress));
  }
  pollCanDetectors(nid?: number) { this.client.send(cmd.canDetector(nid)); }

  /* ---- settings ---- */
  async readLocoMode(addr: number) {
    const m = await this.client.request(cmd.getLocoMode(addr), (m) => m.type === "locoMode" && m.address === addr);
    return m.type === "locoMode" ? m.mode : "dcc";
  }
  setLocoMode(addr: number, mode: "dcc" | "mm") {
    this.client.send(cmd.setLocoMode(addr, mode));
    this.modes = { ...this.modes, loco: { ...this.modes.loco, [addr]: mode } };
    this.emit("state", this.snapshot());
  }
  async readTurnoutMode(addr: number) {
    const m = await this.client.request(cmd.getTurnoutMode(addr), (m) => m.type === "turnoutMode" && m.address === addr);
    return m.type === "turnoutMode" ? m.mode : "dcc";
  }
  setTurnoutMode(addr: number, mode: "dcc" | "mm") {
    this.client.send(cmd.setTurnoutMode(addr, mode));
    this.modes = { ...this.modes, turnout: { ...this.modes.turnout, [addr]: mode } };
    this.emit("state", this.snapshot());
  }

  /* ---- more driving ---- */
  locoEStop(addr: number) { this.client.send(cmd.locoEStop(addr)); }
  purgeLoco(addr: number) {
    this.client.send(cmd.purgeLoco(addr));
    this.locos.delete(addr);
    this.emit("state", this.snapshot());
  }
  setFunctionGroup(addr: number, group: number, bits: number) { this.client.send(cmd.setLocoFunctionGroup(addr, group, bits)); }
  setBinaryState(addr: number, stateAddr: number, on: boolean) { this.client.send(cmd.setLocoBinaryState(addr, stateAddr, on)); }

  /* ---- accessories / signals (DCCext) ---- */
  setExtAccessory(addr: number, value: number) { this.client.send(cmd.setExtAccessory(addr, value)); }
  extAccessoryEStop() { this.client.send(cmd.extAccessoryEStop()); }
  async getExtAccessory(addr: number) {
    const m = await this.client.request(cmd.getExtAccessoryInfo(addr), (m) => m.type === "extAccessory" && m.address === addr);
    return m.type === "extAccessory" ? { address: m.address, value: m.value, valid: m.valid } : undefined;
  }

  /* ---- programming ---- */
  private async cvReply(frame: Buffer, cv: number, timeout = 10_000) {
    const m = await this.client.request(frame, (m) => (m.type === "cv" && m.cv === cv) || m.type === "cvError", timeout);
    if (m.type === "cvError") throw cvFailure(m.reason);
    return m.type === "cv" ? m.value : 0;
  }
  /** Read a loco CV on the main track via RailCom (needs a RailCom decoder and RailCom enabled in the Z21). */
  pomRead(addr: number, cv: number) { return this.cvReply(cmd.pomReadByte(addr, cv), cv); }
  pomWrite(addr: number, cv: number, value: number) { this.client.send(cmd.pomWriteByte(addr, cv, value)); }
  pomWriteBit(addr: number, cv: number, bit: number, value: boolean) { this.client.send(cmd.pomWriteBit(addr, cv, bit, value)); }
  pomAccessoryRead(dec: number, output: number | undefined, cv: number) { return this.cvReply(cmd.pomAccessoryReadByte(dec, output, cv), cv); }
  pomAccessoryWrite(dec: number, output: number | undefined, cv: number, value: number) {
    this.client.send(cmd.pomAccessoryWriteByte(dec, output, cv, value));
  }
  pomAccessoryWriteBit(dec: number, output: number | undefined, cv: number, bit: number, value: boolean) {
    this.client.send(cmd.pomAccessoryWriteBit(dec, output, cv, bit, value));
  }
  readRegister(reg: number) { return this.cvReply(cmd.dccReadRegister(reg), reg); }
  writeRegister(reg: number, value: number) { return this.cvReply(cmd.dccWriteRegister(reg, value), reg); }
  /** Motorola 6021 programming: the reply only means "finished", not "successful" */
  mmWrite(reg: number, value: number) { return this.cvReply(cmd.mmWriteByte(reg, value), reg); }

  /* ---- R-BUS ---- */
  pollRmBus() { this.client.send(cmd.rmbusGetData(0)); this.client.send(cmd.rmbusGetData(1)); }
  /** 1..20 starts programming a single connected module, 0 ends the sequence */
  rmbusProgramModule(address: number) { this.client.send(cmd.rmbusProgramModule(address)); }

  /* ---- fast clock ---- */
  getClock() { this.client.send(cmd.fastClockGet()); this.client.send(cmd.fastClockSettingsGet()); }
  startClock() { this.client.send(cmd.fastClockStart()); }
  stopClock() { this.client.send(cmd.fastClockStop()); }
  setClock(weekday: number, hour: number, minute: number, rate: number) { this.client.send(cmd.fastClockSet(weekday, hour, minute, rate)); }
  setClockSettings(settings: number, rate?: number, start?: { weekday: number; hour: number; minute: number }) {
    this.client.send(cmd.fastClockSettingsSet(settings, rate, start));
    this.client.send(cmd.fastClockSettingsGet());
  }

  /* ---- CAN boosters (via Z21) ---- */
  getCanBoosterName(nid: number) { this.client.send(cmd.canDeviceGetDescription(nid)); }
  setCanBoosterName(nid: number, name: string) {
    this.client.send(cmd.canDeviceSetDescription(nid, name));
    setTimeout(() => { try { this.getCanBoosterName(nid); } catch { /* disconnected */ } }, 200);
  }
  setCanBoosterPower(nid: number, power: number) { this.client.send(cmd.canBoosterSetTrackPower(nid, power)); }

  /* ---- zLink devices ---- */
  refreshDevice() { if (this.hw) this.queryDevice(this.hw.kind); }
  setDeviceName(name: string) {
    this.client.send(this.hw?.kind === "booster" ? cmd.boosterSetDescription(name) : cmd.decoderSetDescription(name));
    setTimeout(() => this.refreshDevice(), 300);
  }
  setBoosterPower(port: 1 | 2 | 3, on: boolean) { this.client.send(cmd.boosterSetPower(port, on)); }

  setPower(on: boolean) { this.client.send(on ? cmd.trackPowerOn() : cmd.trackPowerOff()); }
  emergencyStop() { this.client.send(cmd.emergencyStop()); }

  async getLoco(addr: number, timeoutMs?: number) {
    const m = await this.client.request(cmd.getLocoInfo(addr), (m) => m.type === "locoInfo" && m.info.address === addr, timeoutMs);
    return m.type === "locoInfo" ? m.info : undefined;
  }

  /**
   * Ask the command station for the state of every address in from..to (read-only: nothing is sent to the track).
   * Addresses with a non-idle state (used by a handheld/app, speed, lights on) are added to the garage.
   * Runs in the background; progress is part of the state snapshot.
   */
  startScan(from: number, to: number) {
    if (this.scanState?.running) throw Object.assign(new Error("A scan is already running"), { statusCode: 409 });
    if (!this.client.connected) throw Object.assign(new Error("not connected"), { statusCode: 409 });
    if (to < from || to - from + 1 > MAX_SCAN) throw Object.assign(new Error(`range must be 1..${MAX_SCAN} addresses`), { statusCode: 400 });
    this.scanAbort = false;
    const s: ScanState = (this.scanState = { running: true, from, to, current: from, found: [] });
    const publish = () => this.emit("state", this.snapshot());
    void (async () => {
      let misses = 0;
      for (let addr = from; addr <= to && !this.scanAbort && this.client.connected; addr++) {
        s.current = addr;
        try {
          const info = await this.getLoco(addr, 600);
          misses = 0;
          if (info && isActiveLoco(info)) {
            s.found = [...s.found, addr];
            this.garage.upsert(addr, { source: "scan" });
          }
        } catch {
          if (++misses >= 5) { s.error = "Zentrale antwortet nicht"; break; }
        }
        if (addr % 5 === 0) publish();
        await new Promise((r) => setTimeout(r, 20));
      }
      this.scanState = { ...s, running: false };
      publish();
    })();
    publish();
  }

  stopScan() { this.scanAbort = true; }

  /** Read the loco address from a decoder on the programming track (CV29 decides short CV1 or long CV17/18). */
  async readProgrammedAddress() {
    const cv29 = await this.readCv(29);
    const long = !!(cv29 & 0x20);
    const address = long ? ((((await this.readCv(17)) & 0x3f) << 8) | (await this.readCv(18))) : await this.readCv(1);
    if (address < 1 || address > 9999) throw Object.assign(new Error(`decoder reports invalid address ${address}`), { statusCode: 422 });
    this.garage.upsert(address, { source: "prog" });
    this.emit("state", this.snapshot());
    return { address, long, cv29 };
  }

  setGarageEntry(address: number, patch: Parameters<Garage["upsert"]>[1]) {
    const e = this.garage.upsert(address, patch);
    this.emit("state", this.snapshot());
    return e;
  }
  removeGarageEntry(address: number) {
    const ok = this.garage.remove(address);
    this.emit("state", this.snapshot());
    return ok;
  }
  drive(addr: number, speed: number, forward: boolean) { this.client.send(cmd.setLocoDrive(addr, speed, forward)); }
  stopLoco(addr: number, forward: boolean) { this.client.send(cmd.setLocoDrive(addr, 0, forward, 128, true)); }
  setFunction(addr: number, fn: number, action: "on" | "off" | "toggle") { this.client.send(cmd.setLocoFunction(addr, fn, action)); }
  setTurnout(addr: number, output: 0 | 1) {
    // Activate, then release shortly after so the magnet coil is not held (standard Z21 practice).
    this.client.send(cmd.setTurnout(addr, output, true));
    setTimeout(() => { try { this.client.send(cmd.setTurnout(addr, output, false)); } catch { /* disconnected */ } }, 150);
  }

  async readCv(cv: number) {
    const m = await this.client.request(cmd.cvRead(cv), (m) => (m.type === "cv" && m.cv === cv) || m.type === "cvError", 10_000);
    if (m.type === "cvError") throw cvFailure(m.reason);
    return m.type === "cv" ? m.value : 0;
  }
  async writeCv(cv: number, value: number) {
    const m = await this.client.request(cmd.cvWrite(cv, value), (m) => (m.type === "cv" && m.cv === cv) || m.type === "cvError", 10_000);
    if (m.type === "cvError") throw cvFailure(m.reason);
    return m.type === "cv" ? m.value : 0;
  }
}
