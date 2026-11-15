/** Nachtschaltung (dunkle Tischfelder) ist der Standard; "day" schaltet helle Felder ein. Die Wahl bleibt je Browser. */
export type Theme = "night" | "day";

export function storedTheme(): Theme {
  try { return localStorage.getItem("z21.theme") === "day" ? "day" : "night"; } catch { return "night"; }
}

export function applyTheme(theme: Theme): void {
  if (theme === "day") document.documentElement.dataset.theme = "day";
  else delete document.documentElement.dataset.theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try { localStorage.setItem("z21.theme", theme); } catch { /* private mode */ }
}
