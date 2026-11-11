import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "./route";

describe("route", () => {
  it("reads the area and page from the hash", () => {
    expect(parseRoute("")).toEqual({ area: "operate" });
    expect(parseRoute("#/")).toEqual({ area: "operate" });
    expect(parseRoute("#/irgendwas")).toEqual({ area: "operate" });
    expect(parseRoute("#/verwaltung")).toEqual({ area: "admin" });
    expect(parseRoute("#/verwaltung/cv")).toEqual({ area: "admin", page: "cv" });
    expect(parseRoute("#/anzeige")).toEqual({ area: "display" });
  });
  it("round-trips", () => {
    for (const h of ["#/", "#/verwaltung", "#/verwaltung/backup", "#/anzeige"]) expect(routeHash(parseRoute(h))).toBe(h);
  });
});
