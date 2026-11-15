# Phase 2: Züge, Fahrplan und Abfahrtstafel

Stand: 2026-11-11. Status: zur Durchsicht durch den Auftraggeber.

## Ziel

Aus dem gesicherten Stellwerk (Phase 1) wird eine Steuerung, die nach Fahrplan arbeitet:

- **Züge** sind Loks aus der Garage mit Name, Zugnummer und bekanntem Standort (Block).
- Ein **Fahrplan** aus Einzelfahrten mit optionalem Takt löst zur Abfahrtszeit eine **gesicherte Fahrstraße** aus (Automatik Stufe 1). Der Fahrer fährt die Lok selbst.
- Eine **Fahrplanuhr** im Server steuert die Zeit, unabhängig von der Z21.
- Die **Anzeige-Seite** (`#/anzeige`) zeigt zusätzlich eine **Abfahrtstafel**, nur ansehen.
- Alles läuft auch im **Demo-Modus** mit dem virtuellen Zug.

Nicht Teil dieser Spezifikation (eigene Spezifikation später): Stufe 2 (Lok automatisch fahren und im Zielblock anhalten), Umlaufpläne je Zug, Verspätungsprognose, Doppeltraktion.

### Entscheidungen aus der Abstimmung

| Thema | Entscheidung |
|---|---|
| Automatik | Stufe 1: Fahrstraßen nach Fahrplan, Fahrer fährt selbst. Stufe 2 danach. |
| Zeitbasis | Eigene Fahrplanuhr im Server (Start/Stopp, Faktor, Startzeit). |
| Fahrplanform | Einzelfahrten mit optionalem Takt. |
| Zugstandort | Von Hand setzen, nach jeder Fahrt mitführen; Lokerkennung der Melder korrigiert, wenn die Hardware sie liefert. |
| Rückmelder | Noch nicht verbaut: Entwicklung gegen Simulator und Demo; die Sicherung geht von echten Meldern aus (unverändert aus Phase 1). |

## Aufbau

Ansatz: reine Logik in einem Paket ohne I/O, dünne Anbindung im Server (wie `packages/interlocking`).

```
Browser ──HTTP/WebSocket──▶ Server
                              ├─ TrainStore        (trains.json)
                              ├─ TimetableRunner ──▶ Dispatcher (packages/timetable, rein)
                              │        │
                              │        └──▶ SignalBox.requestRoute ──▶ Interlocking (Phase 1)
                              └─ Station-Snapshot: Feld "timetable"
```

- **`packages/timetable`** (neu, rein, ohne I/O, nur Abhängigkeit `@openstellwerk/protocol`): Typen, Fahrplanuhr, Auflösung von Fahrten zu Abfahrten, Zustandsautomat `Dispatcher`.
- **`apps/server/src/trains.ts`**: `TrainStore` (Züge, Standort, Persistenz über `JsonFile`) und Routen `/api/trains`.
- **`apps/server/src/timetable.ts`**: `TimetableRunner` (Fahrten, Einstellungen, Uhr, Persistenz, Timer, Anbindung an die Sicherung) und Routen `/api/timetable`, `/api/trips`.
- **Die Sicherung wird nie umgangen.** Der Runner fordert Fahrstraßen ausschließlich über `SignalBox.requestRoute` an.

### Notwendige Änderungen am Bestand

