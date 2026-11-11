import { describe, expect, it } from "vitest";
import type { Instance, Status, Train, Trip } from "@z21/timetable";
import type { Layout, Route } from "@z21/protocol/layout";
import { boardRows, tripRows } from "./timetable";

const trains: Train[] = [{ id: "t1", name: "IC 1", address: 3 }];
const routes: Route[] = [{ id: "r1", name: "A nach B", steps: [], from: "a", to: "b" }];
const trip = (o: Partial<Trip> = {}): Trip => ({ id: "x", trainId: "t1", routeId: "r1", departure: 600, dwell: 2, ...o });

describe("tripRows", () => {
  it("formats the departure and resolves names", () => {
    expect(tripRows([trip()], trains, routes)).toEqual([
      { id: "x", time: "10:00", trainName: "IC 1", routeName: "A nach B", invalid: false },
    ]);
  });
  it("marks an unknown route or train as invalid", () => {
    expect(tripRows([trip({ routeId: "gone" })], trains, routes)[0]).toMatchObject({ invalid: true, routeName: "?" });
    expect(tripRows([trip({ trainId: "gone" })], trains, routes)[0]).toMatchObject({ invalid: true, trainName: "?" });
  });
  it("describes a repeat", () => {
    expect(tripRows([trip({ repeat: { every: 20, until: 1320 } })], trains, routes)[0].repeatText).toBe("alle 20 min bis 22:00");
  });
});

describe("boardRows", () => {
  const layout: Layout = { cols: 1, rows: 1, tiles: [], routes, blocks: [{ id: "b", name: "Gleis 2", tileIds: [] }] };
  const bTrains: Train[] = [{ id: "t1", name: "IC 1", number: "IC 101", address: 3 }, { id: "t2", name: "RE", address: 4 }];
  const trips: Trip[] = [trip({ id: "t1", trainId: "t1" }), trip({ id: "t2", trainId: "t2", destination: "Bergstadt" })];
  const inst = (id: string, tripId: string, due: number, status: Status = "planned"): Instance => ({ id, tripId, day: 0, due, status, since: 0 });

  it("sorts by due, limits, keeps the last 3 finished and lets open rows win", () => {
    const list = [
      inst("t1#9", "t1", 900, "planned"), inst("t1#0", "t1", 100, "done"), inst("t1#1", "t1", 200, "done"),
      inst("t1#2", "t1", 300, "failed"), inst("t1#3", "t1", 400, "cancelled"), inst("t1#4", "t1", 500, "planned"),
    ];
    const all = boardRows(list, trips, bTrains, layout, 10);
    expect(all.map((r) => r.id)).toEqual(["t1#1", "t1#2", "t1#3", "t1#4", "t1#9"]);
    expect(all).toHaveLength(5);
    expect(boardRows(list, trips, bTrains, layout, 2).map((r) => r.id)).toEqual(["t1#4", "t1#9"]);
    expect(boardRows(list, trips, bTrains, layout, 4).map((r) => r.id)).toEqual(["t1#2", "t1#3", "t1#4", "t1#9"]);
  });
  it("uses the target block as platform and as destination fallback", () => {
    const [a, b] = boardRows([inst("t1#0", "t1", 36000), inst("t2#0", "t2", 36060)], trips, bTrains, layout, 5);
    expect(a).toMatchObject({ platform: "Gleis 2", destination: "Gleis 2", number: "IC 101", time: "10:00" });
    expect(b).toMatchObject({ destination: "Bergstadt", number: "RE", trainId: "t2" });
  });
  it("labels waiting as Verspätung and carries the reason", () => {
    expect(boardRows([{ ...inst("t1#0", "t1", 0, "waiting"), reason: "Block belegt" }], trips, bTrains, layout, 5)[0]).toMatchObject({ label: "Verspätung", reason: "Block belegt" });
  });
  it("skips instances without trip or train", () => {
    const rows = boardRows([inst("x#0", "x", 0), inst("t1#0", "t1", 0)], trips, bTrains, layout, 5);
    expect(rows.map((r) => r.id)).toEqual(["t1#0"]);
    expect(boardRows([inst("t3#0", "t3", 0)], [trip({ id: "t3", trainId: "gone" })], bTrains, layout, 5)).toEqual([]);
  });
  it("shows each departure of a repeating trip", () => {
    const rep = [trip({ id: "t1", trainId: "t1", departure: 600, repeat: { every: 30, until: 1200 } })];
    expect(boardRows([inst("t1#2", "t1", (600 + 60) * 60)], rep, bTrains, layout, 5)[0].time).toBe("11:00");
  });
});
