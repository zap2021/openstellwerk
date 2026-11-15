# Phase 2: Züge, Fahrplan und Abfahrtstafel – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Fahrplan stellt zur Abfahrtszeit gesicherte Fahrstraßen für Züge ein, geführt von einer Fahrplanuhr im Server; die Anzeige-Seite zeigt eine Abfahrtstafel.

**Architecture:** Reine Logik (Uhr, Takt, Zustandsautomat) im neuen Paket `packages/timetable` ohne I/O. Im Server verbinden `TrainStore` und `TimetableRunner` sie mit der Sicherung aus Phase 1 (`SignalBox.tryRequestRoute`); die Sicherung wird nie umgangen. Ein Snapshot-Feld `timetable` trägt Uhrparameter, Züge und Instanzen zur Oberfläche.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, Fastify 5, React 18, Vitest 5, npm Workspaces.

**Spec:** `docs/superpowers/specs/2026-11-11-phase2-fahrplan-zuege-abfahrtstafel-design.md`

## Global Constraints

- Alle Meldungen an Benutzer sind deutsch; Fehler wie bei `validateLayout` als `Error` mit lesbarem Text, in HTTP-Routen als `statusCode` 400/404/409 (`Object.assign(new Error(msg), { statusCode })`).
- Ids: `/^[A-Za-z0-9_-]{1,24}$/`. Zug: `name` 1..40 Zeichen, `number` max. 12, `address` 1..9999, höchstens ein Zug je Lokadresse.
- Fahrt: `departure` 0..1439 (Minuten seit 00:00 Modellzeit), `dwell` 0..120, `repeat.every` 1..1439, `repeat.until` ≥ `departure` und ≤ 1439, höchstens 200 Abfahrten je Tag.
- Fahrplanuhr: `factor` 1..120 (ganzzahlig), Standard 1; wird beim Laden immer gestoppt. `lateLimit` 1..120 Modellminuten, Standard 5.
- Snapshot-Feld `timetable.instances`: nicht beendete plus die letzten 5 beendeten, höchstens 40, nach Abfahrt sortiert. Der Snapshot enthält keine Uhrzeit pro Sekunde.
- Nach Neustart: Uhr gestoppt, alle Standorte `uncertain: true`, keine Instanzen.
- Backup-Format bleibt `version: 1`; `trains` (ohne Standort) und `timetable` (`{ trips, settings }`) sind optionale Teile.
- Demo-Modus: Fahrplanuhr Faktor 20, Beispieldaten aus `docs/beispiel-fahrplan.json` nur, wenn Züge und Fahrten leer sind.
- Jeder Commit endet mit `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Vor jedem Commit müssen `npm run typecheck` und `npx vitest run` grün sein.
- Neue Server-Testdateien brauchen eigene UDP-Ports (belegt: 21555–21557, 21561–21564, 21570, 21571); dieser Plan nimmt 21572–21579.

## Review Focus

Eingaben und Zustände, die die Spezifikation voraussetzt, die aber leicht durchrutschen; jede Zeile hat einen Test in der genannten Task.

1. Fahrplanuhr läuft über Mitternacht (23:59 → 00:00): Instanzen des neuen Tages beginnen `planned`, laufende Fahrten bleiben erhalten (Task 6).
2. Takt mit `until` vor `departure` oder mehr als 200 Abfahrten wird abgelehnt (Task 5).
3. Zwei Züge mit derselben Lokadresse und Löschen eines Zugs mit Fahrten (Task 7).
4. Fahrstraße oder Block wird nach dem Anlegen einer Fahrt gelöscht: die Instanz wird `failed` („Fahrstraße nicht mehr vorhanden“), nichts wirft (Tasks 6 und 8).
5. Bearbeiten oder Löschen einer Fahrt mit aktiver Instanz → 409; Snapshot bleibt bei sehr vielen Takt-Abfahrten auf 40 Instanzen begrenzt (Task 8).

---

## Dateiübersicht

| Datei | Verantwortung |
|---|---|
| `packages/timetable/src/types.ts` | Typen `Train`, `Trip`, `Instance`, `ClockState`, Eingabe-/Aktionstypen des Dispatchers |
| `packages/timetable/src/clock.ts` | Fahrplanuhr (rein) |
| `packages/timetable/src/format.ts` | `formatHHMM`, `parseHHMM`, `statusText` |
| `packages/timetable/src/validate.ts` | `validateTrains`, `validateTrips`, `validateSettings`, `departures` |
| `packages/timetable/src/dispatcher.ts` | Zustandsautomat der Instanzen |
| `apps/server/src/trains.ts` | `TrainStore`, `/api/trains` |
| `apps/server/src/timetable.ts` | `TimetableRunner`, `/api/timetable`, `/api/trips` |
| `apps/server/src/backup.ts` | Teile `trains`, `timetable` |
| `apps/web/src/trains.tsx`, `timetable.tsx` | Verwaltungsseiten, Bedien-Tab, Abfahrtstafel |
| `docs/beispiel-fahrplan.json` | Beispieldaten für die Demo |

---

### Task 1: `Station.addExtra` (mehrere Snapshot-Beiträge)

**Files:**
- Modify: `apps/server/src/station.ts` (Zeilen um 117–126 `extra`, um 186 `...this.extra()`)
- Modify: `apps/server/src/layout.ts` (Konstruktor, Zeile um 35)
- Test: `apps/server/src/station.test.ts`

**Interfaces:**
- Produces: `Station.addExtra(fn: () => Partial<StationState>): void`; `station.extra` entfällt.

- [ ] **Step 1: Failing test** in `station.test.ts`: `it("merges the parts of several modules into the snapshot")` – zwei `addExtra`-Funktionen (`{ demo: true }` und `{ routeRun: { routeId: "x", done: 0, total: 1, running: false } }`) erscheinen beide in `station.snapshot()`; ein später registrierter Beitrag überschreibt gleichnamige Felder des früheren nicht, sondern gewinnt (letzter gewinnt).
- [ ] **Step 2:** `npx vitest run apps/server/src/station.test.ts` – FAIL (`addExtra` nicht definiert).
- [ ] **Step 3: Implement** `addExtra` in `station.ts`: private Liste `extras: (() => Partial<StationState>)[]`, `snapshot()` mischt sie der Reihe nach über das Grundobjekt. `SignalBox` registriert sich mit `station.addExtra(() => ({ layout, routeRun, interlocking }))` statt `station.extra = …`.
- [ ] **Step 4:** `npx vitest run && npm run typecheck` – PASS (alle bestehenden Tests bleiben grün).
- [ ] **Step 5: Commit** `git commit -m "Station.addExtra: several modules contribute to the snapshot"`.

---

### Task 2: `Interlocking.drainEnded`

**Files:**
- Modify: `packages/interlocking/src/interlocking.ts` (Löschstellen Zeile ~158 in `step`, ~175 in `release`)
- Test: `packages/interlocking/src/interlocking.test.ts`

**Interfaces:**
- Produces: `type EndReason = "completed" | "released" | "forced" | "fault"`; `interface EndedRoute { routeId: string; reason: EndReason }`; `Interlocking.drainEnded(): EndedRoute[]` (liefert und leert die Liste).
- Gründe: reguläre Auflösung in `step` → `completed`; `release` auf Status `fault` → `fault`; `release(…, true)` auf `running` → `forced`; sonst `released`.

- [ ] **Step 1: Failing tests** (`describe("ended routes")`) mit dem vorhandenen Testlayout aus der Datei: (a) Zug durchfährt r1 → `drainEnded()` ist `[{ routeId: "r1", reason: "completed" }]`, ein zweiter Aufruf `[]`; (b) `release("r1")` einer eingestellten, unbefahrenen Fahrstraße → `released`; (c) `release("r1", true)` mit Zug darin → `forced`; (d) Störung (Weiche verstellt) dann `release("r1", true)` → `fault`; (e) `reset()` erzeugt kein Ereignis.
- [ ] **Step 2:** `npx vitest run packages/interlocking` – FAIL.
- [ ] **Step 3: Implement**: private Liste `ended`, an den beiden Löschstellen eintragen, `reset()` löscht Liste und Fahrstraßen ohne Ereignis.
- [ ] **Step 4:** `npx vitest run packages/interlocking` – PASS.
- [ ] **Step 5: Commit** `git commit -m "Interlocking: report how a route ended (drainEnded)"`.

---

### Task 3: `SignalBox.tryRequestRoute`, `drainEnded` und Halt beim ersten Verbinden

**Files:**
- Modify: `apps/server/src/layout.ts`
- Test: `apps/server/src/interlocking.test.ts`

**Interfaces:**
- Consumes: `Interlocking.drainEnded()`, `Interlocking.request` (Outcome `{ ok, reason? }`).
- Produces: `SignalBox.tryRequestRoute(id: string): { ok: true } | { ok: false; reason: string }` (wirft nie; nicht verbunden → `{ ok:false, reason:"Keine Verbindung zur Zentrale" }`); `SignalBox.drainEnded(): EndedRoute[]`; `requestRoute` bleibt und nutzt `tryRequestRoute`.
- Verhalten: bei der **ersten** `connected`-Meldung nach dem Start schaltet `SignalBox` einmalig alle Signale auf Halt (Stellung 0 über `tileCommands`), die in Fahrstraßen mit `from` oder `to` vorkommen (`route.signal` und Signalschritte), Befehle über `enqueue(…, undefined, true)`.

- [ ] **Step 1: Failing tests** (Server-Integrationstest in `interlocking.test.ts`, bestehende Simulator-Anordnung): (a) `box.tryRequestRoute("r1")` → `{ ok: true }`; erneut → `{ ok:false, reason: /schon angefordert/ }`; unbekannte Id → `ok:false` ohne Exception; (b) nach Zug-Durchfahrt liefert `box.drainEnded()` `completed` für `r1`; (c) neue `SignalBox`+`Station`, Simulator-Signal 5 vorab auf 16 gesetzt, nach `connect` steht es auf 0, bei erneutem `connect` werden keine weiteren Befehle gesendet.
- [ ] **Step 2:** `npx vitest run apps/server/src/interlocking.test.ts` – FAIL.
- [ ] **Step 3: Implement** wie beschrieben in `layout.ts`; Flag `private haltedOnce = false` im `connected`-Handler (nach `sync()`).
- [ ] **Step 4:** `npx vitest run apps/server` – PASS.
- [ ] **Step 5: Commit** `git commit -m "SignalBox: tryRequestRoute, drainEnded, signals to Halt on first connect"`.

---

### Task 4: Paket `packages/timetable` – Typen, Uhr, Format

**Files:**
- Create: `packages/timetable/package.json` (`@openstellwerk/timetable`, `main: src/index.ts`, keine Abhängigkeiten), `packages/timetable/src/{index,types,clock,format}.ts`
- Test: `packages/timetable/src/clock.test.ts`, `format.test.ts`
- Modify: `apps/server/package.json`, `apps/web/package.json` (Abhängigkeit `"@openstellwerk/timetable": "*"`), danach `npm install`

**Interfaces – Produces (`types.ts`):**
```ts
export type Status = "planned" | "waiting" | "set" | "running" | "done" | "failed" | "cancelled";
export interface Train { id: string; name: string; number?: string; address: number; location?: TrainLocation }
export interface TrainLocation { blockId: string; source: "manual" | "carried" | "detected"; since: number; uncertain?: boolean }
export interface Trip { id: string; trainId: string; routeId: string; departure: number; dwell: number; destination?: string; repeat?: { every: number; until: number } }
export interface Instance { id: string; tripId: string; day: number; due: number; status: Status; reason?: string; since: number }
export interface ClockState { running: boolean; factor: number; baseModel: number; baseReal: number }
export interface TimetableSnapshot { clock: ClockState; lateLimit: number; trains: Train[]; instances: Instance[] }
```
**`clock.ts`:** `DAY = 86400`; `DEFAULT_CLOCK: ClockState`; `modelNow(c, now): number`; `timeOfDay(model): number` (0..86399); `dayOf(model): number`; `startClock(c, now): ClockState`; `stopClock(c, now): ClockState` (friert `baseModel` ein); `setClock(c, now, o: { time?: number /*Sekunden Tagesbeginn*/; factor?: number }): ClockState` (Tageszähler bleibt, Uhrzeit wird gesetzt, Laufzustand bleibt, `factor` ganzzahlig 1..120 sonst `RangeError`).
**`format.ts`:** `formatHHMM(minutes: number): string` (`"07:05"`); `parseHHMM(text: string): number | undefined` (nur `HH:MM`, 00:00–23:59); `statusText(status: Status, reason?: string): string` → planned „planmäßig“, waiting „Verspätung“, set „eingestellt“, running „fährt“, failed „Störung“, cancelled „entfällt“, done „beendet“ (bei `reason` angehängt als „ – <reason>“).

- [ ] **Step 1: Failing tests** `clock.test.ts`: `modelNow` bei laufender Uhr, Faktor 20, nach 3000 ms Echtzeit = `baseModel + 60`; gestoppt ändert sich nichts; `stopClock` friert den Wert ein, `startClock` setzt `baseReal` neu; `setClock({ time: 7*3600+5*60 })` → `timeOfDay === 25500`; `dayOf(86400 + 5) === 1`; `setClock({ factor: 0 })` und `{ factor: 121 }` werfen `RangeError`. `format.test.ts`: `formatHHMM(425) === "07:05"`, `parseHHMM("07:05") === 425`, `parseHHMM("24:00")`, `("7:5")`, `("")` → `undefined`; `statusText("waiting","Block „Gleis 2“ ist besetzt")` enthält beides.
- [ ] **Step 2:** `npx vitest run packages/timetable` – FAIL.
- [ ] **Step 3: Implement** die Dateien und `index.ts` (re-exportiert alles); Arbeitsbereich verlinken (`npm install`).
- [ ] **Step 4:** `npx vitest run packages/timetable && npm run typecheck` – PASS.
- [ ] **Step 5: Commit** `git commit -m "timetable package: types, model clock, formatting"`.

---

### Task 5: Validierung und Takt-Auflösung

**Files:**
- Create: `packages/timetable/src/validate.ts`
- Test: `packages/timetable/src/validate.test.ts`

**Interfaces – Produces:**
```ts
export function validateTrains(input: unknown, ctx?: { blockIds: Set<string> }): Train[]
export function validateTrips(input: unknown, ctx?: { trainIds: Set<string>; routeIds: Set<string> }): Trip[]
export function validateSettings(input: unknown): { lateLimit: number }
export function departures(trip: Pick<Trip, "departure" | "repeat">): number[]   // Minuten, aufsteigend
```
- `validateTrains` entfernt Standorte in unbekannten Blöcken (nur wenn `ctx` gegeben), prüft doppelte Ids und Lokadressen („Lokadresse 3 ist schon einem Zug zugeordnet“), kürzt Texte, übernimmt `location` nur mit gültiger Struktur.
- `validateTrips` prüft Bereiche aus den Global Constraints und, nur mit `ctx`, dass Zug und Fahrstraße existieren („Fahrt 2: Zug nicht gefunden“, „… Fahrstraße nicht gefunden“); lehnt mehr als 200 Abfahrten und `until < departure` ab.
- `validateSettings`: fehlend → `{ lateLimit: 5 }`.

- [ ] **Step 1: Failing tests:** (a) gültiger Zug/Fahrt wird normalisiert (Texte getrimmt); (b) doppelte Lokadresse → Fehler mit „Lokadresse 3“; (c) Standort in unbekanntem Block wird mit `ctx` entfernt, ohne `ctx` behalten; (d) `departures({ departure: 600, repeat: { every: 20, until: 660 } })` → `[600, 620, 640, 660]` (`until` inklusive); (e) `every` größer als Rest: `[600]`; (f) `until: 500` bei `departure: 600` → Fehler; `every: 1, departure: 0, until: 1439` (1440 Abfahrten) → Fehler „höchstens 200 Abfahrten“; (g) `dwell: 121` und `departure: 1440` → Fehler; (h) mit `ctx` unbekannte Fahrstraße → Fehler, ohne `ctx` kein Fehler; (i) `validateSettings({ lateLimit: 0 })` wirft, `({})` → 5.
- [ ] **Step 2:** `npx vitest run packages/timetable/src/validate.test.ts` – FAIL.
- [ ] **Step 3: Implement** nach dem Muster von `validateLayout` (Hilfsfunktionen `int`, `text`, `fail` lokal; keine Abhängigkeit zu `@openstellwerk/protocol`).
- [ ] **Step 4:** `npx vitest run packages/timetable` – PASS.
- [ ] **Step 5: Commit** `git commit -m "timetable: validation of trains, trips and settings; repeat expansion"`.

---

### Task 6: Dispatcher (Zustandsautomat)

**Files:**
- Create: `packages/timetable/src/dispatcher.ts`
- Test: `packages/timetable/src/dispatcher.test.ts`

**Interfaces – Produces:**
```ts
export interface RouteInfo { from?: string; to?: string }
export interface RouteStatusInfo { routeId: string; status: "setting" | "set" | "running" | "fault" }
export interface EndedRoute { routeId: string; reason: "completed" | "released" | "forced" | "fault" }
export interface RouteResult { instanceId: string; ok: boolean; reason?: string }
export interface DispatchInput { now: number; clock: ClockState; lateLimit: number; trips: Trip[]; trains: Train[];
  routes: Map<string, RouteInfo>; connected: boolean; interlocking: RouteStatusInfo[]; ended: EndedRoute[]; results: RouteResult[] }
