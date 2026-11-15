import { describe, expect, it } from "vitest";
import { setting } from "./env.js";

describe("setting", () => {
  it("prefers the new prefix and falls back to the old one", () => {
    expect(setting("PASSWORD", { OPENSTELLWERK_PASSWORD: "neu", Z21_PASSWORD: "alt" })).toBe("neu");
    expect(setting("PASSWORD", { Z21_PASSWORD: "alt" })).toBe("alt");
    expect(setting("PASSWORD", {})).toBeUndefined();
  });
});
