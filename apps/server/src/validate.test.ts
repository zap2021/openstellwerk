import { describe, expect, it } from "vitest";
import { bool } from "./validate.js";

describe("bool", () => {
  it("accepts only real booleans", () => {
    expect(bool(true, "Leistung")).toBe(true);
    expect(bool(false, "Leistung")).toBe(false);
  });
  it.each(["false", "true", "", 0, 1, null, undefined, {}])("rejects %j with status 400", (v) => {
    let err: (Error & { statusCode?: number }) | undefined;
    try { bool(v, "Leistung"); } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/Leistung: true oder false erwartet/);
    expect(err?.statusCode).toBe(400);
  });
});