export type Action = { type: "request"; instanceId: string; routeId: string }
  | { type: "location"; trainId: string; blockId: string } | { type: "uncertain"; trainId: string }
export class Dispatcher {
  step(input: DispatchInput): { instances: Instance[]; actions: Action[] }
  cancel(instanceId: string): boolean      // nur planned/waiting → cancelled, Grund „vom Bediener“
  find(instanceId: string): Instance | undefined
  hasActive(tripId: string): boolean       // Instanz in waiting/set/running
}
```
**Regeln (Spec „Zustandsautomat“):** Instanzen werden aus `departures()` aller Fahrten für den aktuellen Modelltag erzeugt (`id = ${tripId}#${index}`, `due` in Sekunden). Tageswechsel: Instanzen ohne Status `set`/`running` werden verworfen und neu erzeugt. `planned→waiting` bei `modelNow ≥ day*86400+due`; schon um mehr als `lateLimit·60` überfällig → `cancelled` („verpasst“). `waiting` prüft in dieser Reihenfolge, die erste unerfüllte Bedingung wird `reason`: `connected` (sonst pausiert alles, keine Statusänderung), Fahrstraße/Zug vorhanden („Fahrstraße nicht mehr vorhanden“ → `failed`), Zug ohne andere Instanz in `set`/`running` und `dwell` seit Ende der letzten Fahrt, Zug hat Standort („Zug hat keinen Standort“), Standort = `route.from` (falls gesetzt; „Zug nicht im Startblock (bekannt: <blockId>)“), dann Aktion `request` (einmalig je Versuch, Ergebnis kommt als `results` im nächsten Schritt: `ok` → `set`, sonst `waiting` mit `reason` der Sicherung). Überschreitung `modelNow − due > lateLimit·60` → `failed` („Verspätungsgrenze überschritten: <letzter Grund>“). `set`: Status `running` der Sicherung → `running`; `ended` `released` → `cancelled`; `forced`/`fault` → `failed`; `completed` direkt → `done`. `running`: `completed` → `done` + Aktion `location` (Zielblock `route.to`, falls gesetzt); `forced`/`fault` → `failed` + Aktion `uncertain`. Ende (`done`/`failed`/`cancelled` einer laufenden Fahrt) merkt `lastEnd` des Zugs (Modellsekunden) für den Halt.

