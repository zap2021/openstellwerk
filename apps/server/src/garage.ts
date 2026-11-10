import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type GarageSource = "scan" | "prog" | "manual";

/** A loco the user (or the discovery) knows about. Live state stays in Station; this is what must survive a restart. */
export interface GarageLoco {
  address: number;
  name?: string;
  sources: GarageSource[];
  /** user-defined function labels, F-number → text */
  functionNames: Record<number, string>;
  lastSeen?: number;
}

/** Small JSON-file backed registry of known locos. Without a file it only lives in memory (tests). */
export class Garage {
  private map = new Map<number, GarageLoco>();
  private timer?: NodeJS.Timeout;

  constructor(private file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as GarageLoco[];
      for (const l of raw) {
        if (Number.isInteger(l.address) && l.address >= 1 && l.address <= 9999) {
          this.map.set(l.address, { address: l.address, name: l.name, sources: l.sources ?? [], functionNames: l.functionNames ?? {}, lastSeen: l.lastSeen });
        }
      }
    } catch { /* no file yet or unreadable: start empty */ }
  }

  list(): GarageLoco[] {
    return [...this.map.values()].sort((a, b) => a.address - b.address);
  }

  get(address: number) { return this.map.get(address); }

  /** Create or update an entry; `source` is added to the list of ways this loco has been found. */
  upsert(address: number, patch: { name?: string; functionNames?: Record<number, string>; source?: GarageSource } = {}): GarageLoco {
    const cur = this.map.get(address) ?? { address, sources: [], functionNames: {} };
    const next: GarageLoco = {
      ...cur,
      name: patch.name !== undefined ? patch.name.trim().slice(0, 40) || undefined : cur.name,
      functionNames: patch.functionNames ? cleanNames(patch.functionNames) : cur.functionNames,
      sources: patch.source && !cur.sources.includes(patch.source) ? [...cur.sources, patch.source] : cur.sources,
      lastSeen: patch.source ? Date.now() : cur.lastSeen,
    };
    this.map.set(address, next);
    this.save();
    return next;
  }

  remove(address: number) {
    const had = this.map.delete(address);
    if (had) this.save();
    return had;
  }

  /** Debounced write; a failing disk must never take the server down. */
  private save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        mkdirSync(path.dirname(this.file!), { recursive: true });
        writeFileSync(this.file!, JSON.stringify(this.list(), null, 2));
      } catch (e) {
        console.error("garage: could not save", (e as Error).message);
      }
    }, 300);
    this.timer.unref();
  }
}

function cleanNames(names: Record<number, string>) {
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(names)) {
    const n = Number(k);
    const text = String(v ?? "").trim().slice(0, 24);
    if (Number.isInteger(n) && n >= 0 && n <= 31 && text) out[n] = text;
  }
  return out;
}
