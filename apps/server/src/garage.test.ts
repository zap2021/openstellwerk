import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Z21Simulator } from "@z21/simulator";
import { Garage } from "./garage.js";
import { Station } from "./station.js";

const dir = mkdtempSync(path.join(tmpdir(), "garage-"));
const file = path.join(dir, "garage.json");
const sim = new Z21Simulator();
const station = new Station(new Garage(file));

beforeAll(async () => { await sim.listen(21556, "127.0.0.1"); await station.connect("127.0.0.1", 21556); });
afterAll(() => { station.client.disconnect(); sim.close(); rmSync(dir, { recursive: true, force: true }); });

const until = async (cond: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

it("scan finds locos that are in use and adds them to the garage", async () => {
  station.drive(7, 40, true);
  station.setFunction(12, 0, "on");
  await until(() => station.snapshot().locos.some((l) => l.address === 12 && l.functions[0]));
  station.startScan(5, 14);
  await until(() => station.snapshot().scan?.running === false);
  const scan = station.snapshot().scan!;
  expect(scan.found).toEqual(expect.arrayContaining([7, 12]));
  expect(station.snapshot().garage.map((g) => g.address)).toEqual(expect.arrayContaining([7, 12]));
});

it("rejects oversized or reversed ranges", () => {
  expect(() => station.startScan(10, 5)).toThrow();
  expect(() => station.startScan(1, 900)).toThrow();
});

it("stores names and function labels, and persists them", async () => {
  station.setGarageEntry(7, { name: "BR 218", functionNames: { 0: "Licht", 2: "Horn", 5: "" } });
  expect(station.snapshot().garage.find((g) => g.address === 7)).toMatchObject({ name: "BR 218", functionNames: { 0: "Licht", 2: "Horn" } });
  await new Promise((r) => setTimeout(r, 450));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.find((g: { address: number }) => g.address === 7).name).toBe("BR 218");
  expect(new Garage(file).get(7)?.name).toBe("BR 218");
});

it("reads the loco address from the programming track", async () => {
  station.setPower(true);
  const r = await station.readProgrammedAddress();
  expect(r.address).toBeGreaterThanOrEqual(1);
  expect(station.snapshot().garage.some((g) => g.address === r.address && g.sources.includes("prog"))).toBe(true);
});

it("removes entries", () => {
  expect(station.removeGarageEntry(7)).toBe(true);
  expect(station.snapshot().garage.some((g) => g.address === 7)).toBe(false);
});

it("keeps locos that were reported once, even after the signal goes quiet", async () => {
  station.pollRailCom(0);
  station.drive(2222, 25, true);
  await until(() => station.snapshot().garage.some((g) => g.address === 2222 && g.sources.includes("active")));
  station.drive(2222, 0, true); // loco stops and becomes idle again
  await new Promise((r) => setTimeout(r, 200));
  expect(station.snapshot().garage.some((g) => g.address === 2222)).toBe(true);
});
