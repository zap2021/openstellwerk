import type { FastifyInstance } from "fastify";
import {
  EMPTY_LAYOUT, feedbackBuses, routeCommands, tileCommands, turnoutAddresses, validateLayout,
  type Layout, type LayoutCommand,
} from "@z21/protocol";
import { JsonFile } from "./json-file.js";
import type { RouteRun, Station } from "./station.js";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * Signal box: keeps the track diagram and turns clicks and routes into commands for the station.
 * All switching goes through one queue, so two solenoids never draw current at the same time.
 */
export class SignalBox {
  private layout: Layout;
  private file: JsonFile<Layout>;
  private queue: Promise<unknown> = Promise.resolve();
  private routeRun?: RouteRun;

  constructor(private station: Station, file?: string, private gapMs = 250) {
    this.file = new JsonFile(file);
    this.layout = structuredClone(EMPTY_LAYOUT);
    const stored = this.file.read();
    if (stored) {
      try { this.layout = validateLayout(stored); } catch (e) { console.error("layout.json ignoriert:", (e as Error).message); }
    }
    station.extra = () => ({ layout: this.layout, routeRun: this.routeRun });
    station.on("connected", () => this.sync());
    this.pin();
  }

  get(): Layout { return this.layout; }

  /** Replace the diagram (validated); returns the normalised version. */
  save(input: unknown): Layout {
    try { this.layout = validateLayout(input); } catch (e) { throw httpError(400, (e as Error).message); }
    this.file.write(() => this.layout);
    this.pin();
    this.sync();
    this.station.notify();
    return this.layout;
  }

  /** Detectors used in the diagram must report even when their monitor tab is closed. */
  private pin() {
    const buses = feedbackBuses(this.layout);
    this.station.pinMonitors({ rmbus: buses.has("rbus"), detectors: buses.has("loconet") || buses.has("can") });
  }

  /** Fetch what the diagram shows: turnout positions, signal aspects, detector states. */
  sync() {
    if (!this.station.client.connected) return;
    this.station.refreshTurnouts(turnoutAddresses(this.layout));
    for (const t of this.layout.tiles) {
      if (t.kind === "signal" && t.signalMode === "ext" && t.address !== undefined) void this.station.getExtAccessory(t.address).catch(() => undefined);
    }
    const buses = feedbackBuses(this.layout);
    try {
      if (buses.has("rbus")) this.station.pollRmBus();
      if (buses.has("can")) this.station.pollCanDetectors();
    } catch { /* disconnected meanwhile */ }
  }

  private send(c: LayoutCommand) {
    if (c.type === "turnout") this.station.setTurnout(c.address, c.output);
    else this.station.setExtAccessory(c.address, c.value);
  }

  /** Run commands one after the other with a pause in between; resolves when the last one is out. */
  private enqueue(commands: LayoutCommand[], onStep?: (done: number) => void): Promise<void> {
    const run = async () => {
      for (let i = 0; i < commands.length; i++) {
        if (!this.station.client.connected) throw httpError(409, "not connected");
        this.send(commands[i]!);
        onStep?.(i + 1);
        await new Promise((r) => setTimeout(r, this.gapMs));
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async setTile(id: string, state: number) {
    const tile = this.layout.tiles.find((t) => t.id === id) ?? (() => { throw httpError(404, "Feld nicht gefunden"); })();
    let commands: LayoutCommand[];
    try { commands = tileCommands(tile, state); } catch (e) { throw httpError(400, (e as Error).message); }
    if (commands.length === 0) throw httpError(409, "Dieses Feld ist noch mit keiner Adresse verknüpft");
    if (!this.station.client.connected) throw httpError(409, "not connected");
    await this.enqueue(commands);
    return { ok: true, commands: commands.length };
  }

  /** Starts a route; switching continues in the background, progress is part of the state. */
  runRoute(id: string) {
    const route = this.layout.routes.find((r) => r.id === id) ?? (() => { throw httpError(404, "Fahrstraße nicht gefunden"); })();
    if (this.routeRun?.running) throw httpError(409, "Es wird gerade eine Fahrstraße gestellt");
    if (!this.station.client.connected) throw httpError(409, "not connected");
    const commands = routeCommands(this.layout, route);
    if (commands.length === 0) throw httpError(409, "Die Fahrstraße enthält keine verknüpften Felder");
    const run: RouteRun = (this.routeRun = { routeId: id, done: 0, total: commands.length, running: true });
    this.station.notify();
    const finished = this.enqueue(commands, (done) => { run.done = done; this.station.notify(); })
      .catch((e: Error) => { run.error = e.message; })
      .then(() => { run.running = false; this.station.notify(); });
    return { ok: true, total: commands.length, finished };
  }
}

export function registerLayoutRoutes(app: FastifyInstance, box: SignalBox) {
  app.get("/api/layout", async () => box.get());
  app.put("/api/layout", async (req) => box.save(req.body));
  app.post<{ Params: { id: string }; Body: { state: number } }>("/api/layout/tile/:id/set", async (req) => box.setTile(req.params.id, Number(req.body?.state)));
  app.post<{ Params: { id: string } }>("/api/layout/route/:id/run", async (req) => {
    const { total } = box.runRoute(req.params.id);
    return { ok: true, total };
  });
}
