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

  /** Replace the whole registry (restore from a backup); `list` comes from parseGarage. */
  replaceAll(list: GarageLoco[]) {
    this.map = new Map(list.map((l) => [l.address, l]));
    this.save();
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

const SOURCES: GarageSource[] = ["scan", "prog", "manual", "railcom", "detector", "active"];

/** Strict check of a loco list from a backup file; throws a readable German error and changes nothing. */
export function parseGarage(raw: unknown): GarageLoco[] {
  if (!Array.isArray(raw)) throw new Error("Lokliste: Liste erwartet");
  if (raw.length > 1000) throw new Error("Lokliste: zu viele Einträge");
  const seen = new Set<number>();
  return raw.map((e: unknown, i: number) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const address = o.address;
    if (typeof address !== "number" || !Number.isInteger(address) || address < 1 || address > 9999) throw new Error(`Lokliste, Eintrag ${i + 1}: Adresse muss zwischen 1 und 9999 liegen`);
    if (seen.has(address)) throw new Error(`Lokliste: Adresse ${address} doppelt`);
    seen.add(address);
    const sources = (Array.isArray(o.sources) ? o.sources : []).filter((x): x is GarageSource => SOURCES.includes(x as GarageSource));
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 40) || undefined : undefined;
    const lastSeen = typeof o.lastSeen === "number" && Number.isFinite(o.lastSeen) ? o.lastSeen : undefined;
    return { address, name, sources: [...new Set(sources)], functionNames: cleanNames((o.functionNames ?? {}) as Record<number, string>), lastSeen };
  });
}
