import { Z21Simulator } from "./simulator.js";

const port = Number(process.env.Z21_SIM_PORT ?? 21105);
const sim = new Z21Simulator(undefined, (s) => console.log("[sim]", s));
await sim.listen(port);
console.log(`[sim] Z21 simulator listening on udp/${port}`);