- [ ] **Step 1: Failing tests** (Hilfsfunktion `input(o)` mit Standardwerten: Uhr läuft, Faktor 1, `lateLimit: 5`, ein Zug im Block `b1`, Fahrstraße `r1 {from:"b1",to:"b2"}`, eine Fahrt um 10:00): (a) vor 10:00 `planned`, ab 10:00 `waiting` und genau eine `request`-Aktion, keine zweite im folgenden Schritt ohne Ergebnis; (b) `results: ok` → `set`; (c) Sicherung `running` → `running`; `ended completed` → `done` und Aktion `location b2`; (d) Ablehnung `reason: "Block „Gleis 2“ ist besetzt"` → bleibt `waiting` mit diesem Grund, im nächsten Schritt erneut `request`; nach 5 Modellminuten → `failed` mit „Verspätungsgrenze überschritten“; (e) Zug im falschen Block → Grund enthält „nicht im Startblock“ und „b3“, keine `request`; Zug ohne Standort → „keinen Standort“; (f) Uhr startet erst 10:30 → Instanz `cancelled` „verpasst“; (g) zwei Fahrten desselben Zugs: die zweite wartet, bis die erste `done` ist plus `dwell` (Fahrt 1 `dwell: 2`); (h) `cancel` nur in `planned`/`waiting` (true), in `running` false; (i) `ended released` bei `set` → `cancelled`; `forced` bei `running` → `failed` + Aktion `uncertain`; (j) `connected: false` → keine Aktion, Status unverändert; (k) **Mitternacht:** Uhr 23:59:30 mit Faktor 60, nach einem Schritt 00:00:30 → Instanzen des neuen Tages `planned`, eine laufende Instanz bleibt `running`; (l) Fahrt mit nicht vorhandener Fahrstraße → `failed` „Fahrstraße nicht mehr vorhanden“, keine Exception; (m) Takt-Fahrt erzeugt Instanzen `t1#0..t1#3`; (n) **Uhr rückwärts gestellt:** Instanzen mit Status `done` bleiben `done`, und eine bereits ausgelöste Instanz startet nach dem Zurückstellen nicht erneut (keine zweite `request`-Aktion für dieselbe Instanz-Id am selben Tag).
- [ ] **Step 2:** `npx vitest run packages/timetable/src/dispatcher.test.ts` – FAIL.
- [ ] **Step 3: Implement** `Dispatcher` mit privatem Zustand (`instances`, `day`, `lastEnd`, `requested: Set<string>`); `step` ist die einzige Methode mit Zeitbezug.
- [ ] **Step 4:** `npx vitest run packages/timetable && npm run typecheck` – PASS.
- [ ] **Step 5: Commit** `git commit -m "timetable: dispatcher state machine"`.

