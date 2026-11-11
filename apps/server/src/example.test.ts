import { readFileSync } from "node:fs";
import { validateLayout } from "@z21/protocol";
import { validateSettings, validateTrains, validateTrips } from "@z21/timetable";
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
