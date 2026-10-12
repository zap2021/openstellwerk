import { describe, expect, it } from "vitest";
import { cmd, decodeFrames, parseFrame, reply } from "./index.js";

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