1. **`Station.extra` wird eine Liste.** Heute ist `station.extra` eine einzelne Funktion, die `SignalBox` setzt; ein zweites Modul würde sie überschreiben. Neu: `station.addExtra(fn)`; der Snapshot mischt alle registrierten Teile. `SignalBox` registriert sich so.
2. **`Interlocking` meldet Enden.** Neue Methode `drainEnded(): { routeId, reason: "completed" | "released" | "forced" | "fault" }[]` liefert die seit dem letzten Aufruf beendeten Fahrstraßen. `completed` heißt: der Zug hat den Zielblock erreicht und alle Blöcke sind wieder frei (reguläre Auflösung). `released` ist das Auflösen einer unbefahrenen Fahrstraße, `forced` die Notauflösung, `fault` das Quittieren einer Störung. So kann der Runner „angekommen“ von „abgebrochen“ unterscheiden.
3. **`SignalBox.requestRoute`** liefert bei Ablehnung die Begründung weiter (heute nur als HTTP-Fehler): neue Variante `tryRequestRoute(id): { ok: true } | { ok: false, reason }`, die nichts wirft. Die HTTP-Route bleibt unverändert.
4. **Datensicherung** bekommt zwei weitere Teile (`trains`, `timetable`); siehe unten.

## Daten

### Zug

```ts
interface Train {
  id: string;              // [A-Za-z0-9_-]{1,24}
  name: string;            // 1..40 Zeichen
  number?: string;         // Zugnummer für die Anzeige, z. B. "RE 4711", max. 12
  address: number;         // Lokadresse 1..9999 (Auswahl aus der Garage)
  location?: {
    blockId: string;
    source: "manual" | "carried" | "detected";
    since: number;         // ms Epoch
    uncertain?: boolean;   // true nach Neustart, bis neu gesetzt/erreicht/erkannt
  };
}
```

- Eine Lokadresse gehört zu höchstens einem Zug.
- `location.blockId` muss im aktuellen Gleisbild existieren; wird ein Block gelöscht, wird der Standort entfernt.

### Fahrt

```ts
interface Trip {
  id: string;
  trainId: string;
  routeId: string;         // gesicherte Fahrstraße (hat from/to oder Blöcke)
  departure: number;       // Minuten seit 00:00 Modellzeit, 0..1439
  dwell: number;           // Halt am Ziel in Modellminuten, 0..120; frühester Start der nächsten Fahrt desselben Zugs
  destination?: string;    // Anzeigetext, Standard: Name des Zielblocks der Fahrstraße
  repeat?: { every: number; until: number };  // Takt: alle `every` Minuten (1..1439) bis einschließlich `until`
}
```

- Ein Takt erzeugt höchstens 200 Abfahrten je Tag; mehr wird beim Speichern abgelehnt.
- `departure` plus Takt ergeben die **Abfahrten** eines Tages: `departure + k·every ≤ until`.

### Instanz (Laufzeit, nicht gespeichert)

Eine Instanz ist eine einzelne Abfahrt einer Fahrt an einem Modelltag.

```ts
type Status = "planned" | "waiting" | "set" | "running" | "done" | "failed" | "cancelled";
interface Instance {
  id: string;              // `${tripId}#${index}` (index der Abfahrt im Tag)
  tripId: string;
  day: number;             // Modelltag (Zähler)
  due: number;             // Modellzeit der Abfahrt in Sekunden seit Tagesbeginn
  status: Status;
  reason?: string;         // Grund bei waiting/failed/cancelled (deutsch, für die Anzeige)
  since: number;           // Modellzeit des letzten Statuswechsels
}
```

### Fahrplanuhr

```ts
interface ClockState {
  running: boolean;
  factor: number;          // Modellsekunden je Echtsekunde, 1..120
  baseModel: number;       // Modellzeit in Sekunden seit Start (fortlaufend, nicht modulo 86400) zum Zeitpunkt baseReal
  baseReal: number;        // ms Epoch
}
modelNow(c, now) = c.running ? c.baseModel + (now - c.baseReal) / 1000 * c.factor : c.baseModel
```

- Uhrzeit des Tages = `modelNow mod 86400`, Tageszähler = `floor(modelNow / 86400)`.
- Clients rechnen die Uhrzeit aus den Uhrparametern selbst aus; der Snapshot trägt keine Uhrzeit pro Sekunde und wird dadurch nicht jede Sekunde neu gesendet.
- Mit Tageswechsel beginnt der Fahrplan neu: Instanzen des neuen Tages sind `planned`.

### Speicherung

- `trains.json`: Liste der Züge (mit Standort).
- `timetable.json`: `{ trips, settings: { lateLimit: number }, clock }`. `lateLimit` (Verspätungsgrenze) in Modellminuten, Standard 5, 1..120.
- Beim Laden wird die Uhr immer als gestoppt wiederhergestellt (`running: false`), alle Standorte erhalten `uncertain: true`.
- Beide Dateien werden vor der Verwendung geprüft (Struktur, Verweise); ungültige Teile werden ignoriert und im Log gemeldet, wie bei `layout.json`.

## Verhalten

### Zustandsautomat einer Instanz

```
planned ─(Abfahrtszeit erreicht)──▶ waiting ─(Fahrstraße angenommen)──▶ set ─(Sicherung: Zug fährt ein)──▶ running ─(completed)──▶ done
   │                                  │  ▲                                │                                  │
   │                                  │  └─ Wiederholung jede Sekunde     │                                  └─(forced/fault)──▶ failed
   │                                  └─(Verspätungsgrenze)──▶ failed     └─(released)──▶ cancelled
   └─(Bediener / verpasst)──▶ cancelled
