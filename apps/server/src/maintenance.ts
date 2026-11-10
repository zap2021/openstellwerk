import dgram from "node:dgram";
import { randomInt } from "node:crypto";
import {
  buildReadRequest, MAINTENANCE_PORT, MaintenanceRead, parseMaintenanceResponse, parseNetworkSettings,
  type NetworkSettings,
} from "@z21/protocol";

const timeoutError = () => Object.assign(new Error("Keine Antwort von der Zentrale auf dem Wartungsport (UDP 21106)"), { statusCode: 504 });

/** One request/response exchange. Tries local port 21106 first (the original tool does), then any free port. */
async function exchange(host: string, port: number, request: Buffer, seq: number, timeoutMs: number): Promise<Buffer> {
  const open = (localPort: number) => new Promise<dgram.Socket>((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.once("error", reject);
    s.bind(localPort, () => { s.removeListener("error", reject); resolve(s); });
  });
  const s = await open(MAINTENANCE_PORT).catch(() => open(0));
  return new Promise<Buffer>((resolve, reject) => {
    const done = (fn: () => void) => { clearTimeout(t); try { s.close(); } catch { /* closed */ } fn(); };
    const t = setTimeout(() => done(() => reject(timeoutError())), timeoutMs);
    s.on("error", (e) => done(() => reject(e)));
    s.on("message", (buf, rinfo) => {
      if (rinfo.address !== host || buf.length < 8 || buf.readUInt16LE(6) !== seq) return;
      done(() => resolve(buf));
    });
    s.send(request, port, host, (err) => { if (err) done(() => reject(err)); });
  });
}

export interface NetworkInfo extends NetworkSettings {
  mac?: string;
  /** which byte order produced the connected host's own address; undefined = could not be checked */
  verifiedOrder?: "asIs" | "reversed";
}

/** READ-ONLY: asks the command station for its IP settings (and MAC). Never writes anything. */
export async function readNetworkSettings(host: string, opts: { port?: number; timeoutMs?: number } = {}): Promise<NetworkInfo> {
  const port = opts.port ?? MAINTENANCE_PORT;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const ask = async (cmd: number, len: number) => {
    const seq = randomInt(0x10000);
    const res = parseMaintenanceResponse(await exchange(host, port, buildReadRequest(cmd, len, seq), seq, timeoutMs));
    if (res.result !== 0) throw Object.assign(new Error(`Zentrale meldet Fehlercode 0x${res.result.toString(16)}`), { statusCode: 422 });
    return res.data;
  };
  const settings = parseNetworkSettings(await ask(MaintenanceRead.ip, 12));
  let mac: string | undefined;
  try {
    const m = await ask(MaintenanceRead.mac, 6);
    if (m.length >= 6) mac = [...m.subarray(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join(":");
  } catch { /* optional */ }
  const verifiedOrder = settings.asIs.ip === host ? "asIs" : settings.reversed.ip === host ? "reversed" : undefined;
  return { ...settings, mac, verifiedOrder };
}
