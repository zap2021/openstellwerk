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

const bad = () => Object.assign(new Error("Erfolge: ungültiger Stand"), { statusCode: 400 });

/** Stand der Anlage und je Benutzer. */
export interface Data { anlage: Saved; users: Record<string, Saved> }

/**
 * Prüft einen gespeicherten oder gesicherten Stand; unbekannte Erfolge werden verworfen.
 * Das ältere Format (nur ein Stand der Anlage) wird als Stand der Anlage übernommen.
 */
export function parseAchievements(raw: unknown): Data {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const r = raw as Record<string, unknown>;
  if (!("anlage" in r) && !("users" in r)) return { anlage: parseScope(raw), users: {} };
  const users: Record<string, Saved> = {};
  const u = r.users && typeof r.users === "object" && !Array.isArray(r.users) ? (r.users as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(u)) users[id] = parseScope(v);
  return { anlage: parseScope(r.anlage ?? {}), users };
}

function parseScope(raw: unknown): Saved {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad();
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

export interface AchievementItem { id: string; title: string; text: string; points: number; progress: number; goal: number; unlockedAt?: number }
export interface Announcement { id: string; title: string; text: string; points: number; /** Anzeigename des Benutzers, dem der Erfolg gehört */ by?: string }

export interface AchievementView {
  score: number;
  maxScore: number;
  stats: Stats;
  items: AchievementItem[];
  /** Zähler der Freischaltungen; wächst mit jedem neuen Erfolg (Browser blenden bei Zuwachs ein). */
  seq: number;
  /** Zuletzt freigeschalteter Erfolg (Anlage oder Benutzer) */
  latest?: Announcement;
  /** Rangliste der Benutzer nach Punkten */
  ranking: { userId: string; name: string; score: number }[];
}

/** Wie lange eine Fahrbefehl-Zuordnung zu einem Benutzer gilt: die Z21 meldet die Folge (anfahren, halten) erst später zurück. */
const ACTOR_MS = 15_000;

const scopeView = (saved: Saved): Omit<AchievementView, "seq" | "latest" | "ranking"> => {
  const items = DEFINITIONS.map((d) => ({
    id: d.id, title: d.title, text: d.text, points: d.points, goal: d.goal,
    progress: Math.min(d.goal, saved.stats[d.stat]), unlockedAt: saved.unlocked[d.id]?.at,
  }));
  return {
    score: items.filter((i) => i.unlockedAt !== undefined).reduce((s, i) => s + i.points, 0),
    maxScore: items.reduce((s, i) => s + i.points, 0),
    stats: { ...saved.stats }, items,
  };
};

export class AchievementStore {
  private data: Data = { anlage: EMPTY(), users: {} };
  private file: JsonFile<Data>;
  private seenDone = new Set<string>();
  private actors = new Map<number, { userId: string; at: number }>();
  private announceSeq = 0;
  private latest?: Announcement;

  /** `nameOf` liefert den Anzeigenamen eines Benutzers (undefined = Konto gibt es nicht mehr). */
  constructor(file: string | undefined, private onUnlock: () => void = () => {}, private nameOf: (userId: string) => string | undefined = () => undefined) {
    this.file = new JsonFile(file);
    const raw = this.file.read();
    if (raw) { try { this.data = parseAchievements(raw); } catch (e) { console.error("achievements.json ignoriert:", (e as Error).message); } }
    this.announceSeq = this.countUnlocks();
  }

  private countUnlocks() { return Object.keys(this.data.anlage.unlocked).length + Object.values(this.data.users).reduce((n, u) => n + Object.keys(u.unlocked).length, 0); }

  private bump(saved: Saved, stat: StatKey, n: number, now: number): Definition[] {
    saved.stats[stat] += n;
    const fresh: Definition[] = [];
    for (const d of DEFINITIONS) {
      if (d.stat === stat && !saved.unlocked[d.id] && saved.stats[stat] >= d.goal) {
        saved.unlocked[d.id] = { at: now, seq: ++saved.seq };
        fresh.push(d);
      }
    }
    return fresh;
  }

  /** Eine Zahl erhöhen: immer für die Anlage, zusätzlich für den Benutzer, dem die Aktion gehört. Liefert die freigeschalteten Erfolge. */
  add(stat: StatKey, n = 1, userId?: string, now = Date.now()): Definition[] {
    const anlage = this.bump(this.data.anlage, stat, n, now);
    let mine: Definition[] = [];
    if (userId) mine = this.bump((this.data.users[userId] ??= EMPTY()), stat, n, now);
    this.file.write(() => this.data);
    const shown = mine.length ? mine : anlage;
    const d = shown[shown.length - 1];
    if (d) {
      this.announceSeq += anlage.length + mine.length;
      this.latest = { id: d.id, title: d.title, text: d.text, points: d.points, by: mine.length && userId ? this.nameOf(userId) : undefined };
      this.onUnlock();
    }
    return [...anlage, ...mine];
  }

  /** Merkt, wer zuletzt einen Fahrbefehl für diese Lok gegeben hat. */
  touch(address: number, userId: string, now = Date.now()) {
    this.actors.set(address, { userId, at: now });
    if (this.actors.size > 500) this.actors.delete(this.actors.keys().next().value!);
  }

  actorOf(address: number, now = Date.now()): string | undefined {
    const a = this.actors.get(address);
    return a && now - a.at <= ACTOR_MS ? a.userId : undefined;
  }

  /** Ereignisse einer Lok (aus der Ereigniserkennung der Automatismen); `userId` = wer den Befehl gegeben hat, sonst nur Anlage. */
  onLocoEvents(events: LocoEvent[], userId?: string) {
    for (const e of events) {
      if (e.type === "start") this.add("starts", 1, userId);
      else if (e.type === "stop") this.add("stops", 1, userId);
      else if (e.type === "estop") this.add("estops", 1, userId);
    }
  }

  /** Abgeschlossene Fahrplanfahrten; jede Fahrt (Tag + id) zählt einmal (für die Anlage). */
  onInstances(instances: { id: string; day: number; status: string }[]) {
    for (const i of instances) {
      const key = `${i.day}:${i.id}`;
      if (i.status === "done" && !this.seenDone.has(key)) { this.seenDone.add(key); this.add("departures"); }
    }
    if (this.seenDone.size > 2000) this.seenDone.clear();
  }

  /** Anlage mit Rangliste (geht an alle Browser). */
  view(): AchievementView {
    const ranking = Object.entries(this.data.users)
      .flatMap(([userId, s]) => { const name = this.nameOf(userId); return name === undefined ? [] : [{ userId, name, score: scopeView(s).score }]; })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { ...scopeView(this.data.anlage), seq: this.announceSeq, latest: this.latest, ranking };
  }

  /** Persönliche Erfolge eines Benutzers. */
  viewOf(userId: string): AchievementView {
    return { ...scopeView(this.data.users[userId] ?? EMPTY()), seq: this.announceSeq, latest: this.latest, ranking: this.view().ranking };
  }

  /** Zurücksetzen (Verwaltung): ein Benutzer, oder ohne Angabe alles (Anlage und alle Benutzer). */
  reset(userId?: string) {
    if (userId) delete this.data.users[userId];
    else { this.data = { anlage: EMPTY(), users: {} }; this.announceSeq = 0; this.latest = undefined; }
    this.file.write(() => this.data);
    this.onUnlock();
  }

  export(): Data { return JSON.parse(JSON.stringify(this.data)) as Data; }

  replace(data: Data) {
    this.data = data;
    this.announceSeq = this.countUnlocks();
    this.latest = undefined;
    this.file.write(() => this.data);
    this.onUnlock();
  }
}

export function registerAchievementRoutes(app: FastifyInstance, store: AchievementStore) {
  app.get("/api/achievements", async () => store.view());
  app.get("/api/achievements/me", async (req) => (req.user ? store.viewOf(req.user.id) : store.view()));
  app.post<{ Body: { userId?: string } }>("/api/achievements/reset", async (req) => {
    const id = req.body?.userId;
    store.reset(typeof id === "string" && id ? id : undefined);
    return store.view();
  });
}
