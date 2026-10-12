import { describe, expect, it } from "vitest";
import { cmd, decodeFrames, decodeLocoNet, locoNetChecksum, parseFrame, reply } from "./index.js";

describe("frames", () => {
  it("encodes known Z21 reference frames", () => {
    expect([...cmd.getSerialNumber()]).toEqual([0x04, 0, 0x10, 0]);
    expect([...cmd.trackPowerOn()]).toEqual([0x07, 0, 0x40, 0, 0x21, 0x81, 0xa0]);
    expect([...cmd.trackPowerOff()]).toEqual([0x07, 0, 0x40, 0, 0x21, 0x80, 0xa1]);
    expect([...cmd.getStatus()]).toEqual([0x07, 0, 0x40, 0, 0x21, 0x24, 0x05]);
    expect([...cmd.emergencyStop()]).toEqual([0x06, 0, 0x40, 0, 0x80, 0x80]);
    expect([...cmd.getLocoInfo(3)]).toEqual([0x09, 0, 0x40, 0, 0xe3, 0xf0, 0x00, 0x03, 0x10]);
  });

  it("uses the 0xC000 marker for long loco addresses", () => {
    const f = cmd.getLocoInfo(1000);
    expect(f[6]).toBe(0xc3);
    expect(f[7]).toBe(0xe8);
  });

  it("splits multiple frames per datagram", () => {
    const both = Buffer.concat([reply.serial(1), reply.trackPower("on")]);
    expect(decodeFrames(both)).toHaveLength(2);
  });
});

describe("messages", () => {
  it("round-trips loco info", () => {
    const info = { address: 1000, steps: 128 as const, busy: true, forward: false, speed: 57, emergencyStop: false,
      functions: Array.from({ length: 29 }, (_, i) => i % 3 === 0) };
    const [f] = decodeFrames(reply.locoInfo(info));
    const m = parseFrame(f!);
    expect(m.type === "locoInfo" && m.info).toEqual(info);
  });

  it("parses cv results 1-based", () => {
    const [f] = decodeFrames(reply.cv(29, 6));
    expect(parseFrame(f!)).toEqual({ type: "cv", cv: 29, value: 6 });
  });

  it("flags broken checksums as unknown", () => {
    const bad = cmd.trackPowerOn();
    bad[bad.length - 1] ^= 0xff;
    expect(parseFrame(decodeFrames(bad)[0]!).type).toBe("unknown");
  });

  it("parses hwinfo", () => {
    const m = parseFrame(decodeFrames(reply.hwinfo(0x211, 1, 43))[0]!);
    expect(m).toMatchObject({ type: "hwinfo", hwName: "Z21 XL", fwVersion: "1.43" });
  });
});

describe("phase 2: railcom / loconet / detectors", () => {
  const msg = (b: Buffer) => parseFrame(decodeFrames(b)[0]!);

  it("encodes spec example frames", () => {
    expect([...cmd.railComGetData(0)]).toEqual([0x07, 0, 0x89, 0, 0x01, 0, 0]);
    expect([...cmd.loconetDetector(0x81, 1017)]).toEqual([0x07, 0, 0xa4, 0, 0x81, 0xf8, 0x03]);
    expect([...cmd.canDetector()]).toEqual([0x07, 0, 0xc4, 0, 0x00, 0x00, 0xd0]);
  });

  it("parses RailCom data (DataLen 0x11, optional speed/qos)", () => {
    const buf = reply.railcom({ address: 1000, receiveCounter: 70000, errorCounter: 3, speed: 45, qos: 7 });
    expect(buf.readUInt16LE(0)).toBe(0x11);
    expect(msg(buf)).toEqual({ type: "railcom", data: { address: 1000, receiveCounter: 70000, errorCounter: 3, speed: 45, qos: 7 } });
    const plain = msg(reply.railcom({ address: 3, receiveCounter: 1, errorCounter: 0 }));
    expect(plain.type === "railcom" && plain.data.speed).toBeUndefined();
  });

  it("computes and verifies LocoNet checksums", () => {
    // OPC_GPON: 0x83 -> checksum 0x7C
    const f = cmd.loconetFromLan([0x83]);
    expect([...f]).toEqual([0x06, 0, 0xa2, 0, 0x83, 0x7c]);
    const m = msg(f);
    expect(m.type === "loconet" && m.decoded).toMatchObject({ opcode: "OPC_GPON", checksumOk: true });
    const bad = Buffer.from(f); bad[bad.length - 1] ^= 1;
    const mb = msg(bad);
    expect(mb.type === "loconet" && mb.decoded.checksumOk).toBe(false);
  });

  it("decodes switch requests 1-based", () => {
    // turnout 1, closed, output ON: sw1=0, sw2=0x30
    const bytes = [0xb0, 0x00, 0x30]; bytes.push(locoNetSum(bytes));
    expect(decodeLocoNet(bytes).text).toBe("turnout 1 closed/green output ON");
  });

  it("parses LocoNet detector replies incl. transponder", () => {
    expect(msg(reply.loconetDetector(0x01, 17, [1]))).toEqual({ type: "loconetDetector", feedbackAddress: 17, event: { kind: "occupancy", occupied: true } });
    expect(msg(reply.loconetDetector(0x02, 5, [0xe8, 0x03]))).toMatchObject({ event: { kind: "transponder", present: true, locoAddress: 1000 } });
  });

  it("parses CAN detector occupancy and loco lists", () => {
    expect(msg(reply.canDetector(0xd001, 7, 2, 0x01, 0x1100))).toMatchObject({ value: { nid: 0xd001, moduleAddress: 7, port: 2, occupancy: { occupied: true, voltage: true } } });
    const locos = msg(reply.canDetector(0xd001, 7, 2, 0x11, 0x8000 | 3, 0xc000 | 1000));
    expect(locos.type === "canDetector" && locos.value.locos).toEqual([
      { address: 3, direction: "forward" }, { address: 1000, direction: "backward" },
    ]);
  });
});

