/** Text der Meldung: genau die Beschreibung der Person, auf Wunsch mit Namen als Absender. Nichts wird automatisch erfasst. */
export function buildReport(description: string, by?: string): string {
  const text = description.trim() || "_(keine Beschreibung)_";
  return `${text}\n\n_Gemeldet über die Oberfläche${by ? ` von ${by}` : ""}._`;
}

/** Ein früher gespeicherter Verlauf der letzten Schritte (Version 0.5.5) wird entfernt. */
export function dropOldUsageTrail(): void {
  try { sessionStorage.removeItem("openstellwerk.usage"); } catch { /* privater Modus */ }
}
