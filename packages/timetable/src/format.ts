import type { Status } from "./types.js";

export function formatHHMM(minutes: number): string {
  const m = Math.floor(minutes);
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function parseHHMM(text: string): number | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

const TEXTS: Record<Status, string> = {
  planned: "planmäßig",
  waiting: "Verspätung",
  set: "eingestellt",
  running: "fährt",
  failed: "Störung",
  cancelled: "entfällt",
  done: "beendet",
};

export function statusText(status: Status, reason?: string): string {
  return reason ? `${TEXTS[status]} – ${reason}` : TEXTS[status];
}
