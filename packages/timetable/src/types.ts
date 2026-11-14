export type Status = "planned" | "waiting" | "set" | "running" | "done" | "failed" | "cancelled";

export interface TrainLocation {
  blockId: string;
  source: "manual" | "carried" | "detected";
  since: number;
  uncertain?: boolean;
}

export interface Train {
  id: string;
  name: string;
  number?: string;
  address: number;
  location?: TrainLocation;
  /** How the server drives this train by itself (journeys, trips with `drive`). Without it: defaults. */
  drive?: TrainDrive;
}

export interface TrainDrive {
  /** cruising speed, speed step 1..126 */
  speed: number;
  /** after entering the target block: crawl this long, then stop (ms). Used when no stop distance can be computed. */
  stopDelayMs?: number;
  /** after entering the target block: stop after this distance (cm); needs a speed calibration of the loco */
  stopCm?: number;
}

export const DEFAULT_DRIVE = { speed: 40, stopDelayMs: 1500 } as const;

export interface Trip {
  id: string;
  trainId: string;
  routeId: string;
  departure: number;
  dwell: number;
  destination?: string;
  /** The server drives the loco in this direction once the route is set; without it the operator drives. */
  drive?: "forward" | "reverse";
  repeat?: { every: number; until: number };
}

export interface Instance {
  id: string;
  tripId: string;
  day: number;
  due: number;
  status: Status;
  reason?: string;
  since: number;
}

export interface ClockState {
  running: boolean;
  factor: number;
  baseModel: number;
  baseReal: number;
}

export interface TimetableSnapshot {
  clock: ClockState;
  lateLimit: number;
  trains: Train[];
  instances: Instance[];
  /** Server clock (ms epoch) when the snapshot was built: browsers run the model clock on server time. */
  serverNow?: number;
}
