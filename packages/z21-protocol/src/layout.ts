/**
 * Track diagram ("Gleisbild") for the signal box: tiles on a grid, linked to the Z21's switching points.
 * Pure data + logic, no I/O and no Node APIs, so server and browser share it.
 */

/** Edge points of a tile, clockwise with y pointing down: 0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE. -1 = tile centre. */
export type Dir = number;
export const CENTER = -1;

export const TILE_KINDS = [
  "straight", "curve", "turnoutLeft", "turnoutRight", "threeWay", "doubleSlip", "crossing", "crossing90", "bufferStop", "signal", "text",
] as const;
export type TileKind = (typeof TILE_KINDS)[number];

/** Track paths of each kind at rotation 0, as [from, to]. Rotating adds to both directions (mod 8). */
const BASE_PATHS: Record<TileKind, [Dir, Dir][]> = {
  straight: [[4, 0]],
  curve: [[4, 1]],
  turnoutLeft: [[4, 0], [4, 7]],
  turnoutRight: [[4, 0], [4, 1]],
  threeWay: [[4, 0], [4, 7], [4, 1]],
  doubleSlip: [[4, 0], [5, 0], [4, 1], [5, 1]], // order = state: bit 0 picks the left entry, bit 1 the right exit
  crossing: [[4, 0], [5, 1]],
  crossing90: [[4, 0], [6, 2]],
  bufferStop: [[4, CENTER]],
  signal: [[4, 0]],
  text: [],
};

export type FeedbackRef =
  | { bus: "rbus"; module: number; input: number }
  | { bus: "loconet"; feedbackAddress: number }
  | { bus: "can"; nid: number; port: number };

export interface SignalAspect { name: string; value: number }

export interface Tile {
  id: string;
  x: number;
  y: number;
  kind: TileKind;
  /** 0..7, steps of 45° clockwise */
  rot: number;
  label?: string;
  /** turnout address (1-based, as shown in the UI); for signals the turnout or DCCext address */
  address?: number;
  /** second address of three-way turnouts and double slips */
  address2?: number;
  invert?: boolean;
  invert2?: boolean;
  /** signals only: "turnout" = two aspects on a turnout address, "ext" = aspect values of a DCCext signal decoder */
  signalMode?: "turnout" | "ext";
  aspects?: SignalAspect[];
  /** occupancy detector for this piece of track */
  feedback?: FeedbackRef;
}

export interface RouteStep { tileId: string; state: number }
export interface Route { id: string; name: string; steps: RouteStep[] }
export interface Layout { cols: number; rows: number; tiles: Tile[]; routes: Route[] }

export const EMPTY_LAYOUT: Layout = { cols: 24, rows: 12, tiles: [], routes: [] };

/** The part of the station state the diagram needs; both the server's and the browser's state type satisfy it. */
export interface LayoutLiveState {
  turnouts: Record<number, string>;
  extAccessories: Record<number, number>;
  rmbus: { module: number; inputs: boolean[] }[];
  loconetDetectors: { feedbackAddress: number; occupied: boolean }[];
  canDetectors: { nid: number; ports: { port: number; occupied: boolean }[] }[];
}

export type LayoutCommand = { type: "turnout"; address: number; output: 0 | 1 } | { type: "ext"; address: number; value: number };

const DEFAULT_ASPECTS: SignalAspect[] = [{ name: "Halt", value: 0 }, { name: "Fahrt", value: 16 }];

export const isSwitchable = (t: Tile) => ["turnoutLeft", "turnoutRight", "threeWay", "doubleSlip", "signal"].includes(t.kind);
export const hasTrack = (t: Tile) => BASE_PATHS[t.kind].length > 0;
export const needsSecondAddress = (t: Tile) => t.kind === "threeWay" || t.kind === "doubleSlip";

export function tilePaths(t: Pick<Tile, "kind" | "rot">): [Dir, Dir][] {
  const r = (d: Dir) => (d === CENTER ? CENTER : (d + t.rot) % 8);
  return BASE_PATHS[t.kind].map(([a, b]) => [r(a), r(b)]);
}

export function signalAspects(t: Tile): SignalAspect[] {
  if (t.signalMode === "ext") return t.aspects?.length ? t.aspects : DEFAULT_ASPECTS;
  return [{ name: "Halt", value: 0 }, { name: "Fahrt", value: 1 }];
}

/** How many positions a tile can be switched to (0 = not switchable). */
export function stateCount(t: Tile): number {
  switch (t.kind) {
    case "turnoutLeft": case "turnoutRight": return 2;
    case "threeWay": return 3;
    case "doubleSlip": return 4;
    case "signal": return signalAspects(t).length;
    default: return 0;
  }
}

export function stateName(t: Tile, state: number): string {
  switch (t.kind) {
    case "turnoutLeft": case "turnoutRight": return ["gerade", "abzweigend"][state] ?? "?";
    case "threeWay": return ["gerade", "links", "rechts"][state] ?? "?";
    case "doubleSlip": return ["gerade 1", "Bogen 1", "Bogen 2", "gerade 2"][state] ?? "?";
    case "signal": return signalAspects(t)[state]?.name ?? "?";
    default: return "";
  }
}

