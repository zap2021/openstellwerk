import { describe, expect, it } from "vitest";
import { samePlace } from "./timetable";

describe("samePlace", () => {
  it("erkennt gleiche und enthaltene Namen", () => {
    expect(samePlace("Strecke Ost", "Strecke Ost")).toBe(true);
    expect(samePlace("Bahnhof Gleis 1", "Gleis 1")).toBe(true);
    expect(samePlace("Bergstadt", "")).toBe(true);
  });
  it("zeigt verschiedene Orte getrennt", () => {
    expect(samePlace("Bergstadt", "Gleis 2")).toBe(false);
  });
});
