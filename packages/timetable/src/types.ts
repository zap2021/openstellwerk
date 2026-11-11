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
}

export interface Trip {
  id: string;
  trainId: string;
  routeId: string;
  departure: number;
  dwell: number;
  destination?: string;
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
