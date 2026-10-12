import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { Station } from "./station.js";
import { discover } from "./z21-client.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1"; // no auth yet: stay local unless explicitly opened up

const app = Fastify({ logger: { level: "info" } });
const station = new Station();
await app.register(websocket);

const int = (v: unknown, min: number, max: number, name: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`${name} must be ${min}..${max}`), { statusCode: 400 });
  return n;
};

app.get("/api/state", async () => station.snapshot());
app.get("/api/discover", async () => discover());

app.post<{ Body: { host: string; port?: number } }>("/api/connect", async (req) => {
  await station.connect(String(req.body.host), req.body.port);
  return station.snapshot();
});
app.post("/api/disconnect", async () => { station.client.disconnect(); return station.snapshot(); });

app.post<{ Body: { on: boolean } }>("/api/power", async (req) => { station.setPower(!!req.body.on); return { ok: true }; });
app.post("/api/estop", async () => { station.emergencyStop(); return { ok: true }; });

app.get<{ Params: { addr: string } }>("/api/loco/:addr", async (req) => station.getLoco(int(req.params.addr, 1, 9999, "address")));
app.post<{ Params: { addr: string }; Body: { speed: number; forward: boolean } }>("/api/loco/:addr/drive", async (req) => {
  station.drive(int(req.params.addr, 1, 9999, "address"), int(req.body.speed, 0, 126, "speed"), !!req.body.forward);
  return { ok: true };
});
app.post<{ Params: { addr: string }; Body: { forward: boolean } }>("/api/loco/:addr/stop", async (req) => {
  station.stopLoco(int(req.params.addr, 1, 9999, "address"), !!req.body.forward);
  return { ok: true };
});
app.post<{ Params: { addr: string; fn: string }; Body: { action: "on" | "off" | "toggle" } }>("/api/loco/:addr/function/:fn", async (req) => {
  station.setFunction(int(req.params.addr, 1, 9999, "address"), int(req.params.fn, 0, 28, "function"), req.body.action ?? "toggle");
  return { ok: true };
});

app.post<{ Params: { addr: string }; Body: { output: 0 | 1 } }>("/api/turnout/:addr", async (req) => {
  station.setTurnout(int(req.params.addr, 1, 16384, "address"), int(req.body.output, 0, 1, "output") as 0 | 1);
  return { ok: true };
});

app.put<{ Body: Partial<{ railcom: boolean; loconet: boolean; detectors: boolean }> }>("/api/monitors", async (req) => {
  const { railcom, loconet, detectors } = req.body ?? {};
  station.setMonitors({
    ...(railcom !== undefined && { railcom: !!railcom }),
    ...(loconet !== undefined && { loconet: !!loconet }),
    ...(detectors !== undefined && { detectors: !!detectors }),
  });
  return station.snapshot().monitors;
});

app.post<{ Body: { addr?: number } }>("/api/railcom/poll", async (req) => {
  station.pollRailCom(int(req.body?.addr ?? 0, 0, 9999, "address"));
  return { ok: true };
});

app.post<{ Body: { bytes: number[] } }>("/api/loconet/send", async (req) => {
  if (!Array.isArray(req.body?.bytes)) throw Object.assign(new Error("bytes must be an array"), { statusCode: 400 });
  try { station.sendLocoNet(req.body.bytes.map((b) => int(b, 0, 255, "byte"))); }
  catch (e) { throw Object.assign(e as Error, { statusCode: 400 }); }
  return { ok: true };
});

app.post<{ Body: { kind: "sic" | "report" | "lissy" | "can"; reportAddress?: number } }>("/api/detectors/poll", async (req) => {
  const { kind, reportAddress } = req.body ?? {};
  if (kind === "can") station.pollCanDetectors();
  else if (kind === "sic") station.pollLocoNetDetectors("Sic");
  else if (kind === "report") station.pollLocoNetDetectors("ReportAddress", int(reportAddress ?? 1017, 1, 65535, "reportAddress"));
  else if (kind === "lissy") station.pollLocoNetDetectors("Lissy", int(reportAddress ?? 1, 0, 65535, "reportAddress"));
  else throw Object.assign(new Error("unknown kind"), { statusCode: 400 });
  return { ok: true };
});

app.get<{ Params: { cv: string } }>("/api/cv/:cv", async (req) => {
  const cv = int(req.params.cv, 1, 1024, "cv");
  return { cv, value: await station.readCv(cv) };
});
app.put<{ Params: { cv: string }; Body: { value: number } }>("/api/cv/:cv", async (req) => {
  const cv = int(req.params.cv, 1, 1024, "cv");
  return { cv, value: await station.writeCv(cv, int(req.body.value, 0, 255, "value")) };
});

app.get("/ws", { websocket: true }, (socket) => {
  const send = (o: unknown) => socket.readyState === 1 && socket.send(JSON.stringify(o, (_, v) => (v?.type === "Buffer" ? undefined : v)));
  send({ kind: "state", state: station.snapshot() });
  const onState = (state: unknown) => send({ kind: "state", state });
  const onWire = (w: unknown) => send({ kind: "wire", wire: w });
  const onLocoNet = (line: unknown) => send({ kind: "loconet", line });
  station.on("loconet", onLocoNet);
  station.on("state", onState);
  station.client.on("wire", onWire);
  socket.on("close", () => { station.off("state", onState); station.client.off("wire", onWire); station.off("loconet", onLocoNet); });
});

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) await app.register(fastifyStatic, { root: webDist });

await app.listen({ port: PORT, host: HOST });
