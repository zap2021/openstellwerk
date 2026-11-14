import type { FastifyInstance } from "fastify";
import { JsonFile } from "./json-file.js";

/*
 * Verlauf: was die Anlage und der Server getan haben (Verbindung, Fahrstraßen, Zielfahrten, Fahrautomat, Regeln,
 * Fahrplan, Einmessen, Updates). Ein Ringspeicher mit fester Größe, damit die Datei auf der SD-Karte klein bleibt.
 */

export type EventKind = "verbindung" | "fahrstrasse" | "zielfahrt" | "fahrautomat" | "regel" | "fahrplan" | "einmessen" | "update" | "system";
export interface HistoryEvent { ts: number; kind: EventKind; text: string; /** false = etwas ist nicht gelungen */ ok: boolean }

const KINDS = new Set<string>(["verbindung", "fahrstrasse", "zielfahrt", "fahrautomat", "regel", "fahrplan", "einmessen", "update", "system"]);

export class EventLog {
  private events: HistoryEvent[] = [];
  private store: JsonFile<HistoryEvent[]>;

  constructor(file?: string, private max = 500, private now: () => number = Date.now) {
    this.store = new JsonFile(file, { delayMs: 5000 }); // many events in a row become one write
    const raw = this.store.read();
    if (Array.isArray(raw)) {
      this.events = raw
        .filter((e): e is HistoryEvent => !!e && typeof e === "object" && typeof e.ts === "number" && typeof e.text === "string" && KINDS.has(e.kind as string))
        .map((e) => ({ ts: e.ts, kind: e.kind, text: e.text.slice(0, 300), ok: e.ok !== false }))
        .slice(-max);
    }
  }

  add(kind: EventKind, text: string, ok = true) {
    this.events.push({ ts: this.now(), kind, text: text.slice(0, 300), ok });
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    this.store.write(() => this.events);
  }

  /** Neueste zuerst. */
  list(limit = this.max): HistoryEvent[] { return this.events.slice(-limit).reverse(); }

  clear() { this.events = []; this.store.write(() => this.events); }
}

export function registerHistoryRoutes(app: FastifyInstance, log: EventLog) {
  app.get<{ Querystring: { limit?: string } }>("/api/history", async (req) => {
    const n = Number(req.query.limit);
    return log.list(Number.isInteger(n) && n >= 1 && n <= 500 ? n : 200);
  });
  app.delete("/api/history", async () => { log.clear(); return { ok: true }; });
}
