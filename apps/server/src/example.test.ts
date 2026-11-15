import { readFileSync } from "node:fs";
import { tilePaths, validateLayout, type Layout } from "@openstellwerk/protocol";
import { validateSettings, validateTrains, validateTrips } from "@openstellwerk/timetable";
import { expect, it } from "vitest";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../docs/${name}`, import.meta.url), "utf8"));

it("docs/beispiel-fahrplan.json fits docs/beispiel-gleisbild.json", () => {
  const layout = validateLayout(read("beispiel-gleisbild.json"));
  const file = read("beispiel-fahrplan.json");
  const blockIds = new Set((layout.blocks ?? []).map((b) => b.id));
  const routeIds = new Set(layout.routes.map((r) => r.id));
  const trains = validateTrains(file.trains, { blockIds });
  const trips = validateTrips(file.trips, { trainIds: new Set(trains.map((t) => t.id)), routeIds });
  expect(validateSettings(file.settings)).toEqual({ lateLimit: 5 });
  expect(trains).toHaveLength(2);
  expect(trips.map((t) => t.routeId)).toEqual(["r1", "r2", "r3", "r4"]);
  expect(trains.every((t) => t.location?.blockId === "zufahrt")).toBe(true);
});

/** Neighbour offsets for the edge points 0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE. */
const STEP = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;

/** Every track end must meet a track end of the neighbouring tile (buffer stops end in the tile centre). */
function looseEnds(layout: Layout): string[] {
  const at = new Map(layout.tiles.map((t) => [`${t.x},${t.y}`, t]));
  const out: string[] = [];
  for (const t of layout.tiles) {
    for (const dir of new Set(tilePaths(t).flat())) {
      if (dir < 0) continue;
      const other = at.get(`${t.x + STEP[dir]![0]},${t.y + STEP[dir]![1]}`);
      if (!other || !tilePaths(other).flat().includes((dir + 4) % 8)) out.push(`${t.id}:${dir}`);
    }
  }
  return out;
}

it("docs/beispiel-rundkurs.json is a closed loop and its timetable fits", () => {
  const layout = validateLayout(read("beispiel-rundkurs.json"));
  expect(looseEnds(layout)).toEqual([]); // a loop has no open track end
  const blockIds = new Set((layout.blocks ?? []).map((b) => b.id));
  expect([...blockIds]).toEqual(["g1", "g2", "west", "nord", "ost"]);
  // every block can be left and reached: the routes form a circle through the station
  for (const b of blockIds) {
    expect(layout.routes.some((r) => r.from === b)).toBe(true);
    expect(layout.routes.some((r) => r.to === b)).toBe(true);
  }
  const file = read("beispiel-rundkurs-fahrplan.json");
  const trains = validateTrains(file.trains, { blockIds });
  const trips = validateTrips(file.trips, { trainIds: new Set(trains.map((t) => t.id)), routeIds: new Set(layout.routes.map((r) => r.id)) });
  expect(trains.map((t) => t.location?.blockId)).toEqual(["g1", "g2"]);
  expect(trips).toHaveLength(8);
  expect(trips.every((t) => t.drive === "forward")).toBe(true);
  // each trip starts where the train's previous trip ended
  for (const train of trains) {
    const own = trips.filter((t) => t.trainId === train.id).sort((a, b) => a.departure - b.departure);
    let at = train.location!.blockId;
    for (const t of own) {
      const route = layout.routes.find((r) => r.id === t.routeId)!;
      expect(route.from).toBe(at);
      at = route.to!;
    }
    expect(at).toBe(train.location!.blockId); // one full lap
  }
});

it("the station example has exactly one open end: the line that leaves to the east", () => {
  expect(looseEnds(validateLayout(read("beispiel-gleisbild.json")))).toEqual(["b4:0"]);
});