---

### Task 7: `TrainStore` und Zug-Routen

**Files:**
- Create: `apps/server/src/trains.ts`
- Test: `apps/server/src/trains.test.ts`

**Interfaces:**
- Consumes: `validateTrains`, `Train`, `TrainLocation` aus `@openstellwerk/timetable`; `JsonFile` aus `./json-file.js`.
- Produces:
```ts
export class TrainStore {
  constructor(file?: string)                      // lädt, setzt alle Standorte uncertain:true
  list(): Train[]; get(id: string): Train | undefined
  save(input: unknown, id?: string): Train        // neu (ohne id) oder ändern; 400 bei Fehlern
  remove(id: string): boolean
  setLocation(id: string, blockId: string | null): Train            // source "manual", uncertain entfernt; 404 unbekannter Zug
  setCarried(id: string, blockId: string): void; setDetected(id: string, blockId: string): void
  markUncertain(id: string): void; markAllUncertain(): void
  dropUnknownBlocks(valid: Set<string>): void
  replaceAll(trains: Train[]): void               // Backup-Restore, Standorte werden verworfen
}
export function registerTrainRoutes(app: FastifyInstance, store: TrainStore, deps: { blockIds: () => Set<string>; onRemove: (trainId: string) => void }): void
```
Routen: `GET /api/trains`, `POST /api/trains`, `PUT /api/trains/:id`, `DELETE /api/trains/:id` (ruft `deps.onRemove` vor dem Löschen), `PUT /api/trains/:id/location { blockId: string | null }` (400 bei Block ∉ `deps.blockIds()`). Doppelte Lokadresse → 409.

