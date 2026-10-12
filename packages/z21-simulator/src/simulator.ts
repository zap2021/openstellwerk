import dgram from "node:dgram";
import { SimExtras, type SimDevice } from "./extras.js";
import {
  Broadcast, CAN_ALL_DETECTORS, decodeFrames, encodeFrame, decodeX, locoNetChecksum, reply, Z21_PORT,
  type LocoInfo, type SystemState, type TrackPower,
} from "@z21/protocol";

const RAILCOM_FLAGS = Broadcast.RailComSubscribed | Broadcast.AllRailCom;
const LOCONET_ANY = Broadcast.LocoNet | Broadcast.LocoNetLocos | Broadcast.LocoNetSwitches;

interface LocoNetDetector { occupied: boolean; transponder?: number }
interface CanPort { occupied: boolean; locos: { address: number; backward?: boolean }[] }
interface CanModule { moduleAddress: number; ports: CanPort[] }

interface Client {
  address: string;
  port: number;
  flags: number;
  lastSeen: number;
}

/** In-memory Z21 command station speaking the public LAN protocol. For development without hardware. */
export class Z21Simulator {
  readonly socket = dgram.createSocket("udp4");
  power: TrackPower = "off";
  readonly locos = new Map<number, LocoInfo>();
  readonly turnouts = new Map<number, 0 | 1 | 2>();
  readonly cvs = new Map<number, number>();
  /** LocoNet occupancy detectors by feedback address */
  readonly loconetDetectors = new Map<number, LocoNetDetector>();
  /** CAN occupancy detectors (10808) by network id */
  readonly canModules = new Map<number, CanModule>([
    [0xd001, { moduleAddress: 1, ports: Array.from({ length: 8 }, () => ({ occupied: false, locos: [] })) }],
  ]);
  private clients = new Map<string, Client>();
  private timer?: NodeJS.Timeout;
  private railcomTimer?: NodeJS.Timeout;
  private railcomCounter = new Map<number, number>();

  readonly extras: SimExtras;
  private device: SimDevice;

  /** device: behave as the Z21 itself (default) or as a zLink booster/decoder behind a 10838 Z21 pro LINK. */
  constructor(private serial = 0x00c0ffee, private log: (s: string) => void = () => {}, opts: { device?: SimDevice } = {}) {
    this.device = opts.device ?? "z21";
    this.extras = new SimExtras({
      device: this.device,
      broadcast: (b, flag) => this.broadcast(b, flag),
      cvs: this.cvs,
      locos: this.locos,
      pushLoco: (addr) => { const l = this.locos.get(addr); if (l) this.broadcast(reply.locoInfo(l), Broadcast.AllLocos); },
    });
    this.socket.on("message", (msg, rinfo) => this.onDatagram(msg, rinfo.address, rinfo.port));
  }

