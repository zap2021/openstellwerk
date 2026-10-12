import { Broadcast, reply, type Frame, FastClockFlag } from "@z21/protocol";

export type SimDevice = "z21" | "booster" | "switchDecoder" | "signalDecoder";

export interface SimContext {
  device: SimDevice;
  /** send to all clients whose broadcast flags intersect `flag` */
  broadcast(buf: Buffer, flag: number): void;
  /** CVs of the programming track, shared with the base simulator */
  cvs: Map<number, number>;
  locos: Map<number, { speed: number; forward: boolean; functions: boolean[]; emergencyStop: boolean; address: number; steps: 14 | 28 | 128 | 0; busy: boolean }>;
  pushLoco(addr: number): void;
}

interface CanBooster { name: string; outputs: { disabled: boolean; shortCircuit: boolean }[] }

/** Everything beyond driving/monitoring: settings, POM, R-BUS, fast clock, boosters, zLink devices. */
export class SimExtras {
  readonly locoModes = new Map<number, "dcc" | "mm">();
  readonly turnoutModes = new Map<number, "dcc" | "mm">();
  readonly extAccessories = new Map<number, number>();
  readonly pomCvs = new Map<string, number>();
  /** R-BUS feedback: one byte per module 1..20 */
  readonly rmbus = new Uint8Array(20);
  readonly canBoosters = new Map<number, CanBooster>([
    [0xc101, { name: "Booster Nord", outputs: [{ disabled: false, shortCircuit: false }] }],
    [0xc102, { name: "Booster Sued", outputs: [{ disabled: false, shortCircuit: false }, { disabled: false, shortCircuit: false }] }],
  ]);
  deviceName = "Simulator";
  /** zLink booster output disabled flags */
  boosterDisabled: [boolean, boolean] = [false, false];
  /** zLink switch decoder outputs (8 pairs): 0 unknown, 1 red, 2 green */
  switchOutputs = new Array<number>(8).fill(0);
  signalAspect = [0, 0, 0, 0];

  clock = { weekday: 0, hour: 12, minute: 0, second: 0, rate: 1, enabled: true, halted: false, settings: 0x4f, startWeekday: 0, startHour: 0, startMinute: 0 };

  constructor(private ctx: SimContext) {}

  /** called once per second */
  tick() {
    const c = this.clock;
    if (c.enabled && !c.halted && c.rate > 0) {
      const prev = c.minute;
      c.second += c.rate;
      while (c.second >= 60) { c.second -= 60; c.minute++; }
      while (c.minute >= 60) { c.minute -= 60; c.hour++; }
      while (c.hour >= 24) { c.hour -= 24; c.weekday = (c.weekday + 1) % 7; }
      if (c.minute !== prev) this.broadcastClock();
    }
    for (const [nid, b] of this.canBoosters) {
      b.outputs.forEach((o, i) =>
        this.ctx.broadcast(
          reply.canBooster(nid, i + 1, (o.shortCircuit ? 0x20 : 0) | (o.disabled ? 0x180 : 0) | 0x0800, o.disabled ? 0 : 18000, o.disabled ? 0 : 420 + i * 30),
          Broadcast.CanBooster,
        ),
      );
    }
    if (this.ctx.device !== "z21") this.broadcastDeviceState();
  }

  setEmergencyHalt(halted: boolean) {
    if (this.clock.settings & FastClockFlag.HaltOnEmergency) { this.clock.halted = halted; this.broadcastClock(); }
  }

  setRmBus(module: number, input: number, on: boolean) {
    if (on) this.rmbus[module - 1]! |= 1 << (input - 1);
    else this.rmbus[module - 1]! &= ~(1 << (input - 1));
    const group = module > 10 ? 1 : 0;
    this.ctx.broadcast(reply.rmbus(group, [...this.rmbus.subarray(group * 10, group * 10 + 10)]), Broadcast.RMBus);
  }

  private clockFrame() {
    const c = this.clock;
    return reply.fastClock({
      weekday: c.weekday, hour: c.hour, minute: c.minute, second: c.second, rate: c.rate,
      stopped: !c.enabled || c.rate === 0, halted: c.halted, settings: c.settings | (c.enabled ? FastClockFlag.Enabled : 0),
    });
  }
  private broadcastClock() { this.ctx.broadcast(this.clockFrame(), 0x10); }

  private boosterStateFrame() {
    const b = Buffer.alloc(24);
    const [d1, d2] = this.boosterDisabled;
    b.writeInt16LE(d1 ? 0 : 450, 0); b.writeInt16LE(d2 ? 0 : 380, 2);
    b.writeInt16LE(d1 ? 0 : 440, 4); b.writeInt16LE(d2 ? 0 : 370, 6);
    b.writeInt16LE(34, 8); b.writeInt16LE(33, 10);
    b.writeUInt16LE(19000, 12); b.writeUInt16LE(d1 ? 0 : 18000, 14); b.writeUInt16LE(d2 ? 0 : 18000, 16);
    b[18] = d1 && d2 ? 0x02 : 0;
    b[20] = 0x03;
    b[22] = (d1 ? 0x10 : 0) | (d2 ? 0x20 : 0);
    return reply.boosterState(b);
  }