- [ ] **Step 1: Failing tests** (Fastify `inject`, Speicherung in Temp-Datei): (a) Anlegen/Ändern/Löschen, `GET` zeigt Zug; (b) zweite Anlage mit derselben Lokadresse → 409 „Lokadresse 3“; (c) `PUT …/location` setzt `source: "manual"`, `blockId: null` löscht; unbekannter Block → 400; unbekannter Zug → 404; (d) neu geladener Store (gleiche Datei) hat `uncertain: true` am Standort; (e) `setCarried` setzt `source:"carried"` und entfernt `uncertain`; (f) `dropUnknownBlocks` entfernt Standorte; (g) `DELETE` ruft `onRemove` mit der Zug-Id auf.
- [ ] **Step 2:** `npx vitest run apps/server/src/trains.test.ts` – FAIL.
- [ ] **Step 3: Implement** nach dem Muster von `garage.ts` (Map, `JsonFile`, 250 ms verzögertes Schreiben). Doppelte Adresse als `statusCode 409`, übrige Validierungsfehler als 400.
- [ ] **Step 4:** `npx vitest run apps/server/src/trains.test.ts` – PASS.
- [ ] **Step 5: Commit** `git commit -m "TrainStore and train routes"`.

---

### Task 8: `TimetableRunner`, Fahrplan-Routen, Snapshot

**Files:**
- Create: `apps/server/src/timetable.ts`
- Modify: `apps/server/src/station.ts` (Typ `StationState.timetable?: TimetableSnapshot`), `apps/server/src/main.ts` (Verdrahtung)
- Test: `apps/server/src/timetable.test.ts`

**Interfaces:**
- Consumes: `Dispatcher`, Uhrfunktionen, `validateTrips`, `validateSettings`, `departures` (Tasks 4–6); `TrainStore` (Task 7); `SignalBox.tryRequestRoute/drainEnded/routeStates/get` (Task 3); `Station.addExtra` (Task 1).
- Produces:
```ts
export class TimetableRunner {
  constructor(station: Station, box: SignalBox, trains: TrainStore, file?: string, opts?: { tickMs?: number })  // tickMs Standard 1000
  start(): void; stop(): void
  get(): { trips: Trip[]; lateLimit: number; clock: ClockState }
  saveTrip(input: unknown, id?: string): Trip         // 400 ungültig, 404 unbekannt, 409 bei aktiver Instanz
  removeTrip(id: string): boolean                     // 409 bei aktiver Instanz
  removeTripsOf(trainId: string): void
  setSettings(input: unknown): { lateLimit: number }
  clockAction(body: { action: "start" | "stop" } | { action: "set"; time: string; factor?: number }): ClockState
  cancelInstance(id: string): void                    // 404 unbekannt, 409 falscher Status
  replaceAll(data: { trips: Trip[]; lateLimit: number }): void   // Backup-Restore; 409 bei Instanz set/running
  loadExample(): boolean                              // Task 12
}
export function registerTimetableRoutes(app: FastifyInstance, runner: TimetableRunner): void
```
Routen: `GET /api/timetable`, `POST /api/trips`, `PUT /api/trips/:id`, `DELETE /api/trips/:id`, `PUT /api/timetable/settings`, `POST /api/timetable/clock`, `POST /api/timetable/instances/:id/cancel`.

