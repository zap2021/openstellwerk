import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { Z21Simulator } from "@z21/simulator";
import type { Layout } from "@z21/protocol";
import type { SignalBox } from "./layout.js";
import type { Station } from "./station.js";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where the example track diagram lives, relative to this file (repo/docs/beispiel-gleisbild.json). */
const EXAMPLE = new URL("../../../docs/beispiel-gleisbild.json", import.meta.url);

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

  constructor(private station: Station, private box: SignalBox, private pace = 1) {}

  get active() { return !!this.sim; }

  /** @param exampleLayout load the example diagram if there is none yet (saved like any other diagram) */
  async start(exampleLayout = true) {
    if (this.sim) return;
    if (this.station.client.connected) throw httpError(409, "Es besteht eine Verbindung zu einer Zentrale. Zuerst trennen.");
    if (exampleLayout && this.box.get().tiles.length === 0) {
      try { this.box.save(JSON.parse(readFileSync(EXAMPLE, "utf8"))); } catch (e) { console.error("Demo: Beispiel-Gleisbild nicht geladen:", (e as Error).message); }
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
    this.timer = setInterval(() => this.tick(session), 500);
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
    const alive = () => session === this.session && !!this.sim;
    const wait = async (ms: number) => { await sleep(ms / this.pace); return alive(); };
    // Block order along the route: start block, blocks the route crosses, target block.
    const path = [route.from, ...blocksOnRoute(layout, routeId), route.to].filter((b, i, a): b is string => !!b && a.indexOf(b) === i);
    if (!(await wait(2500))) return;
    let prev: string | undefined;
    for (const b of path) {
      this.occupy(layout, b, true);
      if (prev) this.occupy(layout, prev, false);
      prev = b;
      if (!(await wait(3000))) return;
    }
    if (prev) this.occupy(layout, prev, false);
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

/** Blocks (other than from/to) that contain a tile of the route. */
function blocksOnRoute(layout: Layout, routeId: string): string[] {
  const route = layout.routes.find((r) => r.id === routeId)!;
  const tiles = new Set([...route.steps, ...(route.flank ?? [])].map((s) => s.tileId));
  return (layout.blocks ?? []).filter((b) => b.id !== route.from && b.id !== route.to && b.tileIds.some((t) => tiles.has(t))).map((b) => b.id);
}

export function registerDemoRoutes(app: FastifyInstance, demo: Demo) {
  app.get("/api/demo", async () => ({ active: demo.active }));
  app.post<{ Body: { on?: boolean } }>("/api/demo", async (req) => {
    if (req.body?.on === false) await demo.stop(); else await demo.start();
    return { active: demo.active };
  });
}
