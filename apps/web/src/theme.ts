/** Nachtschaltung (dunkle Tischfelder) ist der Standard; "day" schaltet helle Felder ein. Die Wahl bleibt je Browser. */
export type Theme = "night" | "day";

/** Einstellungen aus der Zeit, als das Projekt noch „z21-web“ hieß, einmalig unter den neuen Namen übernehmen. */
export function migrateStorage(): void {
  try {
    for (const key of ["theme", "loco", "fnOnlyNamed", "dockCam"]) {
      const old = localStorage.getItem(`z21.${key}`);
      if (old === null) continue;
      if (localStorage.getItem(`openstellwerk.${key}`) === null) localStorage.setItem(`openstellwerk.${key}`, old);
      localStorage.removeItem(`z21.${key}`);
    }
  } catch { /* private mode */ }
}

export function storedTheme(): Theme {
  try { return localStorage.getItem("openstellwerk.theme") === "day" ? "day" : "night"; } catch { return "night"; }
}

export function applyTheme(theme: Theme): void {
  if (theme === "day") document.documentElement.dataset.theme = "day";
  else delete document.documentElement.dataset.theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try { localStorage.setItem("openstellwerk.theme", theme); } catch { /* private mode */ }
}
