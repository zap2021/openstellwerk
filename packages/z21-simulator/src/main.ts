import type { SimDevice } from "./extras.js";
import { Z21Simulator } from "./simulator.js";

const port = Number(process.env.Z21_SIM_PORT ?? 21105);
const device = (process.env.Z21_SIM_DEVICE ?? "z21") as SimDevice;
if (!["z21", "booster", "switchDecoder", "signalDecoder"].includes(device)) throw new Error(`Z21_SIM_DEVICE must be z21, booster, switchDecoder or signalDecoder (got "${device}")`);
const sim = new Z21Simulator(undefined, (s) => console.log("[sim]", s), { device });
await sim.listen(port);
console.log(`[sim] ${device} simulator listening on udp/${port}`);

// Demo traffic: a loco rolls through two blocks and a CAN detector port, so the monitors have something to show.
if (process.env.Z21_SIM_DEMO !== "0" && device === "z21") {
  let tick = 0;
  sim.setLocoNetOccupancy(1, false);
  sim.setLocoNetOccupancy(2, false);
  setInterval(() => {
    tick++;
    sim.setLocoNetOccupancy(1, tick % 4 < 2);
    sim.setLocoNetOccupancy(2, tick % 4 >= 2, tick % 4 >= 2 ? 1000 : undefined);
    sim.extras.setRmBus(1 + (tick % 3), 1 + (tick % 8), tick % 2 === 0);
    sim.setCanOccupancy(0xd001, 3, tick % 4 >= 1 && tick % 4 < 3, [{ address: 3 }, { address: 1000, backward: true }]);
  }, 4000);
}
