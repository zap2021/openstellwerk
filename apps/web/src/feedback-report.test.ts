import { describe, expect, it } from "vitest";
import { buildReport } from "./feedback-report";

describe("buildReport", () => {
  it("enthält nur die Beschreibung und auf Wunsch den Namen", () => {
    expect(buildReport("  Der Knopf tut nichts ", "Mia")).toBe("Der Knopf tut nichts\n\n_Gemeldet über die Oberfläche von Mia._");
    expect(buildReport("Der Knopf tut nichts")).toBe("Der Knopf tut nichts\n\n_Gemeldet über die Oberfläche._");
  });

  it("erfasst nichts von selbst: keine Seite, kein Gerät, keine Schritte", () => {
    const text = buildReport("x", "Mia");
    for (const word of ["Nutzungsinformationen", "Browser", "Version", "Letzte Schritte", "Zentrale"]) expect(text).not.toContain(word);
  });

  it("lässt eine leere Beschreibung nicht leer", () => {
    expect(buildReport("   ")).toContain("keine Beschreibung");
  });
});
