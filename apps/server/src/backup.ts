import type { FastifyInstance } from "fastify";
import { validateLayout, type Layout } from "@z21/protocol";
import { validateSettings, validateTrains, validateTrips, type Train, type Trip } from "@z21/timetable";
import type { Camera, CameraStore } from "./cameras.js";
import { parseGarage, type Garage, type GarageLoco } from "./garage.js";
import { checkJpeg, parseAddress, syncGarageImages, type LocoImageStore } from "./loco-images.js";
import type { SignalBox } from "./layout.js";
import type { TimetableRunner } from "./timetable.js";
import type { TrainStore } from "./trains.js";
import { AutomationStore, type Automation } from "./automations.js";
import { CalibrationStore, type Calibration } from "./calibration.js";
import { validateRules, type LayoutRule, type LayoutRuleStore } from "./layout-rules.js";
import { parseAchievements, type AchievementStore } from "./achievements.js";
import { parseUsers, type User, type UserStore } from "./users.js";

/**
 * Backup of everything the user maintains in this application and that is NOT stored on the command station:
 *  - garage: locos added by hand or found by the scan, their names and function labels
 *  - layout: track diagram, blocks and routes
 *  - cameras: configured cameras (passwords only on request)
 *  - trains and timetable: trains (without their location), trips and the lateness setting
 *  - automations: per-loco triggers, conditions and actions
 *  - layoutRules: rules of the layout (a detector triggers turnouts, signals, routes or a loco stop)
 *  - calibration: measured speed tables of the locos
 *  - achievements: score and counters of the layout and of each user
 *  - users: accounts with roles and password hashes (never plain passwords); a backup needs at least one active admin
 * Loco speeds, turnout positions, CVs, clock and network settings live on the Z21 and are not part of it.
 */