```

Regeln:

1. **planned → waiting**, sobald `modelNow` die Abfahrtszeit erreicht hat. Ist die Instanz dabei schon um mehr als `lateLimit` überfällig (z. B. nach einem Sprung der Uhr, Start der Uhr nach der Abfahrtszeit), wird sie stattdessen **cancelled** („verpasst“) und **nicht nachgeholt**.
2. **waiting**: Jede Sekunde werden der Reihe nach geprüft; die erste nicht erfüllte Bedingung wird als `reason` angezeigt und der Zug bleibt `waiting`:
   - Verbindung zur Zentrale besteht (sonst Runner pausiert, siehe Fehlerfälle).
   - Der Zug hat keine andere Instanz in `set` oder `running`, und seit dem Ende seiner letzten Fahrt (Wert `dwell` dieser Fahrt) sind so viele Modellminuten vergangen, wie `dwell` angibt.
   - Hat die Fahrstraße einen Startblock (`from`), steht der Zug dort (`location.blockId === route.from`). Sonst „Zug nicht im Startblock (bekannt: <Block>)“ beziehungsweise „Zug hat keinen Standort“.
   - `SignalBox.tryRequestRoute` nimmt die Fahrstraße an. Bei Ablehnung gilt der Grund der Sicherung („Block „Gleis 2“ ist besetzt“, „Melder meldet (noch) nichts …“, „… verriegelt“).
   Wird alles erfüllt, wechselt die Instanz zu **set**.
   Ist `modelNow − due > lateLimit`, wird die Instanz **failed** („Verspätungsgrenze überschritten: <letzter Grund>“) und startet nicht mehr von selbst.
3. **set → running**, sobald die Sicherung die Fahrstraße als `running` meldet. **set → failed**, wenn sie in `fault` geht. **set → cancelled**, wenn sie per `released` aufgelöst wird.
4. **running → done** bei `completed`; der Runner setzt den Standort des Zugs auf den Zielblock (`source: "carried"`). **running → failed** bei `forced` oder `fault`; der Standort wird `uncertain`.
5. **Bediener**: „Entfallen lassen“ ist nur in `planned` und `waiting` erlaubt (→ cancelled, „vom Bediener“). Laufende Fahrten werden über die Sicherung beendet (Auflösen/Notauflösung), nicht über den Fahrplan.

### Reine Schnittstelle des Dispatchers

```ts
dispatcher.step(input) → { instances: Instance[], actions: Action[] }
input:  { now (ms), clock, trips, trains, routes: Map<routeId,{from?,to?}>, connected,
          interlocking: RouteState[], ended: EndedEvent[], results: { instanceId, ok, reason? }[] }
Action: { type: "request"; instanceId; routeId }
      | { type: "location"; trainId; blockId; source: "carried" }
      | { type: "uncertain"; trainId }
