import { describe, expect, it } from "vitest";
import { departures, validateSettings, validateTrains, validateTrips } from "./validate.js";

describe("validateTrains", () => {
  it("normalises", () => {
    expect(validateTrains([{ id: "t1", name: "  ICE  ", number: " 12 ", address: 3, junk: 1 }])).toEqual([{ id: "t1", name: "ICE", number: "12", address: 3 }]);
  });
  it("rejects duplicate address", () => {
    expect(() => validateTrains([{ id: "a", name: "A", address: 3 }, { id: "b", name: "B", address: 3 }])).toThrow(/Lokadresse 3/);
  });
  it("rejects duplicate ids", () => {
    expect(() => validateTrains([{ id: "a", name: "A", address: 3 }, { id: "a", name: "B", address: 4 }])).toThrow();
  });
  it("drops locations in unknown blocks only with ctx", () => {
    const t = [{ id: "a", name: "A", address: 3, location: { blockId: "x", source: "manual", since: 5 } }];
    expect(validateTrains(t)[0].location).toEqual({ blockId: "x", source: "manual", since: 5 });
    expect(validateTrains(t, { blockIds: new Set(["y"]) })[0].location).toBeUndefined();
    expect(validateTrains(t, { blockIds: new Set(["x"]) })[0].location?.blockId).toBe("x");
  });
});

describe("departures", () => {
  it("expands inclusive", () => expect(departures({ departure: 600, repeat: { every: 20, until: 660 } })).toEqual([600, 620, 640, 660]));
  it("every larger than rest", () => expect(departures({ departure: 600, repeat: { every: 100, until: 660 } })).toEqual([600]));
  it("no repeat", () => expect(departures({ departure: 600 })).toEqual([600]));
});

describe("validateTrips", () => {
  const ok = { id: "f1", trainId: "t", routeId: "r", departure: 600, destination: " Hbf " };
  it("normalises", () => {
    expect(validateTrips([ok])).toEqual([{ id: "f1", trainId: "t", routeId: "r", departure: 600, dwell: 0, destination: "Hbf" }]);
  });
  it("rejects until < departure", () => {
    expect(() => validateTrips([{ ...ok, repeat: { every: 10, until: 500 } }])).toThrow();
  });
  it("rejects over 200 departures", () => {
    expect(() => validateTrips([{ ...ok, departure: 0, repeat: { every: 1, until: 1439 } }])).toThrow(/höchstens 200 Abfahrten/);
  });
  it("rejects ranges", () => {
    expect(() => validateTrips([{ ...ok, dwell: 121 }])).toThrow();
    expect(() => validateTrips([{ ...ok, departure: 1440 }])).toThrow();
  });
  it("requires id", () => {
    const { id: _id, ...noId } = ok;
    expect(() => validateTrips([noId])).toThrow();
  });
  it("checks references with ctx", () => {
    expect(validateTrips([ok])).toHaveLength(1);
    expect(() => validateTrips([ok], { trainIds: new Set(["t"]), routeIds: new Set() })).toThrow(/Fahrt 1: Fahrstraße nicht gefunden/);
    expect(() => validateTrips([ok], { trainIds: new Set(), routeIds: new Set(["r"]) })).toThrow(/Fahrt 1: Zug nicht gefunden/);
  });
});

describe("validateSettings", () => {
  it("validates", () => {
    expect(() => validateSettings({ lateLimit: 0 })).toThrow();
    expect(validateSettings({})).toEqual({ lateLimit: 5 });
    expect(validateSettings({ lateLimit: 10 })).toEqual({ lateLimit: 10 });
  });
});
