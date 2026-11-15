/**
 * Interlocking ("Stellwerkslogik"): decides when a route may be set, keeps it locked while a train uses it and
 * releases it afterwards. Pure state machine: no I/O, no timers, no hardware. The caller feeds in the live
 * state and the current time and executes the returned commands.
 *
 * Safety rules:
 *  - Unknown is never "free": a block whose detectors have not reported blocks the route.
 *  - Routes lock their blocks and turnouts; a second route may only share a turnout in the same position
 *    and never a block.
 *  - Turnouts are driven first, the signal is cleared last and only once every position is reported back.
 *  - The start block may be occupied when the route is requested: that is the train the route is for. Every other
 *    block must be free.
 *  - Once a train has entered (a block other than an occupied start block reports it), the signal goes back to Halt.
 *    The route is released when the train has arrived: the target block was reached and every other block reports
 *    free again; the train may stay in the target block. A momentary "all free" while the train moves from one block
 *    to the next therefore releases nothing. Routes without a target block are released once every block was seen
 *    occupied and all are free again. (Whole-route release; per-block release needs the track graph.)
 *  - A locked turnout that moves, or a block that is taken while the route is still being set, is a fault:
 *    the signal goes to Halt and the locks stay until the operator releases the route.
 */
import {
  blockOccupied, tileCommands, tileState,
  type Layout, type LayoutCommand, type LayoutLiveState, type Route, type RouteStep, type Tile,
} from "@openstellwerk/protocol/layout";

/** setting = turnouts being driven; set = signal cleared, waiting for the train; running = train inside; fault = needs the operator. */
export type RouteStatus = "idle" | "setting" | "set" | "running" | "fault";

export interface RouteState {
  routeId: string;
  status: RouteStatus;
  /** time of the last status change (ms, caller's clock) */
  since: number;
  message?: string;
}

export interface Outcome {
  ok: boolean;
  /** human readable reason when !ok (German, shown in the UI) */
  reason?: string;
  commands: LayoutCommand[];
}

/** How a route ended: train arrived (completed), operator release (released), emergency release with a train inside (forced), release of a faulted route (fault). */
export type EndReason = "completed" | "released" | "forced" | "fault";

export interface EndedRoute {
  routeId: string;
  reason: EndReason;
}

const HALT = 0;
const CLEAR = 1;

interface Active extends RouteState {
  route: Route;
  switches: RouteStep[];
  signals: RouteStep[];
  blocks: string[];
  signalCleared: boolean;
  /** blocks that have been reported occupied since the route was cleared */
  seen: Set<string>;
  /** blocks that must stay free until the train enters: all of them, minus a start block the train already stands in */
  watched: string[];
}

export interface InterlockingOptions {
  /** How long the turnouts may take to report their position before the route fails (ms). Default 15000. */
  settleTimeout?: number;
}

export class Interlocking {
  private readonly active = new Map<string, Active>();
  private ended: EndedRoute[] = [];
  private readonly tiles: Map<string, Tile>;
  private readonly routes: Map<string, Route>;
  private readonly timeout: number;

  constructor(private readonly layout: Layout, opts: InterlockingOptions = {}) {
    this.tiles = new Map(layout.tiles.map((t) => [t.id, t]));
    this.routes = new Map(layout.routes.map((r) => [r.id, r]));
    this.timeout = opts.settleTimeout ?? 15000;
  }

  /** Status of every route that is not idle. */
  states(): RouteState[] {
    return [...this.active.values()].map(({ routeId, status, since, message }) => ({ routeId, status, since, ...(message ? { message } : {}) }));
  }

  /** Which route holds a tile (turnout, signal or track) locked, if any. Callers use it to refuse manual switching. */
  lockedBy(tileId: string): string | undefined {
    for (const a of this.active.values()) {
      if (a.switches.some((s) => s.tileId === tileId) || a.signals.some((s) => s.tileId === tileId)) return a.routeId;
    }
    return undefined;
  }

  /** All tiles (turnouts, signals) held by active routes; callers use it to refuse switching them by address. */
  lockedTiles(): Set<string> {
    return new Set([...this.active.values()].flatMap((a) => [...a.switches, ...a.signals].map((s) => s.tileId)));
  }

  /** Blocks that belong to an active route. */
  lockedBlocks(): Set<string> {
    return new Set([...this.active.values()].flatMap((a) => a.blocks));
  }