  listen(port = Z21_PORT, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve) => {
      this.socket.bind(port, host, () => {
        this.timer = setInterval(() => this.expire(), 5000);
        this.railcomTimer = setInterval(() => { this.railcomTick(); this.extras.tick(); }, 1000);
        resolve();
      });
    });
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.railcomTimer);
    this.socket.close();
  }

  get systemState(): SystemState {
    const on = this.power === "on";
    return {
      mainCurrent: on ? 350 : 0, progCurrent: 0, filteredMainCurrent: on ? 340 : 0,
      temperature: 31, supplyVoltage: 18000, vccVoltage: 16500,
      centralState: (this.power === "emergencyStop" ? 1 : 0) | (this.power === "off" ? 2 : 0) | (this.power === "shortCircuit" ? 4 : 0),
      centralStateEx: 0, capabilities: 0x73,
    };
  }

  private expire() {
    for (const [k, c] of this.clients) if (Date.now() - c.lastSeen > 60_000) this.clients.delete(k);
  }

  private send(buf: Buffer, address: string, port: number) {
    this.socket.send(buf, port, address);
  }

  private broadcast(buf: Buffer, flag: number) {
    for (const c of this.clients.values()) if (c.flags & flag) this.send(buf, c.address, c.port);
  }

  private loco(addr: number): LocoInfo {
    let l = this.locos.get(addr);
    if (!l) {
      l = { address: addr, steps: 128, busy: false, forward: true, speed: 0, emergencyStop: false, functions: new Array(29).fill(false) };
      this.locos.set(addr, l);
    }
    return l;
  }

  private setPower(p: TrackPower) {
    this.power = p;
    this.extras.setEmergencyHalt(p === "emergencyStop" || p === "shortCircuit");
    this.broadcast(reply.trackPower(p), Broadcast.Basic);
    this.broadcast(reply.systemState(this.systemState), Broadcast.SystemState);
    if (p === "on" || p === "off") this.loconet("tx", [p === "on" ? 0x83 : 0x82], Broadcast.LocoNet);
  }

  /** Send a LocoNet message (checksum appended) to clients subscribed with the given flag(s). */
  private loconet(dir: "rx" | "tx" | "lan", message: number[], flag: number, except?: Client) {
    const b = reply.loconet(dir, [...message, locoNetChecksum(message)]);
    for (const c of this.clients.values()) if (c !== except && c.flags & flag) this.send(b, c.address, c.port);
  }

  private railcomTick() {
    for (const l of this.locos.values()) {
      if (l.speed === 0) continue;
      const n = (this.railcomCounter.get(l.address) ?? 0) + 40;
      this.railcomCounter.set(l.address, n);
      this.broadcast(
        reply.railcom({ address: l.address, receiveCounter: n, errorCounter: Math.floor(n / 500), speed: Math.round(l.speed * 1.2), qos: 80 + (n % 15) }),
        RAILCOM_FLAGS,
      );
    }
  }

  /** Test/demo hook: change a LocoNet occupancy detector input. */
  setLocoNetOccupancy(feedbackAddress: number, occupied: boolean, transponder?: number) {
    this.loconetDetectors.set(feedbackAddress, { occupied, transponder });
    this.broadcast(this.detectorFrame(feedbackAddress, this.loconetDetectors.get(feedbackAddress)!), Broadcast.LocoNetDetector);
    // OPC_INPUT_REP: sensor n (1-based) -> raw = (n-1)>>1, I bit = (n-1)&1
    const n = feedbackAddress - 1;
    const raw = n >> 1;
    this.loconet("rx", [0xb2, raw & 0x7f, 0x40 | ((n & 1) << 5) | (occupied ? 0x10 : 0) | (raw >> 7)], Broadcast.LocoNet);
  }

  private detectorFrame(addr: number, d: LocoNetDetector) {
    if (d.transponder !== undefined) return reply.loconetDetector(d.occupied ? 0x02 : 0x03, addr, [d.transponder & 0xff, d.transponder >> 8]);
    return reply.loconetDetector(0x01, addr, [d.occupied ? 1 : 0]);
  }

  /** Test/demo hook: change a CAN detector port. */
  setCanOccupancy(nid: number, port: number, occupied: boolean, locos: CanPort["locos"] = []) {
    const m = this.canModules.get(nid);
    if (!m?.ports[port]) throw new RangeError("unknown CAN detector/port");
    m.ports[port] = { occupied, locos: occupied ? locos : [] };
    for (const f of this.canFrames(nid, m, port)) this.broadcast(f, Broadcast.CanDetector);
  }

  private canFrames(nid: number, m: CanModule, port: number): Buffer[] {
    const p = m.ports[port]!;
    const frames = [reply.canDetector(nid, m.moduleAddress, port, 0x01, p.occupied ? 0x1100 : 0x0100)];
    const enc = (l?: CanPort["locos"][number]) => (l ? (0x8000 | (l.backward ? 0x4000 : 0) | l.address) : 0);
    // loco list: two addresses per message, terminated by address 0 (at most 15 messages)
    for (let i = 0; p.occupied && p.locos.length > 0 && i < 15; i++) {
      const a = p.locos[i * 2], b = p.locos[i * 2 + 1];
      frames.push(reply.canDetector(nid, m.moduleAddress, port, 0x11 + i, enc(a), enc(b)));
      if (!b) break;
    }
    return frames;
  }

  private onDatagram(msg: Buffer, address: string, port: number) {
    const key = `${address}:${port}`;
    const client = this.clients.get(key) ?? { address, port, flags: 0, lastSeen: 0 };
    client.lastSeen = Date.now();
    this.clients.set(key, client);
    const out = (b: Buffer) => this.send(b, address, port);

    for (const f of decodeFrames(msg)) {
      switch (f.header) {
        case 0x10: out(reply.serial(this.serial)); break;
        case 0x1a: out(reply.hwinfo({ z21: 0x211, booster: 0x205, switchDecoder: 0x301, signalDecoder: 0x302 }[this.device], 1, 43)); break;
        case 0x30: this.clients.delete(key); break;
        case 0x50: client.flags = f.data.readUInt32LE(0); break;
        case 0x51: out(reply.broadcastFlags(client.flags)); break;
        case 0x85: out(reply.systemState(this.systemState)); break;
        case 0x40: this.onX(f.data, client, out); break;
        case 0x89: {
          const addr = f.data.readUInt16LE(1);
          const l = addr ? this.locos.get(addr) : [...this.locos.values()].find((x) => x.speed > 0);
          if (l) out(reply.railcom({ address: l.address, receiveCounter: this.railcomCounter.get(l.address) ?? 0, errorCounter: 0, speed: l.speed, qos: 90 }));
          break;
        }
        case 0xa2: // LocoNet written by a client: echo to the others, like the real Z21
          this.loconet("lan", [...f.data], LOCONET_ANY, client);
          break;
        case 0xa3: out(encodeFrame(0xa3, [f.data[0]!, f.data[1]!, 1])); break; // dispatch always succeeds, slot 1
        case 0xa4: this.onLocoNetDetectorPoll(f.data[0]!, out); break;
        case 0xc4: this.onCanPoll(f.data.readUInt16LE(1), out); break;
        default:
          if (!this.extras.handleFrame(f, out)) this.log(`unhandled header 0x${f.header.toString(16)}`);
      }
    }
  }

  private onLocoNetDetectorPoll(type: number, out: (b: Buffer) => void) {
    if (type !== 0x80 && type !== 0x81) return; // LISSY not simulated
    for (const [addr, d] of this.loconetDetectors) out(this.detectorFrame(addr, d));
  }

  private onCanPoll(nid: number, out: (b: Buffer) => void) {
    for (const [id, m] of this.canModules) {
      if (nid !== CAN_ALL_DETECTORS && nid !== id) continue;
      m.ports.forEach((_, port) => this.canFrames(id, m, port).forEach(out));
    }
  }

  private onX(data: Buffer, client: Client, out: (b: Buffer) => void) {
    let x;
    try { x = decodeX(data); } catch { return; }
    const { xHeader, db } = x;
    const toClients = (b: Buffer) => this.broadcast(b, Broadcast.Basic);

    if (xHeader === 0x21 && db[0] === 0x21) out(reply.version());
    else if (xHeader === 0x21 && db[0] === 0x24) out(reply.status(this.systemState.centralState));
    else if (xHeader === 0x21 && db[0] === 0x80) this.setPower("off");
    else if (xHeader === 0x21 && db[0] === 0x81) this.setPower("on");
    else if (xHeader === 0x80) this.setPower("emergencyStop");
    else if (xHeader === 0xe3 && db[0] === 0xf0) {
      const addr = ((db[1]! & 0x3f) << 8) | db[2]!;
      const l = this.loco(addr);
      l.busy = true;
      out(reply.locoInfo(l));
    } else if (xHeader === 0xe4 && (db[0]! & 0xf0) === 0x10) {
      const addr = ((db[1]! & 0x3f) << 8) | db[2]!;
      const l = this.loco(addr);
      const v = db[3]! & 0x7f;
      l.forward = !!(db[3]! & 0x80);
      l.emergencyStop = v === 1;
      l.speed = v <= 1 ? 0 : v - 1;
      l.busy = true;
      this.pushLoco(l, client);
      this.loconet("tx", [0xa0, 1 + (l.address % 120), l.emergencyStop ? 1 : l.speed === 0 ? 0 : l.speed + 1], Broadcast.LocoNetLocos);
    } else if (xHeader === 0xe4 && db[0] === 0xf8) {
      const l = this.loco(((db[1]! & 0x3f) << 8) | db[2]!);
      const t = db[3]! >> 6, fn = db[3]! & 0x3f;
      l.functions[fn] = t === 2 ? !l.functions[fn] : t === 1;
      this.pushLoco(l, client);
    } else if (xHeader === 0x43) {
      out(reply.turnoutInfo(((db[0]! << 8) | db[1]!) + 1, this.turnouts.get(((db[0]! << 8) | db[1]!) + 1) ?? 0));
    } else if (xHeader === 0x53) {
      const addr = ((db[0]! << 8) | db[1]!) + 1;
      if (db[2]! & 0x08) this.turnouts.set(addr, (db[2]! & 1 ? 2 : 1) as 1 | 2);
      toClients(reply.turnoutInfo(addr, this.turnouts.get(addr) ?? 0));
      if (db[2]! & 0x08) {
        const w = addr - 1;
        this.loconet("tx", [0xb0, w & 0x7f, 0x10 | ((db[2]! & 1) === 0 ? 0x20 : 0) | (w >> 7)], Broadcast.LocoNetSwitches);
      }
    } else if (xHeader === 0x23 && db[0] === 0x11) {
      const cv = ((db[1]! << 8) | db[2]!) + 1;
      out(this.power === "on" || this.power === "programming" ? reply.cv(cv, this.cvs.get(cv) ?? this.defaultCv(cv)) : reply.cvError("noAck"));
    } else if (xHeader === 0x24 && db[0] === 0x12) {
      const cv = ((db[1]! << 8) | db[2]!) + 1;
      this.cvs.set(cv, db[3]!);
      out(reply.cv(cv, db[3]!));
    } else if (!this.extras.handleX(xHeader, db, out)) {
      out(reply.unknownCommand());
      this.log(`unhandled X 0x${xHeader.toString(16)}`);
    }
  }

  private pushLoco(l: LocoInfo, from: Client) {
    const b = reply.locoInfo(l);
    for (const c of this.clients.values()) {
      if (c === from || c.flags & Broadcast.AllLocos) this.send(b, c.address, c.port);
    }
  }

  private defaultCv(cv: number) {
    return ({ 1: 3, 7: 42, 8: 151, 29: 6 } as Record<number, number>)[cv] ?? 0;
  }
}

