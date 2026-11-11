import { describe, expect, it } from "vitest";
import { formatHHMM, parseHHMM, statusText } from "./format.js";

describe("format", () => {
  it("formatHHMM", () => {
    expect(formatHHMM(425)).toBe("07:05");
  });
  it("parseHHMM", () => {
    expect(parseHHMM("07:05")).toBe(425);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM("24:00")).toBeUndefined();
    expect(parseHHMM("7:5")).toBeUndefined();
    expect(parseHHMM("")).toBeUndefined();
    expect(parseHHMM("12:60")).toBeUndefined();
  });
  it("statusText", () => {
    expect(statusText("planned")).toBe("planmäßig");
    expect(statusText("done")).toBe("beendet");
    const t = statusText("waiting", "Block „Gleis 2“ ist besetzt");
    expect(t).toContain("Verspätung");
    expect(t).toContain("Block „Gleis 2“ ist besetzt");
  });
});
