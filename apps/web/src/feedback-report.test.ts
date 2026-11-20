import { describe, expect, it } from "vitest";
import { buildReport, INCLUDE_ALL, redact, type ReportContext } from "./feedback-report";
import { clearUsage, clickLabel, logUsage, recentUsage, USAGE_MAX } from "./usage-log";

const ctx: ReportContext = {
  route: "#/verwaltung/station", version: "0.5.4", userAgent: "TestBrowser/1.0", screen: "1180×820", theme: "Nacht",
  station: { hw: "z21 start", firmware: "1.43", connected: true, demo: false },
  events: [{ at: new Date(2026, 10, 20, 9, 5, 7).getTime(), kind: "klick", text: "Verbinden 192.168.178.196" }, { at: new Date(2026, 10, 20, 9, 5, 9).getTime(), kind: "fehler", text: "Keine Antwort" }],
  by: "Mia",
};

describe("redact", () => {
  it("macht IP-Adressen, MAC-Adressen und lange Nummern unkenntlich", () => {
    expect(redact("verbunden mit 192.168.178.196, Seriennr 220455, 12:34:56:78:9a:bc")).toBe("verbunden mit [IP], Seriennr [Nummer], [MAC]");
    expect(redact("Fahrstufe 126, Adresse 3")).toBe("Fahrstufe 126, Adresse 3");
  });
});

describe("buildReport", () => {
  it("enthält Beschreibung, Angaben und Verlauf, IP-Adressen nur unkenntlich", () => {
    const text = buildReport("Der Knopf tut nichts", ctx, INCLUDE_ALL);
    expect(text).toContain("Der Knopf tut nichts");
    expect(text).toContain("- Version: 0.5.4");
    expect(text).toContain("- Zentrale: z21 start, Firmware 1.43");
    expect(text).toContain("09:05:07 Klick: Verbinden [IP]");
    expect(text).toContain("09:05:09 Fehler: Keine Antwort");
    expect(text).toContain("Gemeldet über die Oberfläche von Mia.");
    expect(text).not.toContain("192.168");
  });

  it("lässt abgewählte Angaben weg", () => {
    const text = buildReport("x", ctx, { page: false, device: false, station: false, trail: false, name: false });
    expect(text).not.toContain("Nutzungsinformationen");
    expect(text).not.toContain("Letzte Schritte");
    expect(text).not.toContain("Mia");
    expect(text).toContain("_Gemeldet über die Oberfläche._");
  });

  it("nennt eine Demo statt einer echten Zentrale", () => {
    expect(buildReport("x", { ...ctx, station: { connected: true, demo: true } }, INCLUDE_ALL)).toContain("Demo (simuliert)");
  });
});

describe("usage-log", () => {
  it("hält nur die letzten Einträge und verschluckt Doppelte", () => {
    clearUsage();
    for (let i = 0; i < USAGE_MAX + 10; i++) logUsage("klick", `Knopf ${i}`, 1000 + i * 2000);
    expect(recentUsage().length).toBe(USAGE_MAX);
    expect(recentUsage()[recentUsage().length - 1]!.text).toBe(`Knopf ${USAGE_MAX + 9}`);
    clearUsage();
    logUsage("seite", "#start", 5000); logUsage("seite", "#start", 5100);
    expect(recentUsage().length).toBe(1);
    logUsage("klick", "   ");
    expect(recentUsage().length).toBe(1);
  });

  it("clickLabel liest nur Beschriftungen, nichts Privates", () => {
    expect(clickLabel(null)).toBeUndefined();
    expect(clickLabel({} as EventTarget)).toBeUndefined();
  });
});
