import { expect, it } from "vitest";
import { cmPerSec, kmh, parseSteps } from "./calibration";
import { journeyText } from "./journeys";

it("mirrors the server's speed table", () => {
  const cal = { scale: 87, points: [{ step: 40, cmPerSec: 20 }, { step: 80, cmPerSec: 50 }] };
  expect([cmPerSec(cal, 20), cmPerSec(cal, 60), cmPerSec(cal, 100)]).toEqual([10, 35, 65]);
  expect(kmh(cal, 40)).toBe(63);
  expect(kmh(undefined, 40)).toBeUndefined();
});

it("reads a list of speed steps", () => {
  expect(parseSteps("20, 40;60 80")).toEqual([20, 40, 60, 80]);
  expect(parseSteps("")).toBeUndefined();
  expect(parseSteps("20, 200")).toBeUndefined();
  expect(parseSteps("zehn")).toBeUndefined();
});

it("describes a journey", () => {
  const j = { id: "j", trainId: "t", targetBlockId: "c", routeIds: ["ab", "bc"], leg: 1, status: "waiting" as const, reason: "Block besetzt", since: 0 };
  expect(journeyText(j, (id) => id.toUpperCase())).toBe("Abschnitt 2/2 („BC“): wartet auf Fahrstraße – Block besetzt");
  expect(journeyText({ ...j, status: "done", reason: undefined }, (id) => id)).toBe("angekommen");
});
