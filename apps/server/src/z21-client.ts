import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { Broadcast, cmd, decodeFrames, parseFrame, Z21_PORT, type Message } from "@openstellwerk/protocol";

export interface WireEvent {
  dir: "tx" | "rx";
  hex: string;
  message?: Message;
  ts: number;
}

/** UDP session to one Z21. The Z21 drops clients after ~60 s of silence, so we ping every 20 s. */
export class Z21Client extends EventEmitter<{ message: [Message]; wire: [WireEvent]; close: [] }> {
  private socket?: dgram.Socket;
  private keepalive?: NodeJS.Timeout;
  host?: string;
  port = Z21_PORT;
  /** currently active broadcast subscription */
  flags = 0;

  get connected() {
    return !!this.socket && !!this.host;
  }

  async connect(host: string, port = Z21_PORT, flags = Broadcast.Basic | Broadcast.SystemState | Broadcast.AllLocos) {
    this.disconnect();
    this.host = host;
    this.port = port;
    const s = (this.socket = dgram.createSocket("udp4"));
    s.on("message", (buf, rinfo) => {
      if (rinfo.address !== this.host) return;
      for (const f of decodeFrames(buf)) {
        const message = parseFrame(f);
        this.emit("wire", { dir: "rx", hex: buf.toString("hex"), message, ts: Date.now() });
        this.emit("message", message);
      }
    });
    s.on("error", () => this.disconnect());
    await new Promise<void>((resolve) => s.bind(0, resolve));
    // Probe first: fail fast if nothing answers.
    try {
      await this.request(cmd.getSerialNumber(), (m) => m.type === "serial", 2000);
    } catch (e) {
      this.disconnect();
      throw e;
    }
    this.setFlags(flags);
    this.send(cmd.getHwInfo());
    this.send(cmd.getStatus());
    this.send(cmd.getSystemState());
    this.keepalive = setInterval(() => this.send(cmd.getSystemState()), 20_000);
  }

  setFlags(flags: number) {
    this.flags = flags;
    this.send(cmd.setBroadcastFlags(flags));
  }

  disconnect() {
    if (!this.socket) return;
    clearInterval(this.keepalive);
    try { this.send(cmd.logoff()); } catch { /* socket already gone */ }
    this.socket.close();
    this.socket = undefined;
    this.host = undefined;
    this.emit("close");
  }

  send(buf: Buffer) {
    if (!this.socket || !this.host) throw new Error("Keine Verbindung zur Zentrale");
    this.emit("wire", { dir: "tx", hex: buf.toString("hex"), ts: Date.now() });
    this.socket.send(buf, this.port, this.host);
  }

  request<T extends Message>(buf: Buffer, match: (m: Message) => m is T, timeoutMs?: number): Promise<T>;
  request(buf: Buffer, match: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
  request(buf: Buffer, match: (m: Message) => boolean, timeoutMs = 3000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(t); this.off("message", onMsg); fn(); };
      const onMsg = (m: Message) => { if (match(m)) done(() => resolve(m)); };
      const t = setTimeout(() => done(() => reject(Object.assign(new Error("Die Zentrale hat nicht rechtzeitig geantwortet"), { statusCode: 504 }))), timeoutMs);
      this.on("message", onMsg);
      try { this.send(buf); } catch (e) { done(() => reject(e)); }
    });
  }
}

/** Broadcast GET_SERIAL_NUMBER and collect answering Z21s. */
export function discover(timeoutMs = 1500): Promise<{ host: string; serial: number }[]> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const found = new Map<string, number>();
    s.on("message", (buf, rinfo) => {
      for (const f of decodeFrames(buf)) {
        const m = parseFrame(f);
        if (m.type === "serial") found.set(rinfo.address, m.serial);
      }
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { s.close(); } catch { /* already closed */ }
      resolve([...found].map(([host, serial]) => ({ host, serial })));
    };
    // Broadcast can fail (e.g. over a VPN/utun interface): never crash the server, just report what we found.
    s.on("error", finish);
    s.bind(0, () => {
      try {
        s.setBroadcast(true);
        s.send(cmd.getSerialNumber(), Z21_PORT, "255.255.255.255", (err) => { if (err) finish(); });
      } catch { finish(); return; }
      setTimeout(finish, timeoutMs);
    });
  });
}