  request(routeId: string, live: LayoutLiveState, now: number): Outcome {
    const route = this.routes.get(routeId);
    if (!route) return refuse("Fahrstraße unbekannt");
    if (this.active.has(routeId)) return refuse("Fahrstraße ist schon angefordert");
    const blocks = this.blocksOf(route);
    if (!blocks.length) return refuse("Fahrstraße hat keine Blöcke; ohne Block gibt es keine Sicherung");

    let startOccupied = false;
    for (const bid of blocks) {
      const block = this.layout.blocks!.find((b) => b.id === bid)!;
      const o = blockOccupied(this.layout, block, live);
      if (o === true && bid === route.from && route.to && route.to !== route.from) { startOccupied = true; continue; } // the train itself
      if (o === true) return refuse(`Block „${block.name}“ ist besetzt`);
      if (o === undefined) return refuse(`Block „${block.name}“: Melder meldet (noch) nichts, daher nicht sicher frei`);
    }
    const { switches, signals } = this.split(route);
    for (const other of this.active.values()) {
      const shared = blocks.find((b) => other.blocks.includes(b));
      if (shared) return refuse(`Block „${this.layout.blocks!.find((b) => b.id === shared)!.name}“ gehört zur Fahrstraße „${other.route.name}“`);
      for (const s of [...switches, ...signals]) {
        const theirs = [...other.switches, ...other.signals].find((x) => x.tileId === s.tileId);
        if (theirs && theirs.state !== s.state) return refuse(`${this.label(s.tileId)} ist durch „${other.route.name}“ in anderer Stellung verriegelt`);
      }
    }

    // Work out the commands first: if that fails, nothing may stay locked.
    let commands: LayoutCommand[];
    try { commands = switches.flatMap((s) => this.drive(s, live)); } catch (e) { return refuse(`Fahrstraße nicht stellbar: ${(e as Error).message}`); }
    this.active.set(routeId, { routeId, route, switches, signals, blocks, status: "setting", since: now, signalCleared: false, seen: new Set(), watched: startOccupied ? blocks.filter((b) => b !== route.from) : blocks });
    // Only drive what is not already in place; the rest is already locked by the entry above.
    return { ok: true, commands };
  }

  /**
   * Re-evaluate every active route against the live state. Call it on every state update and at least once per
   * second (timeouts). Returns the commands to execute now.
   */
  step(live: LayoutLiveState, now: number): LayoutCommand[] {
    const out: LayoutCommand[] = [];
    for (const a of [...this.active.values()]) {
      if (a.status === "fault") continue;
      const occupied = a.blocks.map((bid) => blockOccupied(this.layout, this.layout.blocks!.find((b) => b.id === bid)!, live));

      const entered = a.blocks.some((bid, i) => occupied[i] === true && a.watched.includes(bid));

      if (a.status === "setting") {
        if (entered) { out.push(...this.fail(a, "Block wurde vor der Zugfahrt besetzt", now)); continue; }
        if (occupied.some((o) => o === undefined)) { out.push(...this.fail(a, "Melder ausgefallen", now)); continue; }
        if (a.switches.every((s) => this.inPlace(s, live))) {
          // Positions confirmed: clear the signal last.
          for (const s of a.signals) out.push(...this.drive({ ...s, state: s.state }, live));
          a.signalCleared = true;
          this.to(a, "set", now);
        } else if (now - a.since > this.timeout) {
          out.push(...this.fail(a, "Weichen haben ihre Lage nicht rechtzeitig gemeldet", now));
        }
        continue;
      }

      // set / running: a locked turnout must not move.
      const moved = a.switches.find((s) => !this.inPlace(s, live) && tileState(this.tiles.get(s.tileId)!, live) !== undefined);
      if (moved) { out.push(...this.fail(a, `${this.label(moved.tileId)} wurde verstellt`, now)); continue; }

      a.blocks.forEach((bid, i) => { if (occupied[i] === true) a.seen.add(bid); });
      if (a.status === "set" && entered) {
        out.push(...this.haltSignals(a));
        this.to(a, "running", now);
      } else if (a.status === "running" && this.arrived(a, occupied)) {
        this.active.delete(a.routeId);
        this.ended.push({ routeId: a.routeId, reason: "completed" });
      } else if (a.status === "set" && occupied.some((o) => o === undefined)) {
        out.push(...this.fail(a, "Melder ausgefallen", now));
      }
    }
    return out;
  }

