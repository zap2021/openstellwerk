import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StationState } from "./api";
import { DriveTab } from "./drive";

describe("Fahren", () => {
  it("zeigt die Erkennungshilfe zunächst eingeklappt", () => {
    const state: StationState = {
      connected: false, locos: [], turnouts: {}, garage: [], railcom: [], loconetDetectors: [], canDetectors: [],
      rmbus: [], canBoosters: [], extAccessories: {}, modes: { loco: {}, turnout: {} },
      monitors: { railcom: false, loconet: false, detectors: false, rmbus: false, boosters: false, clock: false },
    };
    const html = renderToStaticMarkup(createElement(DriveTab, { state, run: async () => {} }));

    expect(html).toContain("<details><summary>Wie funktioniert die Lok-Erkennung?</summary>");
    // ohne Loks ist die Suche selbst offen, damit man sofort starten kann
    expect(html).toContain("<details class=\"locoscan\" open=\"\">");
    expect(html).toContain("Eine stehende, unbenutzte Lok ohne RailCom lässt sich nicht erkennen");
  });
});
