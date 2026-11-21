import { describe, expect, it } from "vitest";
import { LOCO_PRESETS, findPreset } from "./loco-presets";

describe("Lok-Vorlagen", () => {
  it("enthält die sechs vorhandenen Modelle", () => {
    expect(LOCO_PRESETS.map((p) => p.article)).toEqual(["Piko 52322", "Piko 52732", "Piko 52602", "Piko 51813", "Trix 22875", "Roco 70318"]);
  });
  it("hat eindeutige Kennungen", () => {
    expect(new Set(LOCO_PRESETS.map((p) => p.id)).size).toBe(LOCO_PRESETS.length);
    expect(findPreset("roco-70318")?.name).toContain("BR 86");
    expect(findPreset("gibt-es-nicht")).toBeUndefined();
  });
  it.each(LOCO_PRESETS.map((p) => [p.article, p] as const))("%s: Namen passen in die Garage (≤ 24 Zeichen, F0–F31, nicht leer)", (_a, p) => {
    for (const [k, v] of Object.entries(p.functions)) {
      expect(Number(k)).toBeGreaterThanOrEqual(0);
      expect(Number(k)).toBeLessThanOrEqual(31);
      expect(v.trim()).not.toBe("");
      expect(v.length).toBeLessThanOrEqual(24);
    }
  });
  it("Stichproben laut Hersteller", () => {
    expect(findPreset("piko-52322")!.functions[10]).toBe("Horn");
    expect(findPreset("piko-52322")!.functions[25]).toBe("Ton aus");
    expect(findPreset("piko-52732")!.functions[23]).toBe("Soundfader (Tunnel)");
    expect(findPreset("piko-51813")!.functions[9]).toBe("Stromabnehmer");
    expect(findPreset("trix-22875")!.functions[2]).toBe("Lokpfeife lang");
    expect(findPreset("trix-22875")!.functions[24]).toBe("Kohle fassen");
    expect(findPreset("roco-70318")!.functions[26]).toBe("Lautstärke leiser");
  });
});
