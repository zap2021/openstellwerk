/**
 * Strikter Wahrheitswert aus einer Anfrage. `!!v` macht aus dem String "false" ein `true`; bei Gleisspannung
 * oder Fahrtrichtung darf eine ungenaue Anfrage nie als Einschalten/Vorwärts durchgehen.
 */
export function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw Object.assign(new Error(`${label}: true oder false erwartet`), { statusCode: 400 });
  return v;
}
