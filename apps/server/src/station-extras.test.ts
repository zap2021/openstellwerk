import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Z21Simulator } from "@z21/simulator";
import { Station } from "./station.js";

const until = async (cond: () => boolean, ms = 1500) => {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

describe("Z21 command station: settings, programming, R-BUS, clock, CAN boosters", () => {
  const sim = new Z21Simulator();
  const st = new Station();
  beforeAll(async () => { await sim.listen(21561, "127.0.0.1"); await st.connect("127.0.0.1", 21561); });
  afterAll(() => { st.client.disconnect(); sim.close(); });

  it("reads firmware version and unlock code on connect", async () => {
    await until(() => st.snapshot().firmwareVersion === "1.43" && st.snapshot().unlockCode === "none");
  });

  it("persists loco and turnout output formats (DCC/MM)", async () => {
    st.setLocoMode(12, "mm");
    expect(await st.readLocoMode(12)).toBe("mm");
    expect(await st.readLocoMode(300)).toBe("dcc"); // addresses >= 256 are always DCC
    st.setTurnoutMode(7, "mm");
    expect(await st.readTurnoutMode(7)).toBe("mm");
  });

  it("controls a loco with function groups, e-stop and purge", async () => {
    st.drive(25, 60, true);
    await until(() => st.snapshot().locos.some((l) => l.address === 25 && l.speed === 60));
    st.setFunctionGroup(25, 0x21, 0b0101); // F5, F7
    await until(() => { const l = st.snapshot().locos.find((l) => l.address === 25); return !!l?.functions[5] && !l.functions[6] && !!l.functions[7]; });
    st.locoEStop(25);
    await until(() => st.snapshot().locos.find((l) => l.address === 25)?.speed === 0);
    st.purgeLoco(25);
    expect(st.snapshot().locos.some((l) => l.address === 25)).toBe(false);
  });

  it("reads and writes DCCext accessories and signals", async () => {
    st.setExtAccessory(9, 16);
    await until(() => st.snapshot().extAccessories[9] === 16);
    expect(await st.getExtAccessory(9)).toEqual({ address: 9, value: 16, valid: true });
    expect(await st.getExtAccessory(10)).toMatchObject({ valid: false });
  });

  it("supports POM, register mode and MM programming", async () => {
    st.pomWrite(3, 29, 6);
    await new Promise((r) => setTimeout(r, 50));
    expect(await st.pomRead(3, 29)).toBe(6);
    st.pomWriteBit(3, 29, 0, true);
    await new Promise((r) => setTimeout(r, 50));
    expect(await st.pomRead(3, 29)).toBe(7);
    await expect(st.pomRead(4, 29)).rejects.toThrow(/acknowledge/);
    expect(await st.writeRegister(2, 33)).toBe(33);
    expect(await st.readRegister(2)).toBe(33);
    await st.mmWrite(1, 5);
  });

  it("delivers R-BUS feedback when subscribed", async () => {
    st.setMonitors({ rmbus: true });
    sim.extras.setRmBus(13, 8, true);
    sim.extras.setRmBus(13, 1, true);
    st.pollRmBus();
    await until(() => !!st.snapshot().rmbus.find((m) => m.module === 13)?.inputs[7]);
    const m13 = st.snapshot().rmbus.find((m) => m.module === 13)!;
    expect(m13.inputs.map((v, i) => (v ? i + 1 : 0)).filter(Boolean)).toEqual([1, 8]);
  });

  it("controls the fast clock", async () => {
    st.setMonitors({ clock: true });
    st.setClock(2, 18, 30, 8);
    await until(() => st.snapshot().clock?.time?.hour === 18);
    expect(st.snapshot().clock?.time).toMatchObject({ weekday: 2, hour: 18, minute: 30, rate: 8, stopped: false });
    st.stopClock();
    await until(() => st.snapshot().clock?.time?.stopped === true);
    st.startClock();
    await until(() => st.snapshot().clock?.time?.stopped === false);
    st.getClock();
    await until(() => !!st.snapshot().clock?.settings);
    st.setClockSettings(0x4f, 4, { weekday: 1, hour: 8, minute: 15 });
    await until(() => st.snapshot().clock?.settings?.rate === 4 && st.snapshot().clock?.settings?.startHour === 8);
  });

  it("manages CAN boosters: state, rename, power", async () => {
    st.setMonitors({ boosters: true });
    sim.extras.tick();
    await until(() => st.snapshot().canBoosters.length === 2);
    st.getCanBoosterName(0xc101);
    await until(() => st.snapshot().canBoosters.find((b) => b.nid === 0xc101)?.name === "Booster Nord");
    st.setCanBoosterName(0xc101, "Werkstatt");
    await until(() => st.snapshot().canBoosters.find((b) => b.nid === 0xc101)?.name === "Werkstatt");
    st.setCanBoosterPower(0xc102, 0x20); // output 2 off
    await until(() => st.snapshot().canBoosters.find((b) => b.nid === 0xc102)?.outputs[1]?.outputDisabled === true);
    expect(st.snapshot().canBoosters.find((b) => b.nid === 0xc102)?.outputs[0]?.outputDisabled).toBe(false);
    expect(() => st.setCanBoosterName(0xc101, "x".repeat(16))).toThrow();
  });
});

describe("zLink booster 10807 behind a Z21 pro LINK", () => {
  const sim = new Z21Simulator(1, undefined, { device: "booster" });
  const st = new Station();
  beforeAll(async () => { await sim.listen(21562, "127.0.0.1"); await st.connect("127.0.0.1", 21562); });
  afterAll(() => { st.client.disconnect(); sim.close(); });

  it("identifies itself and reports name, link info and state", async () => {
    await until(() => st.snapshot().hw?.kind === "booster" && !!st.snapshot().device?.link && !!st.snapshot().device?.boosterState && st.snapshot().device?.name !== undefined);
    const dev = st.snapshot().device!;
    expect(dev.link).toMatchObject({ hwId: 401, fwVersion: "1.1.3217" });
    expect(dev.boosterState?.shortCircuit).toEqual([false, false]);
  });

  it("switches single track outputs and renames", async () => {
    st.setBoosterPower(2, false);
    await until(() => st.snapshot().device?.boosterState?.outputDisabled[1] === true);
    expect(st.snapshot().device?.boosterState?.outputDisabled[0]).toBe(false);
    st.setBoosterPower(3, true);
    await until(() => st.snapshot().device?.boosterState?.outputDisabled.every((v) => !v) === true);
    st.setDeviceName("Anlage Keller");
    await until(() => st.snapshot().device?.name === "Anlage Keller");
  });
});

describe("zLink decoders 10836 / 10837", () => {
  it("reads a switch decoder", async () => {
    const sim = new Z21Simulator(2, undefined, { device: "switchDecoder" });
    const st = new Station();
    await sim.listen(21563, "127.0.0.1");
    await st.connect("127.0.0.1", 21563);
    try {
      await until(() => st.snapshot().device?.decoderState?.kind === "switch");
      st.setExtAccessory(1, 0x80 | 5); // output pair 1, "green"
      await until(() => { const d = st.snapshot().device?.decoderState; return d?.kind === "switch" && d.outputs[0]!.state === "green inactive"; });
    } finally { st.client.disconnect(); sim.close(); }
  });

  it("reads a signal decoder and follows aspect changes", async () => {
    const sim = new Z21Simulator(3, undefined, { device: "signalDecoder" });
    const st = new Station();
    await sim.listen(21564, "127.0.0.1");
    await st.connect("127.0.0.1", 21564);
    try {
      await until(() => st.snapshot().device?.decoderState?.kind === "signal");
      st.setExtAccessory(1, 16);
      await until(() => { const d = st.snapshot().device?.decoderState; return d?.kind === "signal" && d.signals[0]!.dccExt === 16; });
    } finally { st.client.disconnect(); sim.close(); }
  });
});
