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
