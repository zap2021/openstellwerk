import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { JsonFile } from "./json-file.js";

const dir = mkdtempSync(path.join(tmpdir(), "json-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("JsonFile.flushPending", () => {
  it("writes waiting files now", () => {
    const f = new JsonFile<{ a: number }>(path.join(dir, "ok.json"), { delayMs: 60_000 });
    f.write(() => ({ a: 1 }));
    JsonFile.flushPending();
    expect(JSON.parse(readFileSync(path.join(dir, "ok.json"), "utf8"))).toEqual({ a: 1 });
    JsonFile.flushPending(); // nothing waiting any more: no error, no second write
  });

  it("reports a file that cannot be written instead of staying silent", () => {
    writeFileSync(path.join(dir, "blocker"), "x"); // a file where the directory should be
    const f = new JsonFile<number>(path.join(dir, "blocker", "x.json"), { delayMs: 60_000 });
    f.write(() => 1);
    expect(() => JsonFile.flushPending()).toThrow(/Nicht gespeichert: x\.json/);
    rmSync(path.join(dir, "blocker"));
    JsonFile.flushPending(); // the write stayed scheduled and now succeeds
    expect(JSON.parse(readFileSync(path.join(dir, "blocker", "x.json"), "utf8"))).toBe(1);
  });

  it("still logs a failing delayed write instead of throwing out of the timer", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    writeFileSync(path.join(dir, "blocker2"), "x");
    new JsonFile<number>(path.join(dir, "blocker2", "y.json"), { delayMs: 10 }).write(() => 1);
    vi.advanceTimersByTime(20);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not save y.json"), expect.any(String));
    log.mockRestore();
    vi.useRealTimers();
    rmSync(path.join(dir, "blocker2"));
    JsonFile.flushPending(); // clean up the waiting set for the following tests
  });
});
