import { EventEmitter } from "node:events";
import {
  Broadcast, cmd, LocoNetDetectorPoll,
  type CanDetectorValue, type LocoInfo, type LocoNetDecoded, type LocoNetDetectorEvent, type LocoNetDirection,
  type Message, type RailComData, type SystemState, type TrackPower,
} from "@z21/protocol";
import { Z21Client } from "./z21-client.js";

/** Flags that are always on. Monitors add their own on demand, because they can create a lot of traffic. */
const BASE_FLAGS = Broadcast.Basic | Broadcast.SystemState | Broadcast.AllLocos;

export interface Monitors {
  railcom: boolean;
  loconet: boolean;
  detectors: boolean;
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
  hw?: { hwName: string; fwVersion: string };
  serial?: number;
  power?: TrackPower;
  systemState?: SystemState;
  locos: LocoInfo[];
  turnouts: Record<number, string>;
  monitors: Monitors;
  railcom: RailComEntry[];
  loconetDetectors: LocoNetDetectorState[];
  canDetectors: CanDetectorState[];
}

/** Holds the live model of the connected command station and exposes high-level operations. */
export class Station extends EventEmitter<{ state: [StationState]; loconet: [LocoNetLine] }> {
  readonly client = new Z21Client();
  private hw?: StationState["hw"];
  private serial?: number;
  private power?: TrackPower;
  private systemState?: SystemState;
  private locos = new Map<number, LocoInfo>();
  private turnouts: Record<number, string> = {};
  private monitors: Monitors = { railcom: false, loconet: false, detectors: false };
  private railcom = new Map<number, RailComEntry>();
  private loconetDetectors = new Map<number, LocoNetDetectorState>();
  private canDetectors = new Map<string, CanDetectorState>();
  /** CAN loco lists arrive in chunks (type 0x11..0x1F); collected per port until the terminating 0 */
  private canLocoChunks = new Map<string, { type: number; address: number; direction: string }[]>();

  constructor() {
    super();
    this.client.on("message", (m) => this.apply(m));
    this.client.on("close", () => {
      this.monitors = { railcom: false, loconet: false, detectors: false };
      this.emit("state", this.snapshot());
    });
  }

  snapshot(): StationState {
    return {
      connected: this.client.connected,
      host: this.client.host,
      hw: this.hw,
      serial: this.serial,
      power: this.power,
      systemState: this.systemState,
      locos: [...this.locos.values()],
      turnouts: this.turnouts,
      monitors: this.monitors,
      railcom: [...this.railcom.values()].sort((a, b) => b.ts - a.ts),
      loconetDetectors: [...this.loconetDetectors.values()].sort((a, b) => a.feedbackAddress - b.feedbackAddress),
      canDetectors: [...this.canDetectors.values()].sort((a, b) => a.nid - b.nid),
    };
  }

  private apply(m: Message) {
    const ts = Date.now();
    switch (m.type) {
      case "serial": this.serial = m.serial; break;
      case "hwinfo": this.hw = { hwName: m.hwName, fwVersion: m.fwVersion }; break;
      case "trackPower": this.power = m.state; break;
      case "status":
        this.power = m.emergencyStop ? "emergencyStop" : m.shortCircuit ? "shortCircuit"
          : m.programmingMode ? "programming" : m.trackVoltageOff ? "off" : "on";
        break;
      case "systemState": this.systemState = m.state; break;
      case "locoInfo": this.locos.set(m.info.address, m.info); break;
      case "turnoutInfo": this.turnouts[m.address] = m.position; break;
      case "railcom": this.railcom.set(m.data.address, { ...m.data, ts }); break;
      case "loconet":
        this.emit("loconet", { ts, direction: m.direction, bytes: m.bytes, decoded: m.decoded });
        return; // log only, no state change
      case "loconetDetector": this.applyLocoNetDetector(m.feedbackAddress, m.event, ts); break;
      case "canDetector": this.applyCan(m.value, ts); break;
      default: return;
    }
    this.emit("state", this.snapshot());
  }

  private applyLocoNetDetector(feedbackAddress: number, e: LocoNetDetectorEvent, ts: number) {
    const cur = this.loconetDetectors.get(feedbackAddress) ?? { feedbackAddress, occupied: false, ts };
    const next = { ...cur, ts };
    switch (e.kind) {
      case "occupancy": case "lissyBlock": next.occupied = e.occupied; break;
      case "transponder": next.occupied = e.present; next.locoAddress = e.locoAddress; break;
      case "lissyLoco": next.locoAddress = e.locoAddress; next.forward = e.forward; break;
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
        this.canLocoChunks.delete(k);
      }
    }
    this.canDetectors.set(key, mod);
  }

  async connect(host: string, port?: number) {
    this.locos.clear();
    this.turnouts = {};
    this.railcom.clear();
    this.loconetDetectors.clear();
    this.canDetectors.clear();
    this.canLocoChunks.clear();
    this.monitors = { railcom: false, loconet: false, detectors: false };
    await this.client.connect(host, port, BASE_FLAGS);
    this.emit("state", this.snapshot());
  }

  /** Switch the optional (traffic-heavy) subscriptions on or off. */
  setMonitors(patch: Partial<Monitors>) {
    this.monitors = { ...this.monitors, ...patch };
    let flags = BASE_FLAGS;
    if (this.monitors.railcom) flags |= Broadcast.RailComSubscribed | Broadcast.AllRailCom;
    if (this.monitors.loconet) flags |= Broadcast.LocoNet | Broadcast.LocoNetLocos | Broadcast.LocoNetSwitches;
    if (this.monitors.detectors) flags |= Broadcast.LocoNetDetector | Broadcast.CanDetector;
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

  setPower(on: boolean) { this.client.send(on ? cmd.trackPowerOn() : cmd.trackPowerOff()); }
  emergencyStop() { this.client.send(cmd.emergencyStop()); }

  async getLoco(addr: number) {
    const m = await this.client.request(cmd.getLocoInfo(addr), (m) => m.type === "locoInfo" && m.info.address === addr);
    return m.type === "locoInfo" ? m.info : undefined;
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
    if (m.type === "cvError") throw new Error(m.reason === "noAck" ? "No decoder acknowledge" : "Short circuit on programming track");
    return m.type === "cv" ? m.value : 0;
  }
  async writeCv(cv: number, value: number) {
    const m = await this.client.request(cmd.cvWrite(cv, value), (m) => (m.type === "cv" && m.cv === cv) || m.type === "cvError", 10_000);
    if (m.type === "cvError") throw new Error(m.reason === "noAck" ? "No decoder acknowledge" : "Short circuit on programming track");
    return m.type === "cv" ? m.value : 0;
  }
}
