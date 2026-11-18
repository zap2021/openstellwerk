import { afterEach, expect, it } from "vitest";
import { Z21Simulator } from "@openstellwerk/simulator";
import { Z21Client } from "./z21-client.js";

const sims: Z21Simulator[] = [];
const clients: Z21Client[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.disconnect(); for (const s of sims.splice(0)) s.close(); });

const until = async (cond: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

async function connected(port: number, silenceLimitMs = 120) {
  const sim = new Z21Simulator();
  sims.push(sim);
  await sim.listen(port, "127.0.0.1");
  const client = new Z21Client();
  clients.push(client);
  client.keepaliveMs = 20;
  client.silenceLimitMs = silenceLimitMs;
  await client.connect("127.0.0.1", port);
  return { sim, client };
}

it("treats a Z21 that stops answering as disconnected (the detector states would be stale)", async () => {
  const { sim, client } = await connected(21580);
  let closed = 0;
  client.on("close", () => closed++);
  expect(client.connected).toBe(true);
  sim.socket.send = (() => undefined) as unknown as typeof sim.socket.send; // the way back dies, our socket stays fine
  await until(() => !client.connected);
  expect(closed).toBe(1);
});

it("stays connected while the Z21 keeps answering the keepalive", async () => {
  const { client } = await connected(21581);
  await new Promise((r) => setTimeout(r, 400)); // several silence limits, but every keepalive is answered
  expect(client.connected).toBe(true);
});