```

Der Dispatcher hält den Zustand der Instanzen, ruft nie die Sicherung auf und kennt keine Timer. Der Runner ruft `step` jede Sekunde sowie bei jeder Änderung des Snapshots auf, führt die Aktionen aus (`request` über `tryRequestRoute`, danach `results` im nächsten Schritt) und schreibt Standorte in den `TrainStore`.

### Standort und Lokerkennung

- **Von Hand**: `PUT /api/trains/:id/location { blockId }` (oder `null`, um den Standort zu löschen); `source: "manual"`.
- **Mitführen**: siehe Regel 4.
- **Erkennen**: Melden die Melder eine Lokadresse (LocoNet-Transponder `locoAddress`, CAN-Detektor `locos[]`) in einem belegten Block, dessen Kachel-Melder die Meldung liefert, und gehört die Adresse zu einem Zug **ohne** Instanz in `set`/`running`, der laut Standort woanders steht, wird der Standort auf diesen Block gesetzt (`source: "detected"`) und die Abweichung in einem kurzen Protokolleintrag der Zug-Details vermerkt. Während einer Fahrt wird die Erkennung ignoriert; die Sicherung führt den Zug.
- Ohne Hardware, die Lokadressen liefert, ist die Erkennung wirkungslos; im Demo-Modus kann der virtuelle Zug sie simulieren.

## Schnittstellen

### HTTP

| Methode und Pfad | Zweck |
|---|---|
| `GET /api/trains` | Züge |
| `POST /api/trains`, `PUT /api/trains/:id`, `DELETE /api/trains/:id` | Züge anlegen, ändern, löschen (löschen entfernt auch deren Fahrten nach Rückfrage in der Oberfläche) |
| `PUT /api/trains/:id/location` | Standort setzen oder löschen |
| `GET /api/timetable` | Fahrten, Einstellungen, Uhr |
| `POST /api/trips`, `PUT /api/trips/:id`, `DELETE /api/trips/:id` | Fahrten verwalten |
| `PUT /api/timetable/settings` | `{ lateLimit }` |
| `POST /api/timetable/clock` | `{ action: "start" | "stop" }` oder `{ action: "set", time: "HH:MM", factor?: number }` |
| `POST /api/timetable/instances/:id/cancel` | Instanz entfallen lassen |

Fehler: 400 bei ungültigen Eingaben (deutsche Meldung wie bei `validateLayout`), 404 bei unbekannter Id, 409 bei Konflikten (Lokadresse schon vergeben; Bearbeiten, solange die Fahrt eine aktive Instanz hat; Entfallen in falschem Status).

### Snapshot

Neues Feld `timetable` (über `station.addExtra`):

```ts
timetable?: {
  clock: ClockState;
  lateLimit: number;
  trains: Train[];
  instances: Instance[];   // nicht beendete plus die letzten 5 beendeten, höchstens 40, nach Abfahrt sortiert
}
```

Die Fahrten selbst (`trips`) stehen nicht im Snapshot, sondern werden über `GET /api/timetable` geladen; die Verwaltung lädt sie bei Bedarf und nach Änderungen.

### Datensicherung

Das Backup-Format bleibt Version 1; es kommen zwei **optionale** Teile hinzu, ältere Dateien bleiben wiederherstellbar:

- `trains`: Liste der Züge **ohne** Standort (Standorte gehören zum Betrieb, nicht zur Konfiguration).
- `timetable`: `{ trips, settings }`.

Beim Wiederherstellen werden die Verweise gegen den **entstehenden** Stand geprüft (Fahrten → Züge und Fahrstraßen, Züge → Garage-Adresse ist nicht nötig, nur Bereich 1..9999). Ein Fehler ändert nichts. Das Wiederherstellen von `timetable` ist nicht möglich, solange eine Instanz `set` oder `running` ist (409).

## Oberfläche

### Verwaltung (Gruppe „Anlage“, zwei neue Seiten)

- **Züge**: Liste links, Formular rechts (Name, Zugnummer, Lok aus der Garage per Auswahl, Standort per Blockauswahl). Anzeige von `uncertain` als Warnung.
- **Fahrplan**: Tabelle der Fahrten mit Formular (Zug, Fahrstraße, Abfahrt `HH:MM`, Halt, Anzeigetext, optional Takt mit Intervall und Ende), Einstellung der Verspätungsgrenze. Beim Speichern werden Zug und Fahrstraße geprüft; nicht gesicherte Fahrstraßen (ohne Block) sind nicht wählbar.

### Bedienen (neuer Tab „Fahrplan“)

- Fahrplanuhr: Anzeige, Start/Stopp, Faktor, Uhr stellen.
- Liste der nächsten Abfahrten mit Status; Spalten: Zeit, Zug, Ziel, Gleis, Status (mit Grund).
- Pro Instanz „Entfallen lassen“, pro Zug „Standort setzen“.
- Alltagsbetrieb: keine Rückfragen.

### Anzeige (`#/anzeige`)

