# Anlagen-Regeln: Rückmelder lösen Aktionen aus

## Ziel

Rückmelder sollen ohne PC-Programm etwas auslösen können (häufigster Forenwunsch an die Z21-App): Wird ein Block belegt oder frei, stellt der Server Weichen, Signale oder Fahrstraßen oder hält die Lok im Block an.

Nicht Teil dieser Version: Lok-Regeln mit Ort, Gleisspannung aus/Nothalt als Aktion, selbstständiges Fahren (Automatik Stufe 2).

## Regel

Eine Regel gehört zur Anlage (nicht zu einer Lok) und besteht aus Auslöser → Bedingungen → Aktionen.

- **Auslöser:** Block wird belegt oder Block wird frei. Optional `holdMs` (0..60 s): die Regel löst erst aus, wenn der Zustand so lange ununterbrochen anhält (Entprellung).
- **Bedingungen** (alle müssen im Moment des Auslösens gelten): anderer Block belegt/frei; Weiche/Signal in bestimmter Lage; Fahrstraße aktiv / nicht aktiv (aktiv = von der Sicherung angefordert, egal in welchem Status).
- **Aktionen** (1..10, je optional `delayMs` 0..60 s):
  - `tile`: Element des Gleisbilds in eine Lage bringen
  - `route` mit `request` oder `release`: gesicherte Fahrstraße anfordern oder auflösen (ohne Notauflösung)
  - `stopLoco`: jede im auslösenden Block erkannte Lok anhalten

Grenzen: höchstens 100 Regeln, 10 Bedingungen und 10 Aktionen je Regel.

## Verhalten

- Ausgewertet wird bei jeder Zustandsänderung der Zentrale, nur solange eine Verbindung besteht (auch im Demo-Modus).
- Ein Wechsel zählt nur zwischen zwei bekannten Zuständen. Das erste Lesen nach Start oder Verbindung löst nichts aus; „unbekannt“ (Melder ausgefallen oder nicht verknüpft) ist weder belegt noch frei und wird übersprungen.
- Mindestabstand je Regel: 2 s (Schutz vor Schleifen und flackernden Meldern).
- Stellbefehle laufen über `SignalBox`: `setTile` (lehnt verriegelte Felder ab), `tryRequestRoute`, `releaseRoute`. Die Sicherung entscheidet; eine Regel kann sie nicht umgehen.
- `stopLoco` kennt die Lok aus den Meldern (LocoNet-Transponder, CAN/RailCom) oder aus dem Standort eines Zuges (`trains.json`). Ohne erkannte Lok passiert nichts; das Ergebnis sagt es.
- Verweist eine Regel auf einen Block, ein Feld oder eine Fahrstraße, die es im Gleisbild nicht (mehr) gibt, wird sie nicht ausgeführt und in der Oberfläche als fehlerhaft markiert. Sie bleibt gespeichert.
- Trennen der Verbindung verwirft offene Verzögerungen und den gemerkten Blockzustand. Speichern der Regeln verwirft offene Verzögerungen.
- Je Regel merkt sich der Server das letzte Auslösen mit dem Ergebnis jeder Aktion (nur im Speicher).

## Bausteine

- `apps/server/src/layout-rules.ts`
  - `validateRules(raw)`: Aufbau prüfen, normalisieren.
  - `missingRefs(rule, layout)`: fehlende Verweise als Texte.
  - `blockStates(layout, live)`, `conditionsHold(...)`: reine Auswertung.
  - `LayoutRuleStore`: `layout-rules.json` im Datenordner.
  - `LayoutRuleEngine`: Wechsel erkennen, Entprellung, Mindestabstand, Aktionen über eine schmale Schnittstelle (`RuleActions`), Ergebnisse merken.
  - `locosInBlock(...)`: Lokadressen in einem Block.
  - Routen `GET/PUT /api/layout-rules` (nur Admin; Standard in `roles.ts`).
- `apps/server/src/main.ts`: Verdrahtung mit `Station`, `SignalBox`, `TrainStore`.
- `apps/server/src/backup.ts`: wählbarer Teil `layoutRules`.
- `apps/web/src/layout-rules.tsx`: Seite **Verwaltung → Anlage → Regeln** mit Liste, Editor (Auswahlfelder aus dem Gleisbild), Markierung fehlerhafter Regeln und „zuletzt ausgelöst“.

## Tests

- Prüfung: gültige und ungültige Regeln, Grenzen.
- Auswertung: erster Zustand löst nichts aus; belegt/frei; unbekannt wird übersprungen; Bedingungen; Entprellung; Mindestabstand; Verzögerung; Regeln mit fehlenden Verweisen laufen nicht; getrennt = nichts.
- Aktionen: verriegeltes Feld und abgelehnte Fahrstraße erscheinen als Ergebnis; `stopLoco` mit und ohne erkannte Lok.
- Routen und Datensicherung: Roundtrip, fehlerhafte Datei ändert nichts.