const locoNetSum = locoNetChecksum;

describe("phase 3: remaining spec chapters", () => {
  const msg = (b: Buffer) => parseFrame(decodeFrames(b)[0]!);

  it("matches spec example frames", () => {
    expect([...cmd.setExtAccessory(1, 5)]).toEqual([0x0a, 0, 0x40, 0, 0x54, 0x00, 0x04, 0x05, 0x00, 0x55]);
    expect([...cmd.extAccessoryEStop()]).toEqual([0x0a, 0, 0x40, 0, 0x54, 0x07, 0xff, 0x00, 0x00, 0xac]);
    expect([...cmd.mmWriteByte(1, 5)]).toEqual([0x0a, 0, 0x40, 0, 0x24, 0xff, 0x00, 0x00, 0x05, 0xde]);
    expect([...cmd.getFirmwareVersion()]).toEqual([0x07, 0, 0x40, 0, 0xf1, 0x0a, 0xfb]);
    expect([...cmd.fastClockGet()]).toEqual([0x07, 0, 0xcc, 0, 0x21, 0x2a, 0x0b]);
    expect([...cmd.fastClockStart()]).toEqual([0x07, 0, 0xcc, 0, 0x21, 0x2c, 0x0d]);
    expect([...cmd.fastClockStop()]).toEqual([0x07, 0, 0xcc, 0, 0x21, 0x2d, 0x0c]);
    expect([...cmd.fastClockSettingsGet()]).toEqual([0x05, 0, 0xce, 0, 0x04]);
    expect([...cmd.zlinkGetHwInfo()]).toEqual([0x05, 0, 0xe8, 0, 0x06]);
    expect(cmd.canDeviceSetDescription(0xc101, "Test").length).toBe(0x16);
    expect(cmd.boosterSetDescription("Test").length).toBe(0x24);
  });

  it("encodes POM and loco commands", () => {
    // POM write CV3 = 12 on loco 3: E6 30 00 03 EC 02 0C
    expect([...cmd.pomWriteByte(3, 3, 12)].slice(4, 11)).toEqual([0xe6, 0x30, 0x00, 0x03, 0xec, 0x02, 0x0c]);
    expect(cmd.pomReadByte(3, 300)[8]).toBe(0xe4 | 1); // CV300 -> wire 299 -> MSB 1
    expect([...cmd.locoEStop(3)]).toEqual([0x08, 0, 0x40, 0, 0x92, 0x00, 0x03, 0x91]);
    expect([...cmd.purgeLoco(3)].slice(4, 8)).toEqual([0xe3, 0x44, 0x00, 0x03]);
    expect([...cmd.setLocoBinaryState(3, 200, true)].slice(4, 10)).toEqual([0xe5, 0x5f, 0x00, 0x03, 0x80 | (200 & 0x7f), 200 >> 7]);
  });

  it("uses big-endian addresses for loco mode and parses replies", () => {
    expect([...cmd.setLocoMode(0x0102, "mm")]).toEqual([0x07, 0, 0x61, 0, 0x01, 0x02, 0x01]);
    expect(msg(reply.mode(0x60, 5, "mm"))).toEqual({ type: "locoMode", address: 5, mode: "mm" });
    expect(msg(reply.mode(0x70, 4, "dcc"))).toEqual({ type: "turnoutMode", address: 5, mode: "dcc" });
  });

  it("parses firmware version, code, unknown command, ext accessory", () => {
    expect(msg(reply.firmwareVersion(1, 23))).toEqual({ type: "firmwareVersion", version: "1.23" });
    expect(msg(reply.code(2))).toEqual({ type: "code", code: "startUnlocked" });
    expect(msg(reply.unknownCommand()).type).toBe("unknownCommand");
    expect(msg(reply.extAccessory(1, 16))).toEqual({ type: "extAccessory", address: 1, value: 16, valid: true });
  });

  it("parses R-BUS example from the spec", () => {
    // Group 1, 01 00 C5 ... -> module 11 input 1; module 13 inputs 8,7,3,1
    const m = msg(reply.rmbus(1, [0x01, 0x00, 0xc5]));
    expect(m.type === "rmbus" && m.data.modules[0]).toMatchObject({ module: 11, inputs: [true, false, false, false, false, false, false, false] });
    const m13 = m.type === "rmbus" ? m.data.modules[2]!.inputs : [];
    expect(m13.map((v, i) => (v ? i + 1 : 0)).filter(Boolean)).toEqual([1, 3, 7, 8]);
  });

  it("round-trips fast clock time", () => {
    const t = { weekday: 4, hour: 17, minute: 42, second: 9, rate: 8, stopped: false, halted: true, settings: 0x4f };
    expect(msg(reply.fastClock(t))).toEqual({ type: "fastClock", time: t });
    // fastClockSet frame: 0x0A len, XOR over data
    const f = cmd.fastClockSet(4, 17, 42, 8);
    expect(f[0]).toBe(0x0a);
    expect(f[f.length - 1]).toBe(f.subarray(4, f.length - 1).reduce((a, b) => a ^ b, 0));
  });

  it("parses CAN booster state and names (latin1, 0xFF = unset)", () => {
    const m = msg(reply.canBooster(0xc101, 2, 0x0020 | 0x0800, 18000, 1234));
    expect(m).toMatchObject({ type: "canBooster", state: { nid: 0xc101, outputPort: 2, shortCircuit: true, railComActive: true, voltage: 18000, current: 1234 } });
    expect(msg(reply.canDeviceName(0xc101, "Bahnhof Süd"))).toEqual({ type: "canDeviceName", nid: 0xc101, name: "Bahnhof Süd" });
    const unset = Buffer.alloc(32, 0); unset[0] = 0xff;
    expect(parseFrame({ header: 0xb8, data: unset })).toEqual({ type: "deviceName", device: "booster", name: "" });
    expect(() => cmd.boosterSetDescription('a"b')).toThrow();
    expect(() => cmd.canDeviceSetDescription(0xc101, "x".repeat(16))).toThrow();
  });

  it("tells switch and signal decoder state apart by length", () => {
    const sw = Buffer.alloc(44); sw.writeUInt16LE(3300, 4); sw[8] = 0x11; sw[9] = 0x02; sw.writeUInt16LE(5, 32);
    const m1 = msg(reply.decoderState(sw));
    expect(m1.type === "decoderState" && m1.state).toMatchObject({ kind: "switch", voltage: 3300, address: 5 });
    expect(m1.type === "decoderState" && m1.state.kind === "switch" && m1.state.outputs[0]!.state).toBe("red active");
    const sg = Buffer.alloc(42); sg[23] = 2; sg[12] = 16; sg[24] = 7; sg[8] = 0b101;
    const m2 = msg(reply.decoderState(sg));
    expect(m2.type === "decoderState" && m2.state).toMatchObject({ kind: "signal", signalCount: 2, address: 0 });
    expect(m2.type === "decoderState" && m2.state.kind === "signal" && m2.state.signals[0]).toMatchObject({ dccExt: 16, signalId: 7 });
  });

  it("parses the spec's Z21 pro LINK hw info example", () => {
    const m = msg(reply.zlinkHwInfo(401, 1, 1, 3217, "EC FA BC 4F 04 C6", "this_is_a_quite_long_device_name"));
    expect(m).toMatchObject({ type: "zlinkHwInfo", info: { hwId: 401, fwVersion: "1.1.3217", mac: "EC FA BC 4F 04 C6", name: "this_is_a_quite_long_device_name" } });
  });
});
