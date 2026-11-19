import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StationState } from "./api";
import { DriveTab, LocoSearch } from "./drive";

describe("Fahren", () => {
  it("zeigt die Erkennungshilfe zunächst eingeklappt", () => {
    const state: StationState = {
      connected: false, locos: [], turnouts: {}, garage: [], railcom: [], loconetDetectors: [], canDetectors: [],
      rmbus: [], canBoosters: [], extAccessories: {}, modes: { loco: {}, turnout: {} },
      monitors: { railcom: false, loconet: false, detectors: false, rmbus: false, boosters: false, clock: false },
    };
    const drive = renderToStaticMarkup(createElement(DriveTab, { state, run: async () => {} }));
    const search = renderToStaticMarkup(createElement(LocoSearch, { state, run: async () => {} }));

    // die Suche ist nicht mehr im Fahrbereich, sondern eine eigene Verwaltungsseite
    expect(drive).not.toContain("Belegte Adressen suchen");
    expect(drive).toContain("Noch keine Lok erkannt.");
    expect(search).toContain("Belegte Adressen suchen");
    expect(search).toContain("<details><summary>Wie funktioniert die Lok-Erkennung?</summary>");
    expect(search).toContain("Eine stehende, unbenutzte Lok ohne RailCom lässt sich nicht erkennen");
    // Admins bekommen im leeren Fahrbereich den Sprung zur Suche
    expect(renderToStaticMarkup(createElement(DriveTab, { state, run: async () => {}, toAdmin: () => {} }))).toContain("Loks suchen");
  });
});
