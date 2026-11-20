/**
 * Verlauf der letzten Schritte in der Oberfläche (Issue #24). Er liegt nur im Browser (sessionStorage) und geht nur mit,
 * wenn jemand im Dialog „Problem melden“ ausdrücklich sendet. Erfasst werden Seitenwechsel, Beschriftungen angeklickter
 * Knöpfe und Fehlermeldungen, keine Eingaben, keine Passwörter, keine Adressen.
 */
export type UsageKind = "seite" | "klick" | "fehler";
export interface UsageEvent { at: number; kind: UsageKind; text: string }

const KEY = "openstellwerk.usage";
export const USAGE_MAX = 60;
const TEXT_MAX = 80;

let events: UsageEvent[] = load();

function load(): UsageEvent[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as UsageEvent[];
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.text === "string").slice(-USAGE_MAX) : [];
  } catch { return []; }
}

function save() { try { sessionStorage.setItem(KEY, JSON.stringify(events)); } catch { /* privater Modus */ } }

export function logUsage(kind: UsageKind, text: string, at = Date.now()): void {
  const t = text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
  if (!t) return;
  const last = events[events.length - 1];
  if (last && last.kind === kind && last.text === t && at - last.at < 1000) return; // doppelte Meldungen in einer Sekunde
  events.push({ at, kind, text: t });
  if (events.length > USAGE_MAX) events = events.slice(-USAGE_MAX);
  save();
}

export const recentUsage = (): UsageEvent[] => [...events];
export function clearUsage(): void { events = []; save(); }

/** Beschriftung des angeklickten Bedienelements; nichts aus Eingabefeldern und nichts, was als privat markiert ist. */
export function clickLabel(target: EventTarget | null): string | undefined {
  const el = typeof Element !== "undefined" && target instanceof Element ? target.closest("button, [role=tab], a, summary") : null;
  if (!el || el.closest("[data-private]") || el.closest("dialog.report")) return undefined;
  const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : undefined;
}

/** Hört auf Seitenwechsel, Klicks und Skriptfehler; gibt die Abmeldefunktion zurück. */
export function startUsageLog(): () => void {
  const hash = () => logUsage("seite", `#${location.hash.replace(/^#\/?/, "") || "start"}`);
  const click = (e: MouseEvent) => { const l = clickLabel(e.target); if (l) logUsage("klick", l); };
  const error = (e: ErrorEvent) => logUsage("fehler", `Skriptfehler: ${e.message}`);
  const rejection = (e: PromiseRejectionEvent) => logUsage("fehler", `Unbehandelter Fehler: ${(e.reason as Error | undefined)?.message ?? String(e.reason)}`);
  hash();
  window.addEventListener("hashchange", hash);
  document.addEventListener("click", click, true);
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    window.removeEventListener("hashchange", hash);
    document.removeEventListener("click", click, true);
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
  };
}
