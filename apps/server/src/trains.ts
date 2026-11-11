import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { validateTrains, type Train, type TrainLocation } from "@z21/timetable";
import { JsonFile } from "./json-file.js";

const err = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** Trains with their (believed) location. Without a file it lives in memory (tests). */
export class TrainStore {
  private map = new Map<string, Train>();
  private store: JsonFile<Train[]>;

  constructor(file?: string) {
    this.store = new JsonFile(file);
    const raw = this.store.read();
    if (raw !== undefined) {
      try {
        for (const [i, t] of validateTrains(raw).entries()) {
          const had = (raw as unknown as Array<Record<string, unknown>>)[i]?.location !== undefined;
          if (had && !t.location) console.error(`trains.json: Standort von Zug „${t.name}“ ungültig, verworfen`);
          this.map.set(t.id, t);
        }
      } catch (e) {
        console.error("trains.json ignoriert:", (e as Error).message);
        this.map.clear();
      }
    }
    this.markAllUncertain();
  }

  list(): Train[] { return [...this.map.values()]; }
  get(id: string) { return this.map.get(id); }

  /** Create (no id) or change; a `location` in the input is ignored. */
  save(input: unknown, id?: string): Train {
    const cur = id ? this.map.get(id) : undefined;
    if (id && !cur) throw err("Zug nicht gefunden", 404);
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const newId = cur?.id ?? randomBytes(4).toString("hex");
    const { location: _ignored, ...fields } = o;
    let next: Train;
    try {
      [next] = validateTrains([{ ...(cur ? { ...cur, location: undefined } : {}), ...fields, id: newId }]);
    } catch (e) { throw err((e as Error).message, 400); }
    for (const other of this.map.values()) {
      if (other.id !== next.id && other.address === next.address) throw err(`Lokadresse ${next.address} ist schon dem Zug „${other.name}“ zugeordnet`, 409);
    }
    if (cur?.location) next.location = cur.location;
    this.map.set(next.id, next);
    this.persist();
    return next;
  }

  remove(id: string) {
    const ok = this.map.delete(id);
    if (ok) this.persist();
    return ok;
  }

  setLocation(id: string, blockId: string | null): Train {
    const t = this.map.get(id);
    if (!t) throw err("Zug nicht gefunden", 404);
    this.place(t, blockId, "manual");
    return t;
  }
  setCarried(id: string, blockId: string) { const t = this.map.get(id); if (t) this.place(t, blockId, "carried"); }
  setDetected(id: string, blockId: string) { const t = this.map.get(id); if (t) this.place(t, blockId, "detected"); }

  markUncertain(id: string) {
    const t = this.map.get(id);
    if (!t?.location) return;
    t.location = { ...t.location, uncertain: true };
    this.persist();
  }

  markAllUncertain() {
    for (const t of this.map.values()) if (t.location) t.location = { ...t.location, uncertain: true };
  }

  dropUnknownBlocks(valid: Set<string>) {
    let changed = false;
    for (const t of this.map.values()) if (t.location && !valid.has(t.location.blockId)) { delete t.location; changed = true; }
    if (changed) this.persist();
  }

  /** Replace everything (backup restore); locations are dropped. */
  replaceAll(trains: Train[]) {
    this.map = new Map(trains.map((t) => { const { location: _l, ...rest } = t; return [t.id, rest]; }));
    this.persist();
  }

  private place(t: Train, blockId: string | null, source: TrainLocation["source"]) {
    if (blockId === null) delete t.location;
    else t.location = { blockId, source, since: Date.now() };
    this.persist();
  }

  private persist() { this.store.write(() => this.list()); }
}

export function registerTrainRoutes(app: FastifyInstance, store: TrainStore, deps: { blockIds: () => Set<string>; onRemove: (trainId: string) => void }) {
  app.get("/api/trains", async () => store.list());
  app.post<{ Body: unknown }>("/api/trains", async (req) => store.save(req.body));
  app.put<{ Params: { id: string }; Body: unknown }>("/api/trains/:id", async (req) => store.save(req.body, req.params.id));
  app.delete<{ Params: { id: string } }>("/api/trains/:id", async (req) => {
    if (store.get(req.params.id)) deps.onRemove(req.params.id);
    return { removed: store.remove(req.params.id) };
  });
  app.put<{ Params: { id: string }; Body: { blockId?: string | null } }>("/api/trains/:id/location", async (req) => {
    const blockId = req.body?.blockId ?? null;
    if (blockId !== null && (typeof blockId !== "string" || !deps.blockIds().has(blockId))) throw err("Block nicht gefunden", 400);
    return store.setLocation(req.params.id, blockId);
  });
}