export const BACKUP_FORMAT = "z21-web-backup";
export const BACKUP_PARTS = ["garage", "layout", "cameras", "trains", "timetable", "locoImages", "automations", "layoutRules", "calibration", "achievements", "users"] as const;
export type BackupPart = (typeof BACKUP_PARTS)[number];

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  garage?: GarageLoco[];
  layout?: Layout;
  cameras?: Partial<Camera>[];
  trains?: Omit<Train, "location">[];
  /** address → base64 of the small JPEG; only present when there are pictures (and they were asked for) */
  locoImages?: Record<string, string>;
  timetable?: { trips: Trip[]; settings: { lateLimit: number } };
  automations?: Record<string, Automation[]>;
  /** rules of the layout (detector → turnout, signal, route, loco stop) */
  layoutRules?: LayoutRule[];
  /** speed tables per loco address */
  calibration?: Record<string, Calibration>;
  achievements?: ReturnType<AchievementStore["export"]>;
  users?: User[];
}

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export class BackupService {
  constructor(private garage: Garage, private box: SignalBox, private cameras: CameraStore, private trains: TrainStore, private timetable: TimetableRunner, private images: LocoImageStore, private changed: () => void = () => {}, private extras: { automations?: AutomationStore; achievements?: AchievementStore; users?: UserStore; layoutRules?: LayoutRuleStore; calibration?: CalibrationStore } = {}) {}

  create(opts: { passwords?: boolean; images?: boolean } = {}): Backup {
    const locoImages: Record<string, string> = {};
    if (opts.images !== false) for (const l of this.garage.list()) { const bytes = this.images.get(l.address); if (bytes) locoImages[l.address] = bytes.toString("base64"); }
    return {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      garage: this.garage.list(),
      layout: this.box.get(),
      cameras: this.cameras.list().map((c) => (opts.passwords ? c : { ...c, password: undefined })),
      trains: this.trains.list().map(({ location: _l, ...t }) => t),
      timetable: { trips: this.timetable.get().trips, settings: { lateLimit: this.timetable.get().lateLimit } },
      ...(Object.keys(locoImages).length ? { locoImages } : {}),
      ...(this.extras.automations ? { automations: this.extras.automations.all() } : {}),
      ...(this.extras.layoutRules?.list().length ? { layoutRules: this.extras.layoutRules.list() } : {}),
      ...(this.extras.calibration && Object.keys(this.extras.calibration.all()).length ? { calibration: this.extras.calibration.all() } : {}),
      ...(this.extras.achievements ? { achievements: this.extras.achievements.export() } : {}),
      ...(this.extras.users && this.extras.users.count() ? { users: this.extras.users.all() } : {}),
    };
  }

  /**
   * Restore the chosen parts. Everything is checked before anything is replaced: if one part is bad, nothing changes.
   * @returns what was restored, for the confirmation message
   */
  restore(input: unknown, parts: readonly BackupPart[] = BACKUP_PARTS): { restored: Record<string, number> } {
    const b = (input ?? {}) as Record<string, unknown>;
    if (b.format !== BACKUP_FORMAT) throw httpError(400, "Das ist keine Sicherungsdatei dieser Anwendung");
    if (b.version !== 1) throw httpError(400, `Sicherungsversion ${String(b.version)} wird nicht unterstützt`);
    const chosen = parts.filter((p) => b[p] !== undefined);
    if (!chosen.length) throw httpError(400, "Die Datei enthält nichts von dem, was wiederhergestellt werden soll");

    // 1. check everything
    const check = (fn: () => unknown) => { try { return fn(); } catch (e) { throw httpError(400, (e as Error).message); } };
    const garage = chosen.includes("garage") ? (check(() => parseGarage(b.garage)) as GarageLoco[]) : undefined;
    const layout = chosen.includes("layout") ? (check(() => validateLayout(b.layout)) as Layout) : undefined;
    const cameras = chosen.includes("cameras") ? b.cameras : undefined;
    if (cameras !== undefined) this.cameras.check(cameras);
    if (layout && this.box.routeStates().length) throw httpError(409, "Es sind noch Fahrstraßen angefordert; zuerst auflösen");

    const t = (b.timetable ?? {}) as Record<string, unknown>;
    const layoutAfter = layout ?? this.box.get();
    const trains = chosen.includes("trains")
      ? (check(() => validateTrains(b.trains, { blockIds: new Set((layoutAfter.blocks ?? []).map((x) => x.id)) })) as Train[])
      : undefined;
    const trainIds = new Set((trains ?? this.trains.list()).map((x) => x.id));
    const routeIds = new Set((layoutAfter.routes ?? []).map((r) => r.id));
    let timetable: { trips: Trip[]; lateLimit: number } | undefined;
    if (chosen.includes("timetable")) {
      const trips = check(() => validateTrips(t.trips, { trainIds, routeIds })) as Trip[];
      const settings = check(() => validateSettings(t.settings)) as { lateLimit: number };
      timetable = { trips, lateLimit: settings.lateLimit };
      if (this.timetable.hasRunningDeparture()) throw httpError(409, "Es läuft gerade eine Fahrt; zuerst beenden");
    } else if (trains) {
      const orphan = this.timetable.get().trips.find((x) => !trainIds.has(x.trainId));
      if (orphan) throw httpError(400, `Fahrt ${orphan.id} verweist auf einen Zug, den es nach der Wiederherstellung nicht mehr gibt`);
    }
    if (layout && !timetable) {
      // The trips stay as they are, so they must still fit the routes of the layout that replaces the current one.
      const orphan = this.timetable.get().trips.find((x) => !routeIds.has(x.routeId));
      if (orphan) throw httpError(400, `Fahrt ${orphan.id} verweist auf eine Fahrstraße, die es nach der Wiederherstellung nicht mehr gibt`);
    }

    // Pictures belong to locos that exist after the restore: the garage of the file if it is restored, else the current one.
    const locoImages = chosen.includes("locoImages")
      ? (check(() => parseLocoImages(b.locoImages, new Set((garage ?? this.garage.list()).map((l) => l.address)))) as Map<number, Buffer>)
      : undefined;

    const automations = chosen.includes("automations") && this.extras.automations ? (check(() => AutomationStore.parseAll(b.automations)) as ReturnType<typeof AutomationStore.parseAll>) : undefined;
    const layoutRules = chosen.includes("layoutRules") && this.extras.layoutRules ? (check(() => validateRules(b.layoutRules)) as LayoutRule[]) : undefined;
    const calibration = chosen.includes("calibration") && this.extras.calibration ? (check(() => CalibrationStore.parseAll(b.calibration)) as Map<number, Calibration>) : undefined;
    const achievements = chosen.includes("achievements") && this.extras.achievements ? (check(() => parseAchievements(b.achievements)) as ReturnType<typeof parseAchievements>) : undefined;

    const users = chosen.includes("users") && this.extras.users ? (check(() => parseUsers(b.users)) as User[]) : undefined;
    if (users && users.length === 0) throw httpError(400, "Die Sicherung enthält keine Benutzer");

    // 2. apply. Garage and pictures (files) are the parts that can fail on disk: if one of them does, put both back as they were.
    const garageBefore = this.garage.list();
    const imagesBefore = new Map(this.images.addresses().map((a) => [a, this.images.get(a)!] as const));
    const restored: Record<string, number> = {};
    try {
      if (garage) { this.garage.replaceAll(garage); restored.garage = garage.length; }
      if (locoImages) {
        for (const a of this.images.addresses()) if (!locoImages.has(a)) this.images.remove(a);
        for (const [a, bytes] of locoImages) this.images.set(a, bytes);
        restored.locoImages = locoImages.size;
      }
      if (garage || locoImages) syncGarageImages(this.garage, this.images); // versions of the pictures, pictures of locos that are gone
    } catch (e) {
      this.rollbackGarageAndImages(garageBefore, imagesBefore);
      throw e;
    }
    if (layout) { this.box.save(layout); restored.layout = layout.tiles.length; }
    if (cameras !== undefined) restored.cameras = this.cameras.replaceAll(cameras).length;
    if (trains) { this.trains.replaceAll(trains); restored.trains = trains.length; }
    if (timetable) { this.timetable.replaceAll(timetable); restored.timetable = timetable.trips.length; }
    if (automations) { this.extras.automations!.replaceAll(automations); restored.automations = [...automations.values()].reduce((n, l) => n + l.length, 0); }
    if (layoutRules) { this.extras.layoutRules!.replaceAll(layoutRules); restored.layoutRules = layoutRules.length; }
    if (calibration) { this.extras.calibration!.replaceAll(calibration); restored.calibration = calibration.size; }
    if (achievements) { this.extras.achievements!.replace(achievements); restored.achievements = Object.keys(achievements.anlage.unlocked).length + Object.keys(achievements.users).length; }
    if (users) { this.extras.users!.replaceAll(users); restored.users = users.length; }
    this.changed(); // browsers get the new state right away
    return { restored };
  }

  /** Best effort: bring garage and picture files back to what they were before a failed restore. */
  private rollbackGarageAndImages(garage: GarageLoco[], images: Map<number, Buffer>) {
    try {
      for (const a of this.images.addresses()) if (!images.has(a)) this.images.remove(a);
      for (const [a, bytes] of images) if (!this.images.get(a)?.equals(bytes)) this.images.set(a, bytes);
      this.garage.replaceAll(garage);
    } catch { /* the original error is the one to report */ }
  }
}