/** Indices into tilePaths() that are "set" in the given state; all paths for tiles without positions. */
export function activePaths(t: Tile, state: number | undefined): number[] {
  if (stateCount(t) === 0 || t.kind === "signal") return BASE_PATHS[t.kind].map((_, i) => i);
  if (state === undefined) return [];
  return [state]; // path order in BASE_PATHS matches the state numbering
}

/** 0/1 from the reported turnout position, honouring "invert"; undefined while unknown. */
function bit(live: LayoutLiveState, address: number | undefined, invert: boolean | undefined): 0 | 1 | undefined {
  const p = address === undefined ? undefined : live.turnouts[address];
  if (p !== "p0" && p !== "p1") return undefined;
  return ((p === "p1" ? 1 : 0) ^ (invert ? 1 : 0)) as 0 | 1;
}

/** Current position of a tile as reported by the command station; undefined = unknown or not linked. */
export function tileState(t: Tile, live: LayoutLiveState): number | undefined {
  const a = bit(live, t.address, t.invert);
  const b = bit(live, t.address2, t.invert2);
  switch (t.kind) {
    case "turnoutLeft": case "turnoutRight": return a;
    case "threeWay": return a === undefined || b === undefined ? undefined : a ? 1 : b ? 2 : 0;
    case "doubleSlip": return a === undefined || b === undefined ? undefined : a + 2 * b;
    case "signal": {
      if (t.signalMode !== "ext") return a;
      const v = t.address === undefined ? undefined : live.extAccessories[t.address];
      const i = v === undefined ? -1 : signalAspects(t).findIndex((x) => x.value === v);
      return i < 0 ? undefined : i;
    }
    default: return undefined;
  }
}

/** Commands that bring a tile into the given position. Empty if the tile is not linked. */
export function tileCommands(t: Tile, state: number): LayoutCommand[] {
  if (!Number.isInteger(state) || state < 0 || state >= stateCount(t)) throw new RangeError(`state ${state} not valid for ${t.kind}`);
  const turnout = (address: number | undefined, value: number, invert?: boolean): LayoutCommand[] =>
    address === undefined ? [] : [{ type: "turnout", address, output: ((value ? 1 : 0) ^ (invert ? 1 : 0)) as 0 | 1 }];
  switch (t.kind) {
    case "turnoutLeft": case "turnoutRight": return turnout(t.address, state, t.invert);
    case "threeWay": return [...turnout(t.address, state === 1 ? 1 : 0, t.invert), ...turnout(t.address2, state === 2 ? 1 : 0, t.invert2)];
    case "doubleSlip": return [...turnout(t.address, state & 1, t.invert), ...turnout(t.address2, state >> 1, t.invert2)];
    case "signal":
      if (t.signalMode !== "ext") return turnout(t.address, state, t.invert);
      return t.address === undefined ? [] : [{ type: "ext", address: t.address, value: signalAspects(t)[state]!.value }];
    default: return [];
  }
}

/** true/false from the linked detector, undefined if none is linked or it has not reported yet. */
export function tileOccupied(t: Tile, live: LayoutLiveState): boolean | undefined {
  const f = t.feedback;
  if (!f) return undefined;
  if (f.bus === "rbus") return live.rmbus.find((m) => m.module === f.module)?.inputs[f.input - 1];
  if (f.bus === "loconet") return live.loconetDetectors.find((d) => d.feedbackAddress === f.feedbackAddress)?.occupied;
  return live.canDetectors.find((d) => d.nid === f.nid)?.ports.find((p) => p.port === f.port)?.occupied;
}

export function routeCommands(layout: Layout, route: Route): LayoutCommand[] {
  const byId = new Map(layout.tiles.map((t) => [t.id, t]));
  return route.steps.flatMap((s) => { const t = byId.get(s.tileId); return t ? tileCommands(t, s.state) : []; });
}

/** A route counts as set when every step's tile reports the wanted position. */
export function routeIsSet(layout: Layout, route: Route, live: LayoutLiveState): boolean {
  const byId = new Map(layout.tiles.map((t) => [t.id, t]));
  return route.steps.length > 0 && route.steps.every((s) => { const t = byId.get(s.tileId); return !!t && tileState(t, live) === s.state; });
}

/** All turnout addresses the diagram uses (to ask the station for their positions). */
export function turnoutAddresses(layout: Layout): number[] {
  const out = new Set<number>();
  for (const t of layout.tiles) {
    if (!isSwitchable(t) || (t.kind === "signal" && t.signalMode === "ext")) continue;
    if (t.address !== undefined) out.add(t.address);
    if (needsSecondAddress(t) && t.address2 !== undefined) out.add(t.address2);
  }
  return [...out].sort((a, b) => a - b);
}

export function feedbackBuses(layout: Layout): Set<FeedbackRef["bus"]> {
  return new Set(layout.tiles.flatMap((t) => (t.feedback ? [t.feedback.bus] : [])));
}

/* ---------- validation ---------- */

