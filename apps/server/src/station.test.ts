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
  expect(station.snapshot().hw).toMatchObject({ hwName: "Z21 XL", fwVersion: "1.43", kind: "z21" });
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

it("only delivers RailCom data after the monitor is enabled", async () => {
  station.setPower(true);
  station.drive(77, 40, true);
  await until(() => station.snapshot().locos.some((l) => l.address === 77));
  expect(station.snapshot().railcom).toHaveLength(0);
  station.setMonitors({ railcom: true });
  station.pollRailCom(77);
  await until(() => station.snapshot().railcom.some((r) => r.address === 77));
  const r = station.snapshot().railcom.find((x) => x.address === 77)!;
  expect(r.speed).toBe(40);
  expect(r.qos).toBe(90);
});

it("logs LocoNet traffic with decoded opcodes and sends raw messages", async () => {
  const lines: { text: string; opcode: string; ok: boolean }[] = [];
  station.on("loconet", (l) => lines.push({ text: l.decoded.text, opcode: l.decoded.opcode, ok: l.decoded.checksumOk }));
  station.setMonitors({ loconet: true });
  station.setPower(false);
  await until(() => lines.some((l) => l.opcode === "OPC_GPOFF"));
  station.setTurnout(12, 1);
  await until(() => lines.some((l) => l.opcode === "OPC_SW_REQ" && l.text.startsWith("turnout 12 ")));
  expect(lines.every((l) => l.ok)).toBe(true);
  expect(() => station.sendLocoNet([0x10])).toThrow();
  expect(() => station.sendLocoNet([0x83, 0x90])).toThrow();
});

it("tracks LocoNet and CAN detectors, including polling", async () => {
  sim.setLocoNetOccupancy(5, true, 1000);
  sim.setCanOccupancy(0xd001, 2, true, [{ address: 3 }, { address: 1000, backward: true }, { address: 12 }]);
  station.setMonitors({ detectors: true });
  station.pollLocoNetDetectors("Sic");
  station.pollCanDetectors();
  await until(() => station.snapshot().loconetDetectors.some((d) => d.feedbackAddress === 5 && d.occupied && d.locoAddress === 1000));
  await until(() => !!station.snapshot().canDetectors[0]?.ports.find((p) => p.port === 2)?.locos.length);
  const port = station.snapshot().canDetectors[0]!.ports.find((p) => p.port === 2)!;
  expect(port.occupied).toBe(true);
  expect(port.locos).toEqual([
    { address: 3, direction: "forward" }, { address: 1000, direction: "backward" }, { address: 12, direction: "forward" },
  ]);
});
