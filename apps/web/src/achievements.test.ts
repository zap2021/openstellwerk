import { describe, expect, it } from "vitest";
import { nextAnnouncement } from "./achievements";

const latest = { id: "x", title: "T", text: "t", points: 5 };
describe("nextAnnouncement", () => {
  it("does not announce what was already there at the first look", () => {
    expect(nextAnnouncement(undefined, { seq: 3, latest })).toEqual({ seen: 3 });
    expect(nextAnnouncement(undefined, undefined)).toEqual({ seen: undefined });
  });
  it("announces a new unlock once", () => {
    expect(nextAnnouncement(3, { seq: 4, latest })).toEqual({ seen: 4, show: latest });
    expect(nextAnnouncement(4, { seq: 4, latest })).toEqual({ seen: 4 });
  });
  it("stays quiet after a reset and announces again afterwards", () => {
    expect(nextAnnouncement(4, { seq: 0 })).toEqual({ seen: 0 });
    expect(nextAnnouncement(0, { seq: 1, latest })).toEqual({ seen: 1, show: latest });
  });
});
