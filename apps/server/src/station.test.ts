import { afterAll, beforeAll, expect, it } from "vitest";
import { Z21Simulator } from "@z21/simulator";
import { Station } from "./station.js";

const sim = new Z21Simulator();
const station = new Station();

beforeAll(() => sim.listen(21555, "127.0.0.1"));
afterAll(() => { station.client.disconnect(); sim.close(); });

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

it("connects and reads hardware info", async () => {
  await station.connect("127.0.0.1", 21555);
  await until(() => !!station.snapshot().hw);
  expect(station.snapshot().hw).toEqual({ hwName: "Z21 XL", fwVersion: "1.43" });
});

it("switches track power and receives the broadcast", async () => {
  station.setPower(true);
  await until(() => station.snapshot().power === "on");
  station.emergencyStop();
  await until(() => station.snapshot().power === "emergencyStop");
});

it("drives a loco and tracks its state", async () => {
  station.drive(1000, 57, false);
  await until(() => station.snapshot().locos.some((l) => l.address === 1000 && l.speed === 57 && !l.forward));
  station.setFunction(1000, 2, "on");
  await until(() => !!station.snapshot().locos.find((l) => l.address === 1000)?.functions[2]);
});

it("reads and writes CVs on the programming track", async () => {
  station.setPower(true);
  expect(await station.readCv(29)).toBe(6);
  await station.writeCv(3, 12);
  expect(await station.readCv(3)).toBe(12);
});

it("switches turnouts (1-based addresses)", async () => {
  station.setTurnout(5, 1);
  await until(() => station.snapshot().turnouts[5] === "p1");
});
