import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { EventLog, registerHistoryRoutes } from "./history.js";

it("keeps the newest events first and only as many as allowed", () => {
  let t = 100;
  const log = new EventLog(undefined, 3, () => t++);
  log.add("verbindung", "Verbunden");
  log.add("fahrstrasse", "„Gleis 1“: aufgelöst");
  log.add("regel", "Halt: Signal → Halt", false);
  log.add("update", "x".repeat(400));
  expect(log.list().map((e) => e.kind)).toEqual(["update", "regel", "fahrstrasse"]);
  expect(log.list()[0]!.text).toHaveLength(300);
  expect(log.list()[1]).toEqual({ ts: 102, kind: "regel", text: "Halt: Signal → Halt", ok: false });
  expect(log.list(1)).toHaveLength(1);
  log.clear();
  expect(log.list()).toEqual([]);
});

it("reads a stored file and drops what is not an event", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "z21-history-"));
  try {
    const file = path.join(dir, "history.json");
    writeFileSync(file, JSON.stringify([{ ts: 1, kind: "system", text: "alt", ok: true }, { ts: 2, kind: "unsinn", text: "x" }, null, { ts: 3, kind: "update", text: "neu" }]));
    expect(new EventLog(file).list()).toEqual([{ ts: 3, kind: "update", text: "neu", ok: true }, { ts: 1, kind: "system", text: "alt", ok: true }]);
    writeFileSync(file, "{broken");
    expect(new EventLog(file).list()).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("serves and clears the history", async () => {
  const log = new EventLog();
  for (let i = 0; i < 5; i++) log.add("system", `Eintrag ${i}`);
  const app = Fastify();
  registerHistoryRoutes(app, log);
  expect((await app.inject({ method: "GET", url: "/api/history" })).json()).toHaveLength(5);
  expect((await app.inject({ method: "GET", url: "/api/history?limit=2" })).json().map((e: { text: string }) => e.text)).toEqual(["Eintrag 4", "Eintrag 3"]);
  expect((await app.inject({ method: "DELETE", url: "/api/history" })).statusCode).toBe(200);
  expect(log.list()).toEqual([]);
  await app.close();
});