  /**
   * Operator releases a route. Without `force` a route with a train in it (running) is refused; with `force`
   * (Notauflösung) the locks go away regardless. Signals are set to Halt first.
   */
  release(routeId: string, force = false): Outcome {
    const a = this.active.get(routeId);
    if (!a) return refuse("Fahrstraße ist nicht angefordert");
    if (a.status === "running" && !force) return refuse("Zug befindet sich in der Fahrstraße; nur per Notauflösung");
    const commands = a.signalCleared ? this.haltSignals(a) : [];
    this.active.delete(routeId);
    this.ended.push({ routeId, reason: a.status === "fault" ? "fault" : a.status === "running" ? "forced" : "released" });
    return { ok: true, commands };
  }

  /** Routes that ended since the last call, with the reason; returns and clears the list. */
  drainEnded(): EndedRoute[] {
    const out = this.ended;
    this.ended = [];
    return out;
  }

  /** Drop everything without commands, e.g. after the layout changed. */
  reset(): void { this.active.clear(); this.ended = []; }

  /* ---------- helpers ---------- */

  private blocksOf(route: Route): string[] {
    const ids = new Set<string>();
    if (route.from) ids.add(route.from);
    if (route.to) ids.add(route.to);
    for (const b of route.blocks ?? []) ids.add(b);
    const tileIds = new Set([...route.steps, ...(route.flank ?? [])].map((s) => s.tileId));
    for (const b of this.layout.blocks ?? []) if (b.tileIds.some((t) => tileIds.has(t))) ids.add(b.id);
    return [...ids];
  }

  /**
   * Arrived and clear: the target block was reached and every other block is free again (the train may stay in the
   * target block, but its detector must report). Without a target block: every block was seen and all are free.
   */
  private arrived(a: Active, occupied: (boolean | undefined)[]): boolean {
    if (!this.reachedTarget(a)) return false;
    return a.blocks.every((bid, i) => (bid === a.route.to ? occupied[i] !== undefined : occupied[i] === false));
  }

  /** The train has arrived: the target block was occupied (without a target block: every block of the route was). */
  private reachedTarget(a: Active): boolean {
    return a.route.to ? a.seen.has(a.route.to) : a.blocks.every((b) => a.seen.has(b));
  }

  /** Splits a route into turnout steps (incl. flank protection, driven first) and signal steps (cleared last). */
  private split(route: Route): { switches: RouteStep[]; signals: RouteStep[] } {
    const all = [...route.steps, ...(route.flank ?? [])];
    const signals = all.filter((s) => this.tiles.get(s.tileId)?.kind === "signal");
    if (route.signal && !signals.some((s) => s.tileId === route.signal)) signals.push({ tileId: route.signal, state: CLEAR });
    return { switches: all.filter((s) => this.tiles.get(s.tileId)?.kind !== "signal"), signals };
  }

  /** Position reported back; tiles that are not linked to any address count as in place. */
  private inPlace(s: RouteStep, live: LayoutLiveState): boolean {
    const t = this.tiles.get(s.tileId)!;
    return tileCommands(t, s.state).length === 0 || tileState(t, live) === s.state;
  }

  private drive(s: RouteStep, live: LayoutLiveState): LayoutCommand[] {
    const t = this.tiles.get(s.tileId)!;
    return tileState(t, live) === s.state ? [] : tileCommands(t, s.state);
  }

  private haltSignals(a: Active): LayoutCommand[] {
    a.signalCleared = false;
    return a.signals.flatMap((s) => tileCommands(this.tiles.get(s.tileId)!, HALT));
  }

  private fail(a: Active, message: string, now: number): LayoutCommand[] {
    a.message = message;
    this.to(a, "fault", now);
    return this.haltSignals(a);
  }

  private to(a: Active, status: RouteStatus, now: number) {
    a.status = status;
    a.since = now;
    if (status !== "fault") delete a.message;
  }

  private label(tileId: string) {
    const t = this.tiles.get(tileId);
    return t?.label ? `„${t.label}“` : `Feld ${tileId}`;
  }
}

function refuse(reason: string): Outcome { return { ok: false, reason, commands: [] }; }
