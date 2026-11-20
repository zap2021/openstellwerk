import { JsonFile } from "./json-file.js";

export interface LastConnection { host: string; port?: number }

/**
 * Merkt sich die zuletzt erfolgreich verbundene Zentrale (Adresse und Port) im Datenordner.
 * Nach einem Neustart verbindet sich der Server nicht von selbst; die Oberfläche trägt die Adresse aber wieder ein.
 */
export class ConnectionMemory {
  private file: JsonFile<LastConnection>;
  private last?: LastConnection;

  constructor(file?: string) {
    this.file = new JsonFile<LastConnection>(file);
    this.last = ConnectionMemory.valid(this.file.read());
  }

  private static valid(v: unknown): LastConnection | undefined {
    if (!v || typeof v !== "object") return undefined;
    const { host, port } = v as { host?: unknown; port?: unknown };
    if (typeof host !== "string" || host.trim() === "" || host.length > 253) return undefined;
    const p = typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
    return { host: host.trim(), ...(p ? { port: p } : {}) };
  }

  get(): LastConnection | undefined { return this.last; }

  /** Nach erfolgreichem Verbinden aufrufen. Ungültige Angaben werden ignoriert. */
  remember(host: unknown, port?: unknown): void {
    const next = ConnectionMemory.valid({ host, port });
    if (!next || (next.host === this.last?.host && next.port === this.last?.port)) return;
    this.last = next;
    this.file.write(() => next);
    try { this.file.flush(); } catch (e) { console.error("connection.json nicht gespeichert:", (e as Error).message); }
  }
}