**Verhalten:** Jeder Tick: Verbindung weg und Uhr läuft → `stopClock` (einmalig, `notify`). Sonst `Dispatcher.step` mit `routes` aus `box.get().routes` (`from`/`to`), `interlocking: box.routeStates()`, `ended: box.drainEnded()`, gesammelten `results`; `request`-Aktionen über `box.tryRequestRoute`, danach sofort ein zweiter Schritt mit den Ergebnissen; `location`-Aktionen → `trains.setCarried`, `uncertain` → `trains.markUncertain`. `station.notify()` nur, wenn sich Instanzen oder Standorte geändert haben (Vergleich als JSON). Snapshot-Beitrag über `station.addExtra`: Uhr, `lateLimit`, Züge, Instanzen nach den Global Constraints. Lokerkennung: aus `station.snapshot()` (`loconetDetectors[].locoAddress`, `canDetectors[].ports[].locos[]`) und den Kachel-`feedback`-Verweisen des Gleisbilds wird je belegtem Block die Lokadresse bestimmt; gehört sie zu einem Zug ohne Instanz in `set`/`running` mit anderem Standort → `trains.setDetected`. Nach jedem Speichern des Gleisbilds (Hook: `station.on("state")` genügt, Blockmenge pro Tick) `trains.dropUnknownBlocks`. Beim Start: Uhr gestoppt, Standorte `uncertain` (macht `TrainStore`), Daten aus `timetable.json` (strukturell validiert, ungültige Teile ignoriert + `console.error`).

- [ ] **Step 1: Failing tests** (Station + Simulator Port 21572, `SignalBox` mit Gleisbild und Blöcken wie in `interlocking.test.ts`, `tickMs: 20`, Uhr Faktor 60): (a) Fahrt mit Zug im Startblock: Uhr stellen auf 10:00 und starten → Instanz wird `waiting`, dann `set`; Simulator-Belegung durch den Test (R-BUS wie in `interlocking.test.ts`) → `running` → `done`; Zug steht danach im Zielblock, `source: "carried"`; (b) Ablehnung: Zielblock belegt → Instanz bleibt `waiting` mit Grund „besetzt“, nach Freigabe startet sie, **ohne** dass die Sicherung umgangen wurde (Interlocking-Zustand der Fahrstraße leer, solange `waiting`); (c) Verbindung getrennt → `clock.running` wird `false`, nach erneutem Verbinden bleibt sie `false`; (d) **Fahrstraße nach Anlegen der Fahrt gelöscht** (`box.save` ohne Fahrstraße) → Instanz `failed` „Fahrstraße nicht mehr vorhanden“; (e) Lokerkennung: `sim.setLocoNetOccupancy(feedback, true, 3)` für Zug mit Lokadresse 3 in anderem Block → Standort `detected`; während einer Fahrt dieses Zugs ignoriert; (f) Neustart: neuer Runner mit gleicher Datei → Uhr gestoppt, Standorte `uncertain`, keine Instanzen; (g) HTTP: `POST /api/trips` mit unbekanntem Zug → 400; `PUT`/`DELETE` einer Fahrt mit Instanz in `waiting/set/running` → 409; `POST …/instances/x/cancel` unbekannt → 404, im Status `running` → 409; `PUT /api/timetable/settings { lateLimit: 0 }` → 400; **Snapshot-Begrenzung:** Takt `every: 1` über 190 Abfahrten ergibt höchstens 40 Instanzen im Snapshot, sortiert nach `due`.
- [ ] **Step 2:** `npx vitest run apps/server/src/timetable.test.ts` – FAIL.
- [ ] **Step 3: Implement** `TimetableRunner` und Routen; `main.ts`: `TrainStore` (`trains.json`) und `TimetableRunner` (`timetable.json`) aus `dataDir`, `registerTrainRoutes` mit `deps.blockIds = () => new Set(box.get().blocks?.map(b => b.id))` und `onRemove = (id) => runner.removeTripsOf(id)`, `registerTimetableRoutes`, `runner.start()`.
- [ ] **Step 4:** `npx vitest run && npm run typecheck` – PASS.
- [ ] **Step 5: Commit** `git commit -m "TimetableRunner: timetable drives interlocked routes, routes, snapshot"`.

---

### Task 9: Datensicherung um `trains` und `timetable`

**Files:**
- Modify: `apps/server/src/backup.ts`, `apps/server/src/main.ts` (Konstruktor-Aufruf)
- Test: `apps/server/src/backup.test.ts`

**Interfaces:**
- Consumes: `TrainStore.replaceAll/list`, `TimetableRunner.get/replaceAll`, `validateTrains/validateTrips/validateSettings`.
- Produces: `BACKUP_PARTS = ["garage","layout","cameras","trains","timetable"]`; `BackupService` bekommt `trains: TrainStore` und `timetable: TimetableRunner` als Konstruktorparameter (vor `changed`). `create()` liefert `trains` (Züge **ohne** `location`) und `timetable: { trips, settings: { lateLimit } }`. `restore` prüft die Verweise gegen den **entstehenden** Stand: Fahrten → Züge (aus der Datei, sonst aktuell) und Fahrstraßen (aus der Datei-`layout`, sonst aktuell); Züge → Blockmenge nicht nötig (Standorte entfallen). Atomar wie bisher; `timetable`-Restore bei Instanz `set`/`running` → 409.

