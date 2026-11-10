import { JsonFile } from "./json-file.js";

export type GarageSource = "scan" | "prog" | "manual" | "railcom" | "detector" | "active";

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
  private store: JsonFile<GarageLoco[]>;

  constructor(file?: string) {
    this.store = new JsonFile(file);
    {
      const raw = this.store.read();
      for (const l of Array.isArray(raw) ? raw : []) {
        if (Number.isInteger(l.address) && l.address >= 1 && l.address <= 9999) {
          this.map.set(l.address, { address: l.address, name: l.name, sources: l.sources ?? [], functionNames: l.functionNames ?? {}, lastSeen: l.lastSeen });
        }
      }
    }
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

  private save() { this.store.write(() => this.list()); }
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
