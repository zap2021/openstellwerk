import { describe, expect, it } from "vitest";
import { fitSize, imageUrl } from "./loco-image";

describe("fitSize", () => {
  it("scales the longest side down to the maximum and keeps the aspect ratio", () => {
    expect(fitSize(4000, 3000)).toEqual({ width: 256, height: 192 });
    expect(fitSize(3000, 4000)).toEqual({ width: 192, height: 256 });
    expect(fitSize(1000, 1000)).toEqual({ width: 256, height: 256 });
  });
  it("never enlarges a picture that is already small", () => {
    expect(fitSize(100, 80)).toEqual({ width: 100, height: 80 });
    expect(fitSize(256, 256)).toEqual({ width: 256, height: 256 });
  });
  it("never produces a side smaller than one pixel, even for extreme ratios", () => {
    expect(fitSize(10000, 5)).toEqual({ width: 256, height: 1 });
    expect(fitSize(5, 10000)).toEqual({ width: 1, height: 256 });
  });
  it("honours another maximum and refuses sizes that are not positive numbers", () => {
    expect(fitSize(800, 400, 100)).toEqual({ width: 100, height: 50 });
    for (const [w, h] of [[0, 10], [10, 0], [-1, 5], [Number.NaN, 5], [5, Number.POSITIVE_INFINITY]]) expect(() => fitSize(w!, h!)).toThrow(RangeError);
  });
});

describe("imageUrl", () => {
  it("carries the version so a new picture is not served from the cache", () => {
    expect(imageUrl(77, 1794430934172)).toBe("/api/garage/77/image?v=1794430934172");
  });
});
