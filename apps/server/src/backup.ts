import type { FastifyInstance } from "fastify";
import { validateLayout, type Layout } from "@z21/protocol";
import { validateSettings, validateTrains, validateTrips, type Train, type Trip } from "@z21/timetable";
import type { Camera, CameraStore } from "./cameras.js";
import { parseGarage, type Garage, type GarageLoco } from "./garage.js";
import type { SignalBox } from "./layout.js";
import type { TimetableRunner } from "./timetable.js";
import type { TrainStore } from "./trains.js";

/**
 * Backup of everything the user maintains in this application and that is NOT stored on the command station:
 *  - garage: locos added by hand or found by the scan, their names and function labels
 *  - layout: track diagram, blocks and routes
 *  - cameras: configured cameras (passwords only on request)
 *  - trains and timetable: trains (without their location), trips and the lateness setting
 * Loco speeds, turnout positions, CVs, clock and network settings live on the Z21 and are not part of it.
 */
export const BACKUP_FORMAT = "z21-web-backup";
export const BACKUP_PARTS = ["garage", "layout", "cameras", "trains", "timetable"] as const;
export type BackupPart = (typeof BACKUP_PARTS)[number];

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  garage?: GarageLoco[];
  layout?: Layout;
  cameras?: Partial<Camera>[];
  trains?: Omit<Train, "location">[];
  timetable?: { trips: Trip[]; settings: { lateLimit: number } };
}

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export class BackupService {
  constructor(private garage: Garage, private box: SignalBox, private cameras: CameraStore, private trains: TrainStore, private timetable: TimetableRunner, private changed: () => void = () => {}) {}

  create(opts: { passwords?: boolean } = {}): Backup {
    return {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      garage: this.garage.list(),
      layout: this.box.get(),
      cameras: this.cameras.list().map((c) => (opts.passwords ? c : { ...c, password: undefined })),
      trains: this.trains.list().map(({ location: _l, ...t }) => t),
      timetable: { trips: this.timetable.get().trips, settings: { lateLimit: this.timetable.get().lateLimit } },
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

    // 2. apply
    const restored: Record<string, number> = {};
    if (garage) { this.garage.replaceAll(garage); restored.garage = garage.length; }
    if (layout) { this.box.save(layout); restored.layout = layout.tiles.length; }
    if (cameras !== undefined) restored.cameras = this.cameras.replaceAll(cameras).length;
    if (trains) { this.trains.replaceAll(trains); restored.trains = trains.length; }
    if (timetable) { this.timetable.replaceAll(timetable); restored.timetable = timetable.trips.length; }
    this.changed(); // browsers get the new state right away
    return { restored };
  }
}

export function registerBackupRoutes(app: FastifyInstance, service: BackupService) {
  // GET so the browser can simply download it; passwords only when asked for
  app.get<{ Querystring: { passwords?: string } }>("/api/backup", async (req, reply) => {
    const date = new Date().toISOString().slice(0, 10);
    reply.header("content-disposition", `attachment; filename="z21-web-backup-${date}.json"`).header("cache-control", "no-store");
    return service.create({ passwords: req.query.passwords === "1" });
  });
  app.post<{ Body: { backup?: unknown; parts?: string[] } }>("/api/backup/restore", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const parts = (req.body?.parts ?? [...BACKUP_PARTS]).filter((p): p is BackupPart => (BACKUP_PARTS as readonly string[]).includes(p));
    return service.restore(req.body?.backup, parts);
  });
}