- [ ] **Step 1: Failing tests** (Erweiterung `backup.test.ts`; der Test baut Stores wie `main.ts`): (a) Roundtrip: Zug und Fahrt erscheinen im Backup, Zug ohne `location`; Wiederherstellen in leeren Stand ergibt dieselben Daten; (b) Backup ohne `trains`/`timetable` (altes Format) lässt sich weiter wiederherstellen; (c) Fahrt mit unbekanntem Zug im Backup → 400 und **nichts** ändert sich; (d) nur `["trains"]` wählen lässt die Fahrten unberührt, aber eine Fahrt, die auf einen entfernten Zug zeigt → 400; (e) Restore von `timetable` bei laufender Instanz → 409.
- [ ] **Step 2:** `npx vitest run apps/server/src/backup.test.ts` – FAIL.
- [ ] **Step 3: Implement** die Erweiterungen; `restore` ruft zuerst alle Prüfungen, dann `trains.replaceAll`, `timetable.replaceAll`.
- [ ] **Step 4:** `npx vitest run apps/server` – PASS.
- [ ] **Step 5: Commit** `git commit -m "Backup: trains and timetable"`.

---

### Task 10: Oberfläche – Verwaltung (Züge, Fahrplan) und Datensicherung

**Files:**
- Create: `apps/web/src/trains.tsx`, `apps/web/src/timetable.tsx` (Teil `TimetableAdmin`)
- Modify: `apps/web/src/admin.tsx` (Seiten `trains` „Züge“, `timetable` „Fahrplan“ in Gruppe „Anlage“; erlaubt, sobald `state` existiert wie `layout`), `apps/web/src/api.ts` (`StationState.timetable?: TimetableSnapshot`, Typen aus `@openstellwerk/timetable`), `apps/web/src/backup.tsx` (Teile `trains`, `timetable` mit Beschriftung und Anzahl)
- Test: `apps/web/src/timetable.test.ts` nur für reine Hilfsfunktionen, die du hier anlegst (siehe Step 1)

**Interfaces:**
- Consumes: HTTP-Routen aus Tasks 7–8, `formatHHMM`, `parseHHMM`, `statusText`.
- Produces: `TrainsPage({ state, run })`, `TimetableAdmin({ state, run })`; Hilfsfunktion `tripRows(trips, trains, routes): Row[]` in `timetable.tsx` (Anzeigezeilen: Zeit, Zugname, Fahrstraßenname, „ungültig“-Markierung, wenn Zug oder Fahrstraße fehlt).

- [ ] **Step 1: Failing test** `timetable.test.ts`: `tripRows` markiert eine Fahrt mit unbekannter Fahrstraße als `invalid: true`, formatiert `departure` als „10:00“ und ergänzt bei Takt den Text „alle 20 min bis 22:00“.
- [ ] **Step 2:** `npx vitest run apps/web` – FAIL.
- [ ] **Step 3: Implement** `tripRows` und die Seiten. **Züge:** Liste links, Formular rechts (Name, Zugnummer, Lok-Auswahl aus `state.garage` mit freier Adresseingabe, Standort per Block-Auswahl aus `state.layout.blocks`, Hinweis bei `uncertain`); Löschen mit `ifSure` („Auch die Fahrten dieses Zugs werden gelöscht“). **Fahrplan:** Tabelle (`GET /api/timetable` beim Öffnen und nach jeder Änderung) und Formular (Zug, nur gesicherte Fahrstraßen mit `from` oder `to`, Abfahrt `HH:MM`, Halt, Anzeigetext, optional Takt), Verspätungsgrenze (`PUT /api/timetable/settings`); Fehler der Server werden angezeigt. `backup.tsx`: Teilebezeichnungen „Züge (ohne Standort)“ und „Fahrplan“.
- [ ] **Step 4:** `npx vitest run && npm run typecheck && npm run build` – PASS.
- [ ] **Step 5: Commit** `git commit -m "UI: trains and timetable administration, backup parts"`.

---

### Task 11: Oberfläche – Bedienen (Tab Fahrplan) und Abfahrtstafel

**Files:**
- Modify: `apps/web/src/timetable.tsx` (`TimetableOperate`, `DepartureBoard`, `useModelTime`), `apps/web/src/App.tsx` (Tab `timetable` „Fahrplan“ in `OPERATE`, nur für Z21), `apps/web/src/layout.tsx` (`DisplayView`: Fahrplanuhr statt Z21-Uhr, Abfahrtstafel neben dem Gleisbild), `apps/web/src/styles.css`
- Test: `apps/web/src/timetable.test.ts`

**Interfaces:**
- Produces: `useModelTime(clock: ClockState): number` (Hook, aktualisiert jede Sekunde, rechnet mit `modelNow(clock, Date.now())`); `boardRows(instances: Instance[], trips: Trip[], trains: Train[], layout: Layout, limit: number): BoardRow[]` mit `BoardRow = { time: string; number: string; destination: string; platform: string; status: Status; label: string; reason?: string }`; `DepartureBoard({ state, rows? })` (nur ansehen); `TimetableOperate({ state, run })`.
- `platform` = Name des Zielblocks der Fahrstraße, `destination` = `trip.destination` oder Name des Zielblocks, `number` = `train.number ?? train.name`.

- [ ] **Step 1: Failing tests** (`boardRows`): (a) sortiert nach `due`, begrenzt auf `limit`, beendete/entfallene Fahrten fallen nach den letzten wenigen heraus; (b) Zielblock „Gleis 2“ → `platform`, `destination` fällt auf den Blocknamen zurück; (c) `waiting` → `label` „Verspätung“; (d) Instanz ohne passende Fahrt wird übersprungen, keine Exception.
- [ ] **Step 2:** `npx vitest run apps/web` – FAIL.
- [ ] **Step 3: Implement** Hilfsfunktion, Hook und Komponenten. **Bedienen:** Uhr (Anzeige HH:MM:SS, Start/Stopp, Faktor, „Uhr stellen“), Liste der nächsten Abfahrten mit Status und Grund, pro Instanz „Entfallen lassen“ (`POST …/cancel`, nur `planned`/`waiting`), pro Zug „Standort setzen“; keine Rückfragen. **Anzeige:** `DisplayView` zeigt die Fahrplanuhr (Titel „Fahrplanuhr“, Stopp-Zustand sichtbar) und darunter oder daneben die `DepartureBoard` (große Schrift, nur ansehen); ohne `timetable` im Snapshot bleibt die Anzeige wie bisher.
- [ ] **Step 4:** `npx vitest run && npm run typecheck && npm run build` – PASS. Screenshots (Bedienen/Fahrplan, Anzeige) wie in Phase 1 mit Firefox-Headless-Trick prüfen und lesen.
- [ ] **Step 5: Commit** `git commit -m "UI: timetable operation tab and departure board on the display"`.

