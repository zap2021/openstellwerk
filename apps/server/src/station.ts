import { EventEmitter } from "node:events";
import { cmd, type LocoInfo, type Message, type SystemState, type TrackPower } from "@z21/protocol";
import { Z21Client } from "./z21-client.js";

export interface StationState {
  connected: boolean;
  host?: string;
  hw?: { hwName: string; fwVersion: string };
  serial?: number;
  power?: TrackPower;
  systemState?: SystemState;
  locos: LocoInfo[];
  turnouts: Record<number, string>;
}

/** Holds the live model of the connected command station and exposes high-level operations. */
export class Station extends EventEmitter<{ state: [StationState] }> {
  readonly client = new Z21Client();
  private hw?: StationState["hw"];
  private serial?: number;
  private power?: TrackPower;
  private systemState?: SystemState;
  private locos = new Map<number, LocoInfo>();
  private turnouts: Record<number, string> = {};

  constructor() {
    super();
    this.client.on("message", (m) => this.apply(m));
    this.client.on("close", () => this.emit("state", this.snapshot()));
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
    };
  }

  private apply(m: Message) {
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
      default: return;
    }
    this.emit("state", this.snapshot());
  }

  async connect(host: string, port?: number) {
    this.locos.clear();
    this.turnouts = {};
    await this.client.connect(host, port);
    this.emit("state", this.snapshot());
  }

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