/** Strict check of the pictures in a backup file: known address, valid base64, a real small JPEG. */
function parseLocoImages(raw: unknown, addresses: Set<number>): Map<number, Buffer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Lok-Bilder: Liste erwartet");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 1000) throw new Error("Lok-Bilder: zu viele Einträge");
  const out = new Map<number, Buffer>();
  for (const [key, value] of entries) {
    const address = parseAddress(key);
    if (!addresses.has(address)) throw new Error(`Lok-Bild ${address}: Diese Lok gibt es nach der Wiederherstellung nicht`);
    if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`Lok-Bild ${address}: kein gültiges Base64`);
    try { out.set(address, checkJpeg(Buffer.from(value, "base64"))); } catch (e) { throw new Error(`Lok-Bild ${address}: ${(e as Error).message}`); }
  }
  return out;
}

export function registerBackupRoutes(app: FastifyInstance, service: BackupService) {
  // GET so the browser can simply download it; passwords only when asked for
  app.get<{ Querystring: { passwords?: string; images?: string } }>("/api/backup", async (req, reply) => {
    const date = new Date().toISOString().slice(0, 10);
    reply.header("content-disposition", `attachment; filename="z21-web-backup-${date}.json"`).header("cache-control", "no-store");
    return service.create({ passwords: req.query.passwords === "1", images: req.query.images !== "0" });
  });
  app.post<{ Body: { backup?: unknown; parts?: string[] } }>("/api/backup/restore", { bodyLimit: 300 * 1024 * 1024 }, async (req) => {
    const parts = (req.body?.parts ?? [...BACKUP_PARTS]).filter((p): p is BackupPart => (BACKUP_PARTS as readonly string[]).includes(p));
    return service.restore(req.body?.backup, parts);
  });
}
