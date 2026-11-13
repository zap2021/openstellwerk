import type { FastifyInstance } from "fastify";
import type { LocoEvent } from "./automations.js";
import { JsonFile } from "./json-file.js";

/* Erfolge (Gamification), Wertung pro Anlage. Gezählt wird serverseitig, nichts davon beeinflusst die Fahrsicherheit. */

export interface Stats { starts: number; stops: number; estops: number; departures: number }
export type StatKey = keyof Stats;

export interface Definition { id: string; title: string; text: string; points: number; stat: StatKey; goal: number }

export const DEFINITIONS: readonly Definition[] = [
  { id: "first-start", title: "Erste Fahrt", text: "Eine Lok fährt zum ersten Mal an.", points: 5, stat: "starts", goal: 1 },
  { id: "starts-10", title: "Anfahrer", text: "Zehnmal eine Lok anfahren lassen.", points: 10, stat: "starts", goal: 10 },
  { id: "starts-100", title: "Dauerläufer", text: "Hundertmal eine Lok anfahren lassen.", points: 30, stat: "starts", goal: 100 },
  { id: "stops-10", title: "Haltepunkt", text: "Zehnmal eine fahrende Lok zum Halt bringen.", points: 10, stat: "stops", goal: 10 },
  { id: "departures-1", title: "Nach Fahrplan", text: "Die erste Fahrplanfahrt abschließen.", points: 10, stat: "departures", goal: 1 },
  { id: "departures-10", title: "Fahrdienstleiter", text: "Zehn Fahrplanfahrten abschließen.", points: 30, stat: "departures", goal: 10 },
];

export interface Unlock { at: number; seq: number }
interface Saved { stats: Stats; unlocked: Record<string, Unlock>; seq: number }

const EMPTY = (): Saved => ({ stats: { starts: 0, stops: 0, estops: 0, departures: 0 }, unlocked: {}, seq: 0 });
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e9 ? (v as number) : 0);
const known = new Set(DEFINITIONS.map((d) => d.id));

/** Prüft einen gespeicherten oder gesicherten Stand; unbekannte Erfolge werden verworfen. */
export function parseAchievements(raw: unknown): Saved {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("Erfolge: ungültiger Stand"), { statusCode: 400 });
  const r = raw as Record<string, unknown>;
  const s = (r.stats ?? {}) as Record<string, unknown>;
  const out = EMPTY();
  out.stats = { starts: count(s.starts), stops: count(s.stops), estops: count(s.estops), departures: count(s.departures) };
  const u = r.unlocked && typeof r.unlocked === "object" ? (r.unlocked as Record<string, Partial<Unlock>>) : {};
  for (const [id, v] of Object.entries(u)) if (known.has(id)) out.unlocked[id] = { at: count(v?.at), seq: 0 };
  // Reihenfolge nach Zeit neu nummerieren
  Object.entries(out.unlocked).sort((a, b) => a[1].at - b[1].at).forEach(([id], i) => { out.unlocked[id].seq = i + 1; });
  out.seq = Object.keys(out.unlocked).length;
  return out;
}

export interface AchievementView {
  score: number;
  maxScore: number;
  stats: Stats;
  items: { id: string; title: string; text: string; points: number; progress: number; goal: number; unlockedAt?: number }[];
  /** Zähler der Freischaltungen; wächst mit jedem neuen Erfolg (Browser blenden bei Zuwachs ein). */
  seq: number;
  /** Zuletzt freigeschalteter Erfolg */
  latest?: { id: string; title: string; text: string; points: number };
}

export class AchievementStore {
  private state: Saved = EMPTY();
  private file: JsonFile<Saved>;
  private seenDone = new Set<string>();

  constructor(file: string | undefined, private onUnlock: () => void = () => {}) {
    this.file = new JsonFile(file);
    const raw = this.file.read();
    if (raw) { try { this.state = parseAchievements(raw); } catch (e) { console.error("achievements.json ignoriert:", (e as Error).message); } }
  }

  /** Eine Zahl erhöhen; liefert die dabei freigeschalteten Erfolge. */
  add(stat: StatKey, n = 1, now = Date.now()): Definition[] {
    this.state.stats[stat] += n;
    const fresh: Definition[] = [];
    for (const d of DEFINITIONS) {
      if (d.stat === stat && !this.state.unlocked[d.id] && this.state.stats[stat] >= d.goal) {
        this.state.unlocked[d.id] = { at: now, seq: ++this.state.seq };
        fresh.push(d);
      }
    }
    this.file.write(() => this.state);
    if (fresh.length) this.onUnlock();
    return fresh;
  }

  /** Ereignisse einer Lok (aus der Ereigniserkennung der Automatismen). */
  onLocoEvents(events: LocoEvent[]) {
    for (const e of events) {
      if (e.type === "start") this.add("starts");
      else if (e.type === "stop") this.add("stops");
      else if (e.type === "estop") this.add("estops");
    }
  }

  /** Abgeschlossene Fahrplanfahrten; jede Fahrt (Tag + id) zählt einmal. */
  onInstances(instances: { id: string; day: number; status: string }[]) {
    for (const i of instances) {
      const key = `${i.day}:${i.id}`;
      if (i.status === "done" && !this.seenDone.has(key)) { this.seenDone.add(key); this.add("departures"); }
    }
    if (this.seenDone.size > 2000) this.seenDone.clear();
  }

  view(): AchievementView {
    const items = DEFINITIONS.map((d) => ({
      id: d.id, title: d.title, text: d.text, points: d.points, goal: d.goal,
      progress: Math.min(d.goal, this.state.stats[d.stat]), unlockedAt: this.state.unlocked[d.id]?.at,
    }));
    const latestId = Object.entries(this.state.unlocked).sort((a, b) => b[1].seq - a[1].seq)[0]?.[0];
    const latest = DEFINITIONS.find((d) => d.id === latestId);
    return {
      score: items.filter((i) => i.unlockedAt !== undefined).reduce((s, i) => s + i.points, 0),
      maxScore: items.reduce((s, i) => s + i.points, 0),
      stats: { ...this.state.stats }, items, seq: this.state.seq,
      latest: latest && { id: latest.id, title: latest.title, text: latest.text, points: latest.points },
    };
  }

  /** Alles zurücksetzen (Verwaltung). Bereits abgeschlossene Fahrten zählen danach nicht erneut. */
  reset() {
    this.state = EMPTY();
    this.file.write(() => this.state);
    this.onUnlock();
  }

  export(): Saved { return JSON.parse(JSON.stringify(this.state)) as Saved; }

  replace(saved: Saved) {
    this.state = saved;
    this.file.write(() => this.state);
    this.onUnlock();
  }
}

export function registerAchievementRoutes(app: FastifyInstance, store: AchievementStore) {
  app.get("/api/achievements", async () => store.view());
  app.post("/api/achievements/reset", async () => { store.reset(); return store.view(); });
}
