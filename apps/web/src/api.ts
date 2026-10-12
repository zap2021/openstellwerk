import { useEffect, useState } from "react";

export interface StationState {
  connected: boolean;
  host?: string;
  hw?: { hwName: string; fwVersion: string };
  serial?: number;
  power?: "off" | "on" | "shortCircuit" | "programming" | "emergencyStop";
  systemState?: { mainCurrent: number; progCurrent: number; temperature: number; supplyVoltage: number; vccVoltage: number };
  locos: { address: number; speed: number; forward: boolean; functions: boolean[]; emergencyStop: boolean }[];
  turnouts: Record<number, string>;
}

export interface WireLine { dir: "tx" | "rx"; hex: string; message?: { type: string }; ts: number }

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? res.statusText);
  return json as T;
}

/** Live station state + wire log via WebSocket (auto-reconnects). */
export function useStation() {
  const [state, setState] = useState<StationState>();
  const [wire, setWire] = useState<WireLine[]>([]);
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

  return { state, wire, online, clearWire: () => setWire([]) };
}