Zusätzlich zu Uhr und Gleisbild eine **Abfahrtstafel** der nächsten Abfahrten (Zeit, Zugnummer, Ziel, Gleis = Name des Zielblocks, Status). Statusanzeige: *planmäßig*, *eingestellt*, *fährt*, *Verspätung* (waiting nach Abfahrtszeit), *Störung*, *entfällt*. Beendete Fahrten verschwinden nach wenigen Einträgen. Die Uhr zeigt die Fahrplanuhr; die Z21-Uhr wird dort nicht mehr verwendet. Nur ansehen, keine Bedienelemente.

### Demo-Modus

Sind Züge und Fahrplan leer, lädt der Demo-Modus `docs/beispiel-fahrplan.json` (zwei Züge, vier Fahrten, einer mit Takt) und setzt die Züge auf ihre Startblöcke; er wird wie das Beispiel-Gleisbild gespeichert. Der virtuelle Zug fährt jede eingestellte Fahrstraße ab (Phase 1); die Fahrplanuhr läuft im Demo-Modus standardmäßig mit Faktor 20.

## Fehlerfälle

| Fall | Verhalten |
|---|---|
| Fahrstraße abgelehnt | Instanz bleibt `waiting` mit Grund, Wiederholung jede Sekunde; nach `lateLimit` → `failed`, kein späterer Start von selbst. |
| Zug nicht im Startblock oder ohne Standort | `waiting` mit Grund, startet nicht. |
| Zug hat andere aktive Fahrt | Zweite Fahrt wartet bis zum Ende der ersten plus Halt. |
| Zwei Fahrten wollen dieselbe Strecke | Die Sicherung lehnt die zweite ab; sie wartet. Die Sicherung wird nie umgangen. |
| Verbindung zur Zentrale weg | Fahrplanuhr hält an (Basiswerte werden fortgeschrieben), Runner startet nichts; nach dem Verbinden bleibt die Uhr gestoppt, bis der Bediener sie startet. |
| Neustart des Servers | Uhr gestoppt, alle Standorte `uncertain`; Instanzen sind nicht gespeichert, laufende Fahrten gelten als `failed` („Neustart“). Die Sicherung ist nicht gespeichert, ein vor dem Neustart auf Fahrt gestelltes Signal kann deshalb stehen bleiben. Bei der ersten Verbindung nach dem Start werden daher einmalig alle Signale, die in gesicherten Fahrstraßen (mit Start- oder Ziel-Block) vorkommen, auf Halt gestellt. |
| Uhr vorwärts gestellt | Verpasste Instanzen werden `cancelled` („verpasst“), nicht nachgeholt. |
| Uhr rückwärts gestellt | Beendete Instanzen bleiben beendet; Instanzen des Tages werden nicht erneut ausgelöst. |
| Fahrstraße oder Block wurde gelöscht oder geändert | Das Gleisbild bleibt speicherbar. Betroffene Fahrten werden nicht ausgeführt: die Instanz wird `failed` mit „Fahrstraße nicht mehr vorhanden“, in der Verwaltung ist die Fahrt als ungültig markiert. Ein Standort in einem gelöschten Block wird entfernt. |
| Lokerkennung widerspricht dem Standort | Standort wird korrigiert (`detected`) und vermerkt. |
| Ungültige Dateien | Ungültige Teile von `trains.json`/`timetable.json` werden ignoriert und im Log gemeldet. |

