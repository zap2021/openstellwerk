import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readVersion } from "./version.js";

it("reads the version of the project, and says so when there is none", () => {
  expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  const dir = mkdtempSync(path.join(tmpdir(), "openstellwerk-version-"));
  try {
    const file = path.join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ version: "1.2.3" }));
    expect(readVersion(file)).toBe("1.2.3");
    writeFileSync(file, "{}");
    expect(readVersion(file)).toBe("unbekannt");
    expect(readVersion(path.join(dir, "missing.json"))).toBe("unbekannt");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
