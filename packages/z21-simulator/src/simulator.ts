import dgram from "node:dgram";
import {
  Broadcast, decodeFrames, decodeX, reply, Z21_PORT,
  type LocoInfo, type SystemState, type TrackPower,
} from "@z21/protocol";

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
  private clients = new Map<string, Client>();
  private timer?: NodeJS.Timeout;

  constructor(private serial = 0x00c0ffee, private log: (s: string) => void = () => {}) {
    this.socket.on("message", (msg, rinfo) => this.onDatagram(msg, rinfo.address, rinfo.port));
  }

  listen(port = Z21_PORT, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve) => {
      this.socket.bind(port, host, () => {
        this.timer = setInterval(() => this.expire(), 5000);
        resolve();
      });
    });
  }

  close() {
    clearInterval(this.timer);
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
    this.broadcast(reply.trackPower(p), Broadcast.Basic);
    this.broadcast(reply.systemState(this.systemState), Broadcast.SystemState);
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
        case 0x1a: out(reply.hwinfo(0x211, 1, 43)); break;
        case 0x30: this.clients.delete(key); break;
        case 0x50: client.flags = f.data.readUInt32LE(0); break;
        case 0x51: out(reply.broadcastFlags(client.flags)); break;
        case 0x85: out(reply.systemState(this.systemState)); break;
        case 0x40: this.onX(f.data, client, out); break;
        default: this.log(`unhandled header 0x${f.header.toString(16)}`);
      }
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
    } else if (xHeader === 0x23 && db[0] === 0x11) {
      const cv = ((db[1]! << 8) | db[2]!) + 1;
      out(this.power === "on" || this.power === "programming" ? reply.cv(cv, this.cvs.get(cv) ?? this.defaultCv(cv)) : reply.cvError("noAck"));
    } else if (xHeader === 0x24 && db[0] === 0x12) {
      const cv = ((db[1]! << 8) | db[2]!) + 1;
      this.cvs.set(cv, db[3]!);
      out(reply.cv(cv, db[3]!));
    } else this.log(`unhandled X 0x${xHeader.toString(16)}`);
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

