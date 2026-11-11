import type { FastifyInstance } from "fastify";
import {
  EMPTY_LAYOUT, feedbackBuses, routeCommands, stateCount, tileCommands, turnoutAddresses, validateLayout,
  type Layout, type LayoutCommand,
} from "@z21/protocol";
import { Interlocking, type RouteState } from "@z21/interlocking";
import { JsonFile } from "./json-file.js";
import type { RouteRun, Station } from "./station.js";

interface Job { total: number; sent: number; resolve: () => void; reject: (e: Error) => void; onStep?: (done: number) => void }

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * Signal box: keeps the track diagram and turns clicks and routes into commands for the station.
 * All switching goes through one queue, so two solenoids never draw current at the same time.
 */
export class SignalBox {
  private layout: Layout;
  private file: JsonFile<Layout>;
  private pending: { c: LayoutCommand; job: Job }[] = [];
  private draining = false;
  private routeRun?: RouteRun;
  private il: Interlocking;
  private ticker?: NodeJS.Timeout;

  constructor(private station: Station, file?: string, private gapMs = 250) {
    this.file = new JsonFile(file);
    this.layout = structuredClone(EMPTY_LAYOUT);
    const stored = this.file.read();
    if (stored) {
      try { this.layout = validateLayout(stored); } catch (e) { console.error("layout.json ignoriert:", (e as Error).message); }
    }
    this.il = new Interlocking(this.layout);
    station.extra = () => ({ layout: this.layout, routeRun: this.routeRun, interlocking: this.il.states() });
    station.on("connected", () => this.sync());
    station.on("state", () => this.evaluate());
    this.pin();
  }

  get(): Layout { return this.layout; }

  /** Replace the diagram (validated); returns the normalised version. */
  save(input: unknown): Layout {
    if (this.il.states().length) throw httpError(409, "Es sind noch Fahrstraßen angefordert; zuerst auflösen");
    try { this.layout = validateLayout(input); } catch (e) { throw httpError(400, (e as Error).message); }
    this.il = new Interlocking(this.layout);
    this.file.write(() => this.layout);
    this.pin();
    this.sync();
    this.station.notify();
    return this.layout;
  }

