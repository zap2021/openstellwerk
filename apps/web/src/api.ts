import { useEffect, useState } from "react";
import type { Layout } from "@z21/protocol/layout";
import type { TimetableSnapshot } from "@z21/timetable";

export type MonitorKind = "railcom" | "loconet" | "detectors" | "rmbus" | "boosters" | "clock";

export interface BoosterOutput {
  nid: number; outputPort: number; shortCircuit: boolean; trackVoltageOff: boolean; outputDisabled: boolean;
  railComActive: boolean; brakeGenerator: boolean; voltage: number; current: number; ts: number;
}

export interface BoosterSystemState {
  current: [number, number]; temperature: [number, number]; supplyVoltage: number; voltage: [number, number];
  trackVoltageOff: boolean; shortCircuit: [boolean, boolean]; outputDisabled: [boolean, boolean]; railComActive: [boolean, boolean];
}

export type DecoderState =
  | {
      kind: "switch"; voltage: number; current: number; address: number; address2: number; trackVoltageOff: boolean; shortCircuit: boolean; configMode: boolean;
      outputs: { state: string; config: string; dimm: number }[];
    }
  | {
      kind: "signal"; voltage: number; address: number; signalCount: number; trackVoltageOff: boolean; shortCircuit: boolean; configMode: boolean;
      outputsOn: boolean[]; outputsBlinking: boolean[];
      signals: { dccExt: number; aspectIndex: number; signalId: number; initAspect: number }[];
    };

export interface StationState {
  connected: boolean;
  host?: string;
  hw?: { hwName: string; fwVersion: string; hwType: number; kind: "z21" | "booster" | "decoder" };
  serial?: number;
  firmwareVersion?: string;
  unlockCode?: string | number;
  power?: "off" | "on" | "shortCircuit" | "programming" | "emergencyStop";
  systemState?: { mainCurrent: number; progCurrent: number; temperature: number; supplyVoltage: number; vccVoltage: number };
  locos: { address: number; speed: number; forward: boolean; functions: boolean[]; emergencyStop: boolean; busy: boolean }[];
  turnouts: Record<number, string>;
  monitors: Record<MonitorKind, boolean>;
  railcom: { address: number; receiveCounter: number; errorCounter: number; speed?: number; qos?: number; ts: number }[];
  loconetDetectors: { feedbackAddress: number; occupied: boolean; locoAddress?: number; forward?: boolean; speed?: number; ts: number }[];
  canDetectors: {
    nid: number;
    moduleAddress: number;
    ports: { port: number; occupied: boolean; voltage: boolean; overload: number; locos: { address: number; direction: string }[] }[];
    ts: number;
  }[];
  rmbus: { module: number; inputs: boolean[] }[];
  clock?: {
    time?: { weekday: number; hour: number; minute: number; second: number; rate: number; stopped: boolean; halted: boolean; settings: number };
    settings?: { settings: number; rate: number; startWeekday: number; startHour: number; startMinute: number };
  };
  canBoosters: { nid: number; name?: string; outputs: BoosterOutput[] }[];
  device?: { name?: string; link?: { hwId: number; fwVersion: string; mac: string; name: string }; boosterState?: BoosterSystemState; decoderState?: DecoderState };
  extAccessories: Record<number, number>;
  modes: { loco: Record<number, string>; turnout: Record<number, string> };
  garage: GarageLoco[];
  layout?: Layout;
  timetable?: TimetableSnapshot;
  achievements?: AchievementView;
  routeRun?: { routeId: string; done: number; total: number; running: boolean; error?: string };
  /** Interlocked routes that are not idle (mirrors RouteState of @z21/interlocking). */
  /** true while the built-in simulator stands in for a real command station */
  demo?: boolean;
  interlocking?: { routeId: string; status: "setting" | "set" | "running" | "fault"; since: number; message?: string }[];
  scan?: { running: boolean; from: number; to: number; current: number; found: number[]; error?: string };
  /** installierte und neueste Version (apps/server/src/update.ts) */
  update?: { current: string; latest?: string; available: boolean };
  /** Abläufe mit Taster: Regeln der Anlage mit Auslöser „von Hand“ */
  macros?: { id: string; name: string }[];
  /** Zielfahrten (Spiegel von apps/server/src/journeys.ts) */
  journeys?: Journey[];
  /** Loks, die der Server gerade fährt, und wie die letzten Fahrten endeten (apps/server/src/auto-drive.ts) */
  autoDrive?: { jobs: { trainId: string; address: number; routeId: string; phase: "waiting" | "driving" | "braking" }[]; results: { trainId: string; routeId: string; ok: boolean; text: string; ts: number }[] };
  /** Kennlinien je Lokadresse und die laufende Messreihe (apps/server/src/calibration.ts) */
  calibration?: { tables: Record<string, Calibration>; run?: MeasureView };
}

