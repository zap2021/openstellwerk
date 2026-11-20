import type { UsageEvent } from "./usage-log";

/** Was in den Text einer Meldung darf; jede Angabe ist im Dialog abwählbar. */
export interface ReportInclude { page: boolean; device: boolean; station: boolean; trail: boolean; name: boolean }
export const INCLUDE_ALL: ReportInclude = { page: true, device: true, station: true, trail: true, name: true };

export interface ReportContext {
  route: string;
  version?: string;
  userAgent: string;
  screen: string;
  theme?: string;
  station?: { hw?: string; firmware?: string; connected: boolean; demo: boolean };
  events: UsageEvent[];
  by?: string;
}

/** IP-Adressen und lange Ziffernfolgen (Seriennummern) unkenntlich machen. */
export function redact(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[IP]")
    .replace(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi, "[MAC]")
    .replace(/\b\d{6,}\b/g, "[Nummer]");
}

const hms = (at: number) => { const d = new Date(at); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const KIND_LABEL: Record<UsageEvent["kind"], string> = { seite: "Seite", klick: "Klick", fehler: "Fehler" };

export function buildReport(description: string, ctx: ReportContext, include: ReportInclude): string {
  const lines: string[] = ["## Beschreibung", "", description.trim() || "_(keine)_"];
  const info: string[] = [];
  if (include.page) { info.push(`- Seite: \`${redact(ctx.route)}\``); if (ctx.version) info.push(`- Version: ${ctx.version}`); }
  if (include.device) { info.push(`- Browser: ${ctx.userAgent}`); info.push(`- Bildschirm: ${ctx.screen}`); if (ctx.theme) info.push(`- Thema: ${ctx.theme}`); }
  if (include.station && ctx.station) {
    const s = ctx.station;
    info.push(`- Zentrale: ${s.demo ? "Demo (simuliert)" : s.connected ? [s.hw, s.firmware && `Firmware ${s.firmware}`].filter(Boolean).join(", ") || "verbunden" : "nicht verbunden"}`);
  }
  if (info.length > 0) lines.push("", "## Nutzungsinformationen", "", ...info);
  if (include.trail && ctx.events.length > 0) {
    lines.push("", "## Letzte Schritte", "", ...ctx.events.slice(-30).map((e) => `- ${hms(e.at)} ${KIND_LABEL[e.kind]}: ${redact(e.text)}`));
  }
  if (include.name && ctx.by) lines.push("", `_Gemeldet über die Oberfläche von ${ctx.by}._`);
  else lines.push("", "_Gemeldet über die Oberfläche._");
  return lines.join("\n");
}