  /** Detectors used in the diagram must report even when their monitor tab is closed. */
  private pin() {
    const buses = feedbackBuses(this.layout);
    this.station.pinMonitors({ rmbus: buses.has("rbus"), detectors: buses.has("loconet") || buses.has("can"), clock: this.layout.tiles.length > 0 }); // the clock feeds the second screen
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

  /**
   * Run commands one after the other with a pause in between; resolves when the last one is out.
   * `urgent` commands (the interlocking's signal Halt, releases) go to the front: they must not wait behind
   * a long, unrelated switching job. Still one command at a time, so two solenoids never draw current together.
   */
  private enqueue(commands: LayoutCommand[], onStep?: (done: number) => void, urgent = false): Promise<void> {
    if (!commands.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const job: Job = { total: commands.length, sent: 0, resolve, reject, onStep };
      const items = commands.map((c) => ({ c, job }));
      if (urgent) this.pending.unshift(...items); else this.pending.push(...items);
      void this.drain();
    });
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const { c, job } = this.pending.shift()!;
        if (!this.station.client.connected) {
          const jobs = new Set([job, ...this.pending.map((i) => i.job)]);
          this.pending = [];
          for (const j of jobs) j.reject(httpError(409, "not connected"));
          break;
        }
        this.send(c);
        job.sent++; // not inside the optional call: `onStep?.(++sent)` skips its argument when there is no onStep
        job.onStep?.(job.sent);
        await new Promise((r) => setTimeout(r, this.gapMs));
        if (job.sent === job.total) job.resolve();
      }
    } finally { this.draining = false; }
  }

  async setTile(id: string, state: number) {
    const tile = this.layout.tiles.find((t) => t.id === id) ?? (() => { throw httpError(404, "Feld nicht gefunden"); })();
    const holder = this.il.lockedBy(id);
    if (holder) throw httpError(409, `Feld ist durch Fahrstraße „${this.layout.routes.find((r) => r.id === holder)?.name ?? holder}“ verriegelt`);
    let commands: LayoutCommand[];
    try { commands = tileCommands(tile, state); } catch (e) { throw httpError(400, (e as Error).message); }
    if (commands.length === 0) throw httpError(409, "Dieses Feld ist noch mit keiner Adresse verknüpft");
    if (!this.station.client.connected) throw httpError(409, "not connected");
    await this.enqueue(commands);
    return { ok: true, commands: commands.length };
  }

  /**
   * Refuse switching a turnout or DCCext address by hand while an interlocked route holds a tile that uses it.
   * Called by the direct switching endpoints, which do not go through setTile().
   */
  assertAddressFree(type: "turnout" | "ext", address: number) {
    const locked = this.il.lockedTiles();
    if (!locked.size) return;
    for (const t of this.layout.tiles) {
      if (!locked.has(t.id)) continue;
      const uses = Array.from({ length: stateCount(t) }, (_, i) => tileCommands(t, i)).flat().some((c) => c.type === type && c.address === address);
      if (uses) {
        const route = this.layout.routes.find((r) => r.id === this.il.lockedBy(t.id));
        throw httpError(409, `Adresse ${address} ist durch Fahrstraße „${route?.name ?? "?"}“ verriegelt`);
      }
    }
  }

  /* ---------- interlocked routes ---------- */

  /** Request a route with safety checks; the turnouts are driven in the background, the signal clears last. */
  requestRoute(id: string) {
    if (!this.station.client.connected) throw httpError(409, "not connected");
    const out = this.il.request(id, this.station.snapshot(), Date.now());
    if (!out.ok) throw httpError(409, out.reason ?? "Fahrstraße abgelehnt");
    this.dispatch(out.commands);
    this.startTicker();
    this.station.notify();
    return { ok: true };
  }

  /** Cancel a route; with force (Notauflösung) also while a train is inside. */
  releaseRoute(id: string, force = false) {
    const out = this.il.release(id, force);
    if (!out.ok) throw httpError(409, out.reason ?? "Auflösen nicht möglich");
    this.dispatch(out.commands, true); // Halt for the signal
    if (!this.il.states().length) this.stopTicker();
    this.station.notify();
    return { ok: true };
  }

  routeStates(): RouteState[] { return this.il.states(); }

  /** Called on every station update. Frozen while disconnected: stale detector data must not release anything. */
  private evaluate() {
    if (!this.il.states().length) { this.stopTicker(); return; }
    if (!this.station.client.connected) return;
    const commands = this.il.step(this.station.snapshot(), Date.now());
    this.dispatch(commands, true); // signals to Halt (or Fahrt after the positions are confirmed) do not wait in line
    if (!this.il.states().length) this.stopTicker();
  }

  private dispatch(commands: LayoutCommand[], urgent = false) {
    if (!commands.length) return;
    this.enqueue(commands, undefined, urgent).catch((e: Error) => console.error("Fahrstraßen-Befehl fehlgeschlagen:", e.message));
  }

  /** Timeouts need a clock even when nothing changes. */
  private startTicker() {
    this.ticker ??= setInterval(() => { this.evaluate(); this.station.notify(); }, 1000);
    this.ticker.unref();
  }
  private stopTicker() { clearInterval(this.ticker); this.ticker = undefined; }

  /** Starts a route; switching continues in the background, progress is part of the state. */
  runRoute(id: string) {
    const route = this.layout.routes.find((r) => r.id === id) ?? (() => { throw httpError(404, "Fahrstraße nicht gefunden"); })();
    const locked = route.steps.find((s) => this.il.lockedBy(s.tileId));
    if (locked) throw httpError(409, "Ein Feld der Fahrstraße ist durch eine gesicherte Fahrstraße verriegelt");
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
  app.get("/api/interlocking", async () => box.routeStates());
  app.post<{ Params: { id: string } }>("/api/interlocking/:id/request", async (req) => box.requestRoute(req.params.id));
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>("/api/interlocking/:id/release", async (req) => box.releaseRoute(req.params.id, req.body?.force === true));
  app.post<{ Params: { id: string } }>("/api/layout/route/:id/run", async (req) => {
    const { total } = box.runRoute(req.params.id);
    return { ok: true, total };
  });
}