export interface Journey {
  id: string; trainId: string; targetBlockId: string; routeIds: string[]; leg: number;
  status: "waiting" | "set" | "done" | "failed" | "cancelled"; drive?: "forward" | "reverse"; reason?: string; since: number;
}
export interface SpeedPoint { step: number; cmPerSec: number }
export interface Calibration { scale: number; points: SpeedPoint[] }
export interface MeasureView { address: number; steps: number[]; index: number; phase?: "approach" | "measure" | "settle" | "return" | "runout"; running: boolean; results: SpeedPoint[]; error?: string }

export interface GarageLoco {
  address: number;
  name?: string;
  sources: ("scan" | "prog" | "manual" | "railcom" | "detector" | "active")[];
  functionNames: Record<number, string>;
  lastSeen?: number;
  /** version of the loco's picture (ms timestamp); absent = no picture */
  imageVersion?: number;
}

export interface LocoNetLine {
  ts: number;
  direction: "rx" | "tx" | "lan";
  bytes: number[];
  decoded: { opcode: string; text: string; checksumOk: boolean };
}

export interface WireLine { dir: "tx" | "rx"; hex: string; message?: { type: string }; ts: number }

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith("/api/login")) window.dispatchEvent(new Event("z21-unauthorized"));
  if (!res.ok) throw new Error(json.message ?? res.statusText);
  return json as T;
}

/** Live station state + wire log via WebSocket (auto-reconnects). */
export function useStation() {
  const [state, setState] = useState<StationState>();
  const [wire, setWire] = useState<WireLine[]>([]);
  const [loconet, setLoconet] = useState<LocoNetLine[]>([]);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: number | undefined;
    let closed = false;
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setOnline(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.kind === "state") setState(m.state);
        else if (m.kind === "loconet") setLoconet((l) => [...l.slice(-499), m.line]);
        else if (m.kind === "wire") setWire((w) => [...w.slice(-299), m.wire]);
      };
      ws.onclose = () => {
        setOnline(false);
        if (!closed) timer = window.setTimeout(open, 1500);
      };
    };
    open();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, []);

  return { state, wire, loconet, online, clearWire: () => setWire([]), clearLoconet: () => setLoconet([]) };
}

export interface Camera {
  id: string;
  name: string;
  kind: "mjpeg" | "snapshot" | "iframe";
  url: string;
  username?: string;
  hasPassword: boolean;
  refreshMs?: number;
  insecureTls?: boolean;
}

/** Erfolge der Anlage (Spiegel von apps/server/src/achievements.ts). */
export interface SessionUser { id: string; name: string; displayName: string; role: "user" | "admin"; active: boolean; createdAt: number }

export interface AchievementView {
  score: number;
  maxScore: number;
  stats: { starts: number; stops: number; estops: number; departures: number };
  items: { id: string; title: string; text: string; points: number; progress: number; goal: number; unlockedAt?: number }[];
  seq: number;
  latest?: { id: string; title: string; text: string; points: number; by?: string };
  ranking: { userId: string; name: string; score: number }[];
}