  private decoderStateFrame() {
    if (this.ctx.device === "switchDecoder") {
      const b = Buffer.alloc(44);
      b.writeInt16LE(30, 0); b.writeInt16LE(28, 2); b.writeUInt16LE(3300, 4);
      this.switchOutputs.forEach((o, i) => { b[8 + i] = o === 1 ? 0x01 : o === 2 ? 0x02 : 0; });
      b.writeUInt16LE(1, 32);
      return reply.decoderState(b);
    }
    const b = Buffer.alloc(42);
    b.writeUInt16LE(12000, 4);
    b[23] = 2;
    this.signalAspect.forEach((a, i) => { b[12 + i] = a; b[24 + i] = 1 + i; });
    b.writeUInt16LE(1, 32);
    return reply.decoderState(b);
  }

  private broadcastDeviceState() {
    if (this.ctx.device === "booster") this.ctx.broadcast(this.boosterStateFrame(), Broadcast.SystemState);
    else this.ctx.broadcast(this.decoderStateFrame(), Broadcast.SystemState);
  }

  /** Frames outside the X-Bus. Returns true if handled. */
  handleFrame(f: Frame, out: (b: Buffer) => void): boolean {
    const d = f.data;
    const dev = this.ctx.device;
    switch (f.header) {
      case 0x18: out(reply.code(0)); return true;
      case 0x60: out(reply.mode(0x60, d.readUInt16BE(0), d.readUInt16BE(0) >= 256 ? "dcc" : this.locoModes.get(d.readUInt16BE(0)) ?? "dcc")); return true;
      case 0x61: if (d.readUInt16BE(0) < 256) this.locoModes.set(d.readUInt16BE(0), d[2] === 1 ? "mm" : "dcc"); return true;
      case 0x70: out(reply.mode(0x70, d.readUInt16BE(0), d.readUInt16BE(0) >= 256 ? "dcc" : this.turnoutModes.get(d.readUInt16BE(0)) ?? "dcc")); return true;
      case 0x71: if (d.readUInt16BE(0) < 256) this.turnoutModes.set(d.readUInt16BE(0), d[2] === 1 ? "mm" : "dcc"); return true;
      case 0x81: {
        const g = d[0]!;
        out(reply.rmbus(g, [...this.rmbus.subarray(g * 10, g * 10 + 10)]));
        return true;
      }
      case 0x82: return true; // module programming: accepted silently, like the real device
      case 0xcc: {
        const c = this.clock;
        if (d[0] === 0x21 && d[1] === 0x2c) c.enabled = true;
        else if (d[0] === 0x21 && d[1] === 0x2d) c.enabled = false;
        else if (d[0] === 0x24 && d[1] === 0x2b) {
          c.weekday = d[2]! >> 5; c.hour = d[2]! & 0x1f; c.minute = d[3]! & 0x3f; c.second = 0; c.rate = d[4]! & 0x3f;
        }
        out(this.clockFrame());
        this.broadcastClock();
        return true;
      }
      case 0xce: {
        const c = this.clock;
        out(reply.fastClockSettings(c.settings | (c.enabled ? FastClockFlag.Enabled : 0), c.rate, c.startWeekday, c.startHour, c.startMinute));
        return true;
      }
      case 0xcf: {
        const c = this.clock;
        c.settings = d[0]! & 0x7f;
        c.enabled = !!(d[0]! & FastClockFlag.Enabled);
        if (d.length >= 2) c.rate = d[1]! & 0x3f;
        if (d.length >= 4) { c.startWeekday = d[2]! >> 5; c.startHour = d[2]! & 0x1f; c.startMinute = d[3]! & 0x3f; }
        return true;
      }
      case 0xc8: {
        const nid = d.readUInt16LE(0);
        const b = this.canBoosters.get(nid);
        if (b) out(reply.canDeviceName(nid, b.name));
        return true;
      }
      case 0xc9: {
        const b = this.canBoosters.get(d.readUInt16LE(0));
        if (b) { const z = d.indexOf(0, 2); b.name = d.subarray(2, z < 0 ? undefined : z).toString("latin1"); }
        return true;
      }
      case 0xcb: {
        const b = this.canBoosters.get(d.readUInt16LE(0));
        if (!b) return true;
        const p = d[2]!;
        if (p === 0x00) b.outputs.forEach((o) => (o.disabled = true));
        else if (p === 0xff) b.outputs.forEach((o) => (o.disabled = false));
        else if (b.outputs[(p >> 4) - 1]) b.outputs[(p >> 4) - 1]!.disabled = (p & 0x0f) === 0;
        this.tick();
        return true;
      }
      case 0xe8:
        if (d[0] === 0x06 && dev !== "z21") {
          out(reply.zlinkHwInfo(401, 1, 1, 3217, "EC FA BC 4F 04 C6", this.deviceName));
          return true;
        }
        return false;
    }
    if (dev === "booster") {
      if (f.header === 0xb8) { out(reply.deviceName("booster", this.deviceName)); return true; }
      if (f.header === 0xb9) { this.deviceName = d.subarray(0, d.indexOf(0) < 0 ? undefined : d.indexOf(0)).toString("latin1"); return true; }
      if (f.header === 0xbb) { out(this.boosterStateFrame()); return true; }
      if (f.header === 0xb2) {
        const on = d[1] === 1;
        if (d[0] === 1 || d[0] === 3) this.boosterDisabled[0] = !on;
        if (d[0] === 2 || d[0] === 3) this.boosterDisabled[1] = !on;
        this.broadcastDeviceState();
        return true;
      }
    }
    if (dev === "switchDecoder" || dev === "signalDecoder") {
      if (f.header === 0xd8) { out(reply.deviceName("decoder", this.deviceName)); return true; }
      if (f.header === 0xd9) { this.deviceName = d.subarray(0, d.indexOf(0) < 0 ? undefined : d.indexOf(0)).toString("latin1"); return true; }
      if (f.header === 0xdb) { out(this.decoderStateFrame()); return true; }
    }
    return false;
  }

