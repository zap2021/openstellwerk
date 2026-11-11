import { describe, expect, it } from "vitest";
import type { Train, Trip } from "@z21/timetable";
import type { Route } from "@z21/protocol/layout";
import { tripRows } from "./timetable";

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
