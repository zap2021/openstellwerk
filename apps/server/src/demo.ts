import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { Z21Simulator } from "@openstellwerk/simulator";
import type { Layout } from "@openstellwerk/protocol";
import type { SignalBox } from "./layout.js";
import type { Station } from "./station.js";
import type { TimetableRunner } from "./timetable.js";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The example track diagrams, relative to this file (repo/docs). */
export const DEMO_EXAMPLES = {
  bahnhof: new URL("../../../docs/beispiel-gleisbild.json", import.meta.url),
  rundkurs: new URL("../../../docs/beispiel-rundkurs.json", import.meta.url),
} as const;
export type DemoExample = keyof typeof DEMO_EXAMPLES;

/**
 * Demo mode: runs a Z21 simulator inside the server and connects the station to it, so every tab works without
 * hardware. When a route is set, a virtual train drives through its blocks (the simulator reports the detectors),
 * which shows the whole interlocking cycle: set, locked, entered, released.
 */
export class Demo {
  private sim?: Z21Simulator;
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  /** bumped on every start/stop, so a train from an earlier session ends quietly */
  private session = 0;

  constructor(private station: Station, private box: SignalBox, private pace = 1, private timetable?: Pick<TimetableRunner, "loadExample" | "clockAction" | "get">) {}

  get active() { return !!this.sim; }

  /**
   * @param example which example diagram to load if there is none yet (saved like any other diagram); false = none
   * @param replace load the example even when there is a diagram already: the caller has asked the user
   */
  async start(example: DemoExample | false = "bahnhof", replace = false) {
    if (this.sim) return;
    if (this.station.client.connected) throw httpError(409, "Es besteht eine Verbindung zu einer Zentrale. Zuerst trennen.");
    if (example && (replace || this.box.get().tiles.length === 0)) {
      try { this.box.save(JSON.parse(readFileSync(DEMO_EXAMPLES[example], "utf8"))); } catch (e) { console.error("Demo: Beispiel-Gleisbild nicht geladen:", (e as Error).message); }
    }
    const sim = new Z21Simulator();
    await sim.listen(0, "127.0.0.1");
    this.sim = sim;
    const session = ++this.session;
    try {
      await this.station.connect("127.0.0.1", (sim.socket.address() as AddressInfo).port);
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.station.demo = true;
    this.station.notify();
    this.startTimetable();
    this.timer = setInterval(() => this.tick(session), 500);
  }

  /** Example timetable on an empty system, and the model clock running; a clock the user already runs stays as it is. */
  private startTimetable() {
    const tt = this.timetable;
    if (!tt) return;
    try {
      if (tt.loadExample()) tt.clockAction({ action: "set", time: "05:58", factor: 20 });
      if (!tt.get().clock.running) tt.clockAction({ action: "start" });
    } catch (e) { console.error("Demo: Fahrplan nicht gestartet:", (e as Error).message); }
  }

  async stop() {
    this.session++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.running.clear();
    const sim = this.sim;
    this.sim = undefined;
    if (!sim) return;
    this.station.client.disconnect();
    sim.close();
    this.station.demo = false;
    this.station.notify();
  }

  /** Start a train for every interlocked route that has just been cleared. */
  private tick(session: number) {
    for (const r of this.station.snapshot().interlocking ?? []) {
      if (r.status === "set" && !this.running.has(r.routeId)) {
        this.running.add(r.routeId);
        void this.drive(r.routeId, session).finally(() => this.running.delete(r.routeId));
      }
    }
  }

  private async drive(routeId: string, session: number) {
    const layout = this.box.get();
    const route = layout.routes.find((x) => x.id === routeId);
    if (!route) return;
    // The train only runs while its route is still requested: released or replaced routes end it.
    const alive = () => session === this.session && !!this.sim && !!this.station.snapshot().interlocking?.some((r) => r.routeId === routeId);
    const wait = async (ms: number) => { await sleep(ms / this.pace); return alive(); };
    // Block order along the route: start block, blocks in between, target block.
    const path = [route.from, ...routeBlocks(layout, routeId), route.to].filter((b, i, a): b is string => !!b && a.indexOf(b) === i);
    let prev: string | undefined;
    try {
      if (!(await wait(2500))) return;
      for (const b of path) {
        this.occupy(layout, b, true);
        if (prev) this.occupy(layout, prev, false);
        prev = b;
        if (!(await wait(3000))) return;
      }
    } finally {
      if (prev) this.occupy(layout, prev, false); // the train always leaves, also when the route ended early
    }
  }

  private occupy(layout: Layout, blockId: string, on: boolean) {
    const sim = this.sim;
    const block = layout.blocks?.find((b) => b.id === blockId);
    if (!sim || !block) return;
    for (const id of block.tileIds) {
      const f = layout.tiles.find((t) => t.id === id)?.feedback;
      if (f?.bus === "rbus") sim.extras.setRmBus(f.module, f.input, on);
      else if (f?.bus === "loconet") sim.setLocoNetOccupancy(f.feedbackAddress, on);
      else if (f?.bus === "can") sim.setCanOccupancy(f.nid, f.port, on);
    }
  }
}

/** Blocks between start and target: the ones the route names, then those found through its turnouts. */
function routeBlocks(layout: Layout, routeId: string): string[] {
  const route = layout.routes.find((r) => r.id === routeId)!;
  const tiles = new Set([...route.steps, ...(route.flank ?? [])].map((s) => s.tileId));
  const derived = (layout.blocks ?? []).filter((b) => b.tileIds.some((t) => tiles.has(t))).map((b) => b.id);
  return [...new Set([...(route.blocks ?? []), ...derived])].filter((b) => b !== route.from && b !== route.to);
}

export function registerDemoRoutes(app: FastifyInstance, demo: Demo) {
  app.get("/api/demo", async () => ({ active: demo.active }));
  app.post<{ Body: { on?: boolean; example?: string; replace?: boolean } }>("/api/demo", async (req) => {
    const example = req.body?.example ?? "bahnhof";
    if (!(example in DEMO_EXAMPLES)) throw httpError(400, "Unbekanntes Beispiel");
    if (req.body?.on === false) await demo.stop(); else await demo.start(example as DemoExample, req.body?.replace === true);
    return { active: demo.active };
  });
}