  /** X-Bus commands. Returns true if handled. */
  handleX(xHeader: number, db: number[], out: (b: Buffer) => void): boolean {
    const loco = (hi: number, lo: number) => ((hi & 0x3f) << 8) | lo;
    if (xHeader === 0xf1 && db[0] === 0x0a) { out(reply.firmwareVersion(1, 43)); return true; }
    if (xHeader === 0x92) { // loco e-stop
      const l = this.ctx.locos.get(loco(db[0]!, db[1]!));
      if (l) { l.emergencyStop = true; l.speed = 0; this.ctx.pushLoco(l.address); }
      return true;
    }
    if (xHeader === 0xe3 && db[0] === 0x44) { this.ctx.locos.delete(loco(db[1]!, db[2]!)); return true; }
    if (xHeader === 0xe4 && db[0]! >= 0x20 && db[0]! !== 0x5f && db[0]! !== 0xf8) { // function group
      const addr = loco(db[1]!, db[2]!);
      const l = this.ctx.locos.get(addr);
      const v = db[3]!;
      if (l) {
        const first = ({ 0x21: 5, 0x22: 9, 0x23: 13, 0x28: 21, 0x29: 29 } as Record<number, number>)[db[0]!];
        if (db[0] === 0x20) {
          l.functions[0] = !!(v & 0x10);
          for (let i = 0; i < 4; i++) l.functions[1 + i] = !!(v & (1 << i));
        } else if (first !== undefined) {
          const n = db[0] === 0x21 || db[0] === 0x22 ? 4 : 8;
          for (let i = 0; i < n; i++) if (first + i < 29) l.functions[first + i] = !!(v & (1 << i));
        }
        this.ctx.pushLoco(addr);
      }
      return true;
    }
    if (xHeader === 0xe5 && db[0] === 0x5f) return true; // binary state: no reply by spec
    if (xHeader === 0xe6 && (db[0] === 0x30 || db[0] === 0x31)) {
      const opt = db[3]! & 0xfc;
      const cv = (((db[3]! & 3) << 8) | db[4]!) + 1;
      const key = `${db[0]}:${db[1]}:${db[2]}:${cv}`;
      if (opt === 0xec) this.pomCvs.set(key, db[5]!);
      else if (opt === 0xe8) {
        const old = this.pomCvs.get(key) ?? 0, bit = db[5]! & 7;
        this.pomCvs.set(key, db[5]! & 8 ? old | (1 << bit) : old & ~(1 << bit));
      } else if (opt === 0xe4) {
        const v = this.pomCvs.get(key);
        out(v === undefined ? reply.cvError("noAck") : reply.cv(cv, v));
      }
      return true;
    }
    if (xHeader === 0x24 && db[0] === 0xff) { out(reply.cv(db[2]! + 1, db[3]!)); return true; } // "finished" only
    if (xHeader === 0x22 && db[0] === 0x11) { out(reply.cv(db[1]!, this.ctx.cvs.get(1000 + db[1]!) ?? 0)); return true; }
    if (xHeader === 0x23 && db[0] === 0x12) { this.ctx.cvs.set(1000 + db[1]!, db[2]!); out(reply.cv(db[1]!, db[2]!)); return true; }
    if (xHeader === 0x54) {
      const raw = (db[0]! << 8) | db[1]!;
      if (raw === 2047) { this.extAccessories.clear(); return true; }
      this.extAccessories.set(raw - 3, db[2]!);
      this.signalAspect[(raw - 4) & 3] = db[2]!;
      this.switchOutputs[(raw - 4) % 8] = db[2]! & 0x80 ? 2 : 1;
      this.ctx.broadcast(reply.extAccessory(raw - 3, db[2]!), Broadcast.Basic);
      return true;
    }
    if (xHeader === 0x44) {
      const addr = ((db[0]! << 8) | db[1]!) - 3;
      const v = this.extAccessories.get(addr);
      out(reply.extAccessory(addr, v ?? 0, v !== undefined));
      return true;
    }
    return false;
  }
}