---

### Task 12: Demo-Modus mit Beispielfahrplan, README

**Files:**
- Create: `docs/beispiel-fahrplan.json`
- Modify: `apps/server/src/timetable.ts` (`loadExample`), `apps/server/src/demo.ts` (Konstruktor `timetable?: Pick<TimetableRunner, "loadExample" | "clockAction">`), `apps/server/src/main.ts`, `README.md`
- Test: `apps/server/src/demo.test.ts`, `packages/timetable/src/validate.test.ts`

**Interfaces:**
- `docs/beispiel-fahrplan.json`: `{ trains: [...], trips: [...], settings: { lateLimit: 5 } }`, passend zu `docs/beispiel-gleisbild.json` (Blöcke `zufahrt`, `g1`, `g2`, Fahrstraßen `r1`, `r2`): zwei Züge (Standort `zufahrt`), vier Fahrten, eine mit Takt.
- `TimetableRunner.loadExample(): boolean` lädt die Datei relativ zu `import.meta.url` (wie `Demo`), nur wenn Züge und Fahrten leer sind, setzt die Züge auf ihre Startblöcke (`source: "manual"`), liefert `true`, wenn geladen wurde.
- `Demo.start()` ruft `loadExample()`, danach `clockAction({ action: "set", time: "06:00", factor: 20 })` und `{ action: "start" }`. Demo-Test (`pace` 20) verwendet Faktor 120 in der Uhr.

- [ ] **Step 1: Failing tests:** (a) `validate.test.ts`: die Beispieldatei besteht `validateTrains`/`validateTrips`/`validateSettings` gegen die Blöcke und Fahrstraßen des Beispiel-Gleisbilds; (b) `demo.test.ts`: nach `demo.start()` sind Züge und Fahrten geladen, die Uhr läuft; ein vollständiger Fahrplanlauf: die erste Fahrt wird `done`, der Zug steht im Zielblock; nach erneutem Start (leeren Zustand vorausgesetzt) werden die Beispieldaten **nicht** doppelt geladen, wenn schon Züge existieren.
- [ ] **Step 2:** `npx vitest run apps/server/src/demo.test.ts packages/timetable` – FAIL.
- [ ] **Step 3: Implement** Datei, `loadExample`, Demo-Anbindung. README: neuer Abschnitt „Fahrplan und Abfahrtstafel“ (Züge, Fahrten mit Takt, Fahrplanuhr, Verspätungsgrenze, Abfahrtstafel unter `#/anzeige`, Verhalten nach Neustart, Stufe 2 noch nicht enthalten) und Korrektur der Aussage, die Anzeige zeige die Z21-Uhr.
- [ ] **Step 4:** `npx vitest run && npm run typecheck && npm run build` – PASS; im Dev-System `POST /api/demo {"on":true}` starten und prüfen, dass der Beispielfahrplan ohne Eingriff durchläuft (Status per `GET /api/state`).
- [ ] **Step 5: Commit** `git commit -m "Demo: example timetable, README"`.

---

## Selbstprüfung gegen die Spezifikation

- **Ziel/Entscheidungen:** Tasks 6–8 (Stufe 1 über `tryRequestRoute`), 4 (eigene Uhr), 5 (Einzelfahrten mit Takt), 7/8 (Standort manuell, mitgeführt, erkannt), 11 (Tafel).
- **Änderungen am Bestand 1–4:** Task 1 (`addExtra`), Task 2 (`drainEnded`), Task 3 (`tryRequestRoute`, Halt beim ersten Verbinden), Task 9 (Backup).
- **Daten, Uhr, Speicherung:** Tasks 4, 5, 7, 8 (`timetable.json`, `trains.json`, Neustart-Verhalten).
- **Verhalten/Zustandsautomat:** Task 6; **Lokerkennung:** Task 8 (e).
- **Schnittstellen:** HTTP in Tasks 7–8, Snapshot in Task 8, Backup in Task 9.
- **Oberfläche:** Tasks 10–11; **Demo:** Task 12.
- **Fehlerfälle:** Ablehnung/Verspätungsgrenze (6, 8 b), falscher Startblock (6 e), Zug aktiv (6 g), Verbindung weg (8 c), Neustart (8 f), Uhr vorwärts (6 f), Uhr rückwärts (6 n), Fahrstraße gelöscht (6 l, 8 d), Lokerkennung (8 e), ungültige Dateien (8, Beschreibung der Ladelogik).
- **Typkonsistenz:** `EndedRoute`/`RouteStatusInfo` (Task 6) sind strukturell kompatibel zu `Interlocking.drainEnded()`/`RouteState` (Task 2); `TrainStore.setCarried/setDetected/markUncertain` (Task 7) entsprechen den `Action`-Typen aus Task 6; `TimetableSnapshot` (Task 4) ist der Typ des Snapshot-Felds (Tasks 8, 10, 11).