const fail = (msg: string): never => { throw new Error(msg); };
const int = (v: unknown, min: number, max: number, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${what} muss zwischen ${min} und ${max} liegen`);
  return v as number;
};
const optInt = (v: unknown, min: number, max: number, what: string) => (v === undefined || v === null || v === "" ? undefined : int(v, min, max, what));
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ID = /^[A-Za-z0-9_-]{1,24}$/;

function cleanFeedback(v: unknown, where: string): FeedbackRef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const f = v as Record<string, unknown>;
  if (f.bus === "rbus") return { bus: "rbus", module: int(f.module, 1, 20, `${where}: R-BUS-Modul`), input: int(f.input, 1, 8, `${where}: R-BUS-Eingang`) };
  if (f.bus === "loconet") return { bus: "loconet", feedbackAddress: int(f.feedbackAddress, 0, 65535, `${where}: LocoNet-Melderadresse`) };
  if (f.bus === "can") return { bus: "can", nid: int(f.nid, 0, 65535, `${where}: CAN-Netzwerk-ID`), port: int(f.port, 0, 15, `${where}: CAN-Port`) };
  return fail(`${where}: unbekannter Meldertyp`);
}

/** Checks and normalises anything that claims to be a layout; throws an Error with a readable message. */
export function validateLayout(input: unknown): Layout {
  if (!input || typeof input !== "object") fail("Gleisbild fehlt");
  const src = input as Record<string, unknown>;
  const cols = int(src.cols, 4, 80, "Spaltenzahl");
  const rows = int(src.rows, 4, 50, "Zeilenzahl");
  const rawTiles = Array.isArray(src.tiles) ? src.tiles : fail("tiles fehlt");
  if (rawTiles.length > 2000) fail("Zu viele Felder");
  const ids = new Set<string>();
  const cells = new Set<string>();
  const tiles: Tile[] = rawTiles.map((raw: unknown, i: number) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const where = `Feld ${i + 1}`;
    const id = typeof r.id === "string" && ID.test(r.id) ? r.id : fail(`${where}: ungültige ID`);
    if (ids.has(id)) fail(`${where}: ID ${id} doppelt`);
    ids.add(id);
    const kind = TILE_KINDS.includes(r.kind as TileKind) ? (r.kind as TileKind) : fail(`${where}: unbekannte Art`);
    const x = int(r.x, 0, cols - 1, `${where}: Spalte`);
    const y = int(r.y, 0, rows - 1, `${where}: Zeile`);
    if (cells.has(`${x},${y}`)) fail(`${where}: Feld ${x + 1}/${y + 1} ist doppelt belegt`);
    cells.add(`${x},${y}`);
    const t: Tile = { id, x, y, kind, rot: int(r.rot ?? 0, 0, 7, `${where}: Drehung`) };
    const label = text(r.label, 40);
    if (label) t.label = label;
    if (isSwitchable(t)) {
      const ext = kind === "signal" && r.signalMode === "ext";
      t.address = optInt(r.address, 1, ext ? 2044 : 16384, `${where}: Adresse`);
      if (r.invert) t.invert = true;
      if (needsSecondAddress(t)) {
        t.address2 = optInt(r.address2, 1, 16384, `${where}: zweite Adresse`);
        if (r.invert2) t.invert2 = true;
      }
      if (kind === "signal") {
        t.signalMode = ext ? "ext" : "turnout";
        if (ext && Array.isArray(r.aspects)) {
          t.aspects = r.aspects.slice(0, 16).map((a: unknown, n: number) => {
            const o = (a ?? {}) as Record<string, unknown>;
            return { name: text(o.name, 20) || `Begriff ${n + 1}`, value: int(o.value, 0, 255, `${where}: Signalbild-Wert`) };
          });
          if (t.aspects.length < 2) delete t.aspects;
        }
      }
    }
    if (hasTrack(t)) {
      const fb = cleanFeedback(r.feedback, where);
      if (fb) t.feedback = fb;
    }
    return t;
  });
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const rawRoutes = Array.isArray(src.routes) ? src.routes : [];
  if (rawRoutes.length > 200) fail("Zu viele Fahrstraßen");
  const routeIds = new Set<string>();
  const routes: Route[] = rawRoutes.map((raw: unknown, i: number) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const where = `Fahrstraße ${i + 1}`;
    const id = typeof r.id === "string" && ID.test(r.id) ? r.id : fail(`${where}: ungültige ID`);
    if (routeIds.has(id)) fail(`${where}: ID doppelt`);
    routeIds.add(id);
    const seen = new Set<string>();
    const steps = (Array.isArray(r.steps) ? r.steps : []).slice(0, 200).map((s: unknown) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const tile = byId.get(String(o.tileId)) ?? fail(`${where}: verweist auf ein Feld, das es nicht gibt`);
      if (seen.has(tile.id)) fail(`${where}: Feld mehrfach enthalten`);
      seen.add(tile.id);
      return { tileId: tile.id, state: int(o.state, 0, Math.max(0, stateCount(tile) - 1), `${where}: Stellung`) };
    });
    return { id, name: text(r.name, 40) || `Fahrstraße ${i + 1}`, steps };
  });
  return { cols, rows, tiles, routes };
}
