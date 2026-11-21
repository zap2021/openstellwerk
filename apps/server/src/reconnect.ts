import type { LastConnection } from "./connection-memory.js";

export type ReconnectResult = "already" | "connected";

const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/**
 * Stellt die Verbindung zur hinterlegten Zentrale wieder her. Es gibt je Installation genau eine Zentrale für alle Benutzer.
 * Läuft schon eine Verbindung oder der Demo-Modus, passiert nichts; mehrere gleichzeitige Aufrufe teilen sich einen Versuch.
 * Schlägt er fehl (Zentrale aus), ist ein späterer Aufruf wieder frei.
 */
export class Reconnector {
  private pending?: Promise<ReconnectResult>;

  constructor(private deps: {
    last: () => LastConnection | undefined;
    busy: () => boolean;
    connect: (host: string, port?: number) => Promise<void>;
  }) {}

  attempt(): Promise<ReconnectResult> {
    if (this.pending) return this.pending;
    if (this.deps.busy()) return Promise.resolve("already");
    const last = this.deps.last();
    if (!last) return Promise.reject(fail("Es ist noch keine Zentrale hinterlegt. Verbinde sie einmal in der Verwaltung.", 409));
    const p = this.deps.connect(last.host, last.port).then(
      () => "connected" as const,
      (e: Error) => { throw fail(`Die Zentrale ${last.host} antwortet nicht. Ist sie eingeschaltet? (${e.message})`, 504); },
    );
    this.pending = p.finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
