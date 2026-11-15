import dgram from "node:dgram";
import type { FastifyInstance } from "fastify";
import { randomInt } from "node:crypto";
import {
  buildReadRequest, MAINTENANCE_PORT, MaintenanceRead, parseMaintenanceResponse, parseNetworkSettings,
  type NetworkSettings,
} from "@openstellwerk/protocol";

/** A datagram that arrived while waiting but was not our answer (kept to explain a timeout). */
interface Ignored { from: string; reason: string }

/** The timeout says what it did receive and ignore: that is the first thing to look at when a real station stays silent. */
const timeoutError = (ignored: Ignored[]) => {
  const base = "Keine Antwort von der Zentrale auf dem Wartungsport (UDP 21106)";
  const detail = ignored.length
    ? ` – ${ignored.length} andere(s) Datagramm(e) ignoriert (${ignored.slice(0, 3).map((i) => `${i.from}: ${i.reason}`).join("; ")})`
    : " – es kam überhaupt nichts zurück";
  return Object.assign(new Error(base + detail), { statusCode: 504 });
};

/** One request/response exchange. Tries local port 21106 first (the original tool does), then any free port. */
async function exchange(host: string, port: number, request: Buffer, seq: number, timeoutMs: number): Promise<Buffer> {
  const open = (localPort: number) => new Promise<dgram.Socket>((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.once("error", reject);
    s.bind(localPort, () => { s.removeListener("error", reject); resolve(s); });
  });
  const s = await open(MAINTENANCE_PORT).catch(() => open(0));
  return new Promise<Buffer>((resolve, reject) => {
    const ignored: Ignored[] = [];
    const skip = (rinfo: dgram.RemoteInfo, reason: string) => { if (ignored.length < 10) ignored.push({ from: `${rinfo.address}:${rinfo.port}`, reason }); };
    const done = (fn: () => void) => { clearTimeout(t); try { s.close(); } catch { /* closed */ } fn(); };
    const t = setTimeout(() => done(() => reject(timeoutError(ignored))), timeoutMs);
    s.on("error", (e) => done(() => reject(e)));
    s.on("message", (buf, rinfo) => {
      // Our own request coming back (target is this machine, or a loop on the network) carries the right address and
      // sequence number but is not an answer.
      if (buf.equals(request)) return skip(rinfo, "eigene Anfrage");
      if (rinfo.address !== host) return skip(rinfo, "fremde Adresse");
      if (buf.length < 8) return skip(rinfo, "zu kurz");
      if (buf.readUInt16LE(6) !== seq) return skip(rinfo, "falsche Folgenummer");
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

/** GET /api/network. There is no maintenance channel without a real command station, so the demo says so plainly. */
export function registerMaintenanceRoutes(app: FastifyInstance, station: { demo: boolean; client: { host?: string } }) {
  app.get("/api/network", async () => {
    if (station.demo) throw Object.assign(new Error("Im Demo-Modus gibt es keine Zentrale mit Wartungsport; die Netzwerkabfrage geht nur an echter Hardware."), { statusCode: 409 });
    if (!station.client.host) throw Object.assign(new Error("Keine Verbindung zur Zentrale"), { statusCode: 409 });
    return readNetworkSettings(station.client.host);
  });
}
