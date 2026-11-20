import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionMemory } from "./connection-memory.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "conn-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ConnectionMemory", () => {
  it("merkt sich die Zentrale über einen Neustart", () => {
    const file = path.join(dir, "connection.json");
    const a = new ConnectionMemory(file);
    expect(a.get()).toBeUndefined();
    a.remember("192.168.178.196");
    const b = new ConnectionMemory(file); // wie nach einem Neustart
    expect(b.get()).toEqual({ host: "192.168.178.196" });
  });

  it("speichert auch einen Port und überschreibt die alte Adresse", () => {
    const file = path.join(dir, "connection.json");
    const m = new ConnectionMemory(file);
    m.remember("10.0.0.5", 21105);
    m.remember("10.0.0.6");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ host: "10.0.0.6" });
    expect(new ConnectionMemory(file).get()).toEqual({ host: "10.0.0.6" });
  });

  it("ignoriert ungültige Angaben und eine beschädigte Datei", () => {
    const file = path.join(dir, "connection.json");
    const m = new ConnectionMemory(file);
    m.remember("");
    m.remember(42 as unknown as string);
    m.remember("host", 99999);
    expect(m.get()).toEqual({ host: "host" }); // ungültiger Port entfällt, Host gilt
    writeFileSync(file, "{kaputt");
    expect(new ConnectionMemory(file).get()).toBeUndefined();
  });

  it("läuft ohne Datei (Datenordner nicht vorhanden)", () => {
    const m = new ConnectionMemory(undefined);
    m.remember("1.2.3.4");
    expect(m.get()).toEqual({ host: "1.2.3.4" });
  });
});
