import { describe, expect, it } from "vitest";
import { blank, toMs } from "./automations";

describe("toMs", () => {
  it("converts seconds to ms and ignores empty or invalid input", () => {
    expect(toMs("2")).toBe(2000);
    expect(toMs("0,5")).toBe(500);
    expect(toMs("")).toBeUndefined();
    expect(toMs("0")).toBeUndefined();
    expect(toMs("abc")).toBeUndefined();
    expect(toMs("999")).toBe(60000);
  });
});
describe("blank", () => {
  it("has one action and a trigger", () => {
    const a = blank();
    expect(a.actions).toHaveLength(1);
    expect(a.trigger.type).toBe("start");
  });
});
