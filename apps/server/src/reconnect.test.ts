import { describe, expect, it, vi } from "vitest";
import { Reconnector } from "./reconnect.js";

const make = (o: { last?: { host: string; port?: number }; busy?: boolean; connect?: (h: string, p?: number) => Promise<void> } = {}) => {
  const connect = vi.fn(o.connect ?? (async () => {}));
  return { connect, r: new Reconnector({ last: () => o.last, busy: () => !!o.busy, connect }) };
};

describe("Reconnector", () => {
  it("verbindet mit der gemerkten Zentrale", async () => {
    const { r, connect } = make({ last: { host: "192.168.0.111", port: 21105 } });
    expect(await r.attempt()).toBe("connected");
    expect(connect).toHaveBeenCalledWith("192.168.0.111", 21105);
  });
  it("tut nichts, wenn schon verbunden oder Demo läuft", async () => {
    const { r, connect } = make({ last: { host: "x" }, busy: true });
    expect(await r.attempt()).toBe("already");
    expect(connect).not.toHaveBeenCalled();
  });
  it("meldet 409, wenn noch keine Zentrale hinterlegt ist", async () => {
    const { r } = make();
    await expect(r.attempt()).rejects.toMatchObject({ statusCode: 409 });
  });
  it("meldet 504 mit Adresse, wenn die Zentrale nicht antwortet, und erlaubt danach einen neuen Versuch", async () => {
    let up = false;
    const { r, connect } = make({ last: { host: "10.0.0.5" }, connect: async () => { if (!up) throw new Error("Timeout"); } });
    await expect(r.attempt()).rejects.toMatchObject({ statusCode: 504, message: expect.stringContaining("10.0.0.5") });
    up = true;
    expect(await r.attempt()).toBe("connected");
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("teilt gleichzeitige Aufrufe auf einen Versuch auf", async () => {
    let release!: () => void;
    const { r, connect } = make({ last: { host: "h" }, connect: () => new Promise<void>((res) => { release = res; }) });
    const a = r.attempt(), b = r.attempt();
    release();
    expect(await Promise.all([a, b])).toEqual(["connected", "connected"]);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