## Tests

- **`packages/timetable` (rein):**
  - Uhr: Faktor, Stopp, Start, Stellen, Tageswechsel.
  - Takt: Auflösung der Abfahrten, Obergrenze, Randwerte (`until` genau auf einer Abfahrt, `every` größer als der Rest des Tages).
  - Zustandsautomat: jeder Übergang aus dem Diagramm, Wiederholung bei Ablehnung mit wechselnden Gründen, Verspätungsgrenze, „verpasst“ nach Uhr-Sprung, Halt (`dwell`) zwischen zwei Fahrten desselben Zugs, Entfallen nur in erlaubten Status, `forced`/`fault`/`released` aus der Sicherung.
- **Interlocking:** `drainEnded` liefert die richtigen Gründe und leert die Liste.
- **Server (mit Simulator, Zeitraffer wie beim Demo-Test):**
  - Ein Fahrplan mit zwei Zügen läuft vollständig durch; Standort wird mitgeführt.
  - Verbindungsverlust hält die Uhr an; Neustart-Zustand (gestoppt, `uncertain`, laufende Fahrten `failed`).
  - Lokerkennung korrigiert den Standort nur außerhalb einer Fahrt.
  - Konflikt zweier Fahrten wird von der Sicherung abgelehnt, die Fahrt wartet.
  - Ungültige Eingaben der HTTP-Routen (400/404/409).
  - Datensicherung: Roundtrip, Verweisprüfung, Atomarität, Sperre bei aktiver Instanz.
  - `Station.addExtra` mischt mehrere Teile.
- **Web:** Hilfsfunktionen (Formatieren und Parsen von Modellzeit, Statusanzeige) als Unit-Test; die Oberfläche mit Typecheck, Build und Screenshots wie bisher.

## Erfolgskriterien

1. Im Demo-Modus läuft der Beispiel-Fahrplan ohne Eingriff durch: Fahrstraßen werden zur Abfahrtszeit eingestellt, der virtuelle Zug fährt, der Standort wird mitgeführt, der Takt wiederholt sich.
2. Die Abfahrtstafel auf `#/anzeige` zeigt die richtigen Zeiten und Status, ändert sich live und lässt sich nicht bedienen.
3. Jede Ablehnung der Sicherung ist an der Fahrt mit Grund sichtbar, und keine Fahrt umgeht die Sicherung.
4. Nach einem Neustart startet nichts von selbst; die Standorte sind als unsicher markiert.
5. Züge und Fahrplan sind Teil der Datensicherung und werden beim Wiederherstellen vollständig geprüft.
6. Alle Tests, Typecheck und Build sind grün.

## Umsetzungsreihenfolge (für den Plan)

1. Bestand: `Station.addExtra`, `Interlocking.drainEnded`, `SignalBox.tryRequestRoute`, Signale beim ersten Verbinden auf Halt.
2. `packages/timetable` (Uhr, Takt, Dispatcher) mit Tests.
3. `TrainStore` und Züge-Routen; Standort von Hand.
4. `TimetableRunner`, Fahrplan-Routen, Snapshot-Feld, Lokerkennung.
5. Datensicherung um `trains` und `timetable` erweitern.
6. Oberfläche: Verwaltung (Züge, Fahrplan), Bedienen (Tab Fahrplan), Anzeige (Abfahrtstafel).
7. Demo: Beispielfahrplan und Beispielzüge.
8. README und Beispieldatei.
