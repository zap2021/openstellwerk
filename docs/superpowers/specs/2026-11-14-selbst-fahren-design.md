# Selbst fahren: Sicherung für stehende Züge, Fahrautomat, Zielfahrt, Einmessen

## Ziel

Die Punkte 2 bis 4 der Weiterentwicklung: Die Lok fährt selbst über gesicherte Fahrstraßen und hält im Zielblock (Automatik Stufe 2), der Bediener wählt Zug und Ziel statt einzelner Fahrstraßen (Zielfahrt), und Loks lassen sich einmessen (Fahrstufe → Geschwindigkeit).

## 0. Voraussetzung: Sicherung für stehende Züge (`packages/interlocking`)

- Der Startblock einer Fahrstraße mit Zielblock darf beim Anfordern belegt sein (der Zug selbst). Alle anderen Blöcke müssen frei sein.
- „Zug eingefahren“ (Signal auf Halt, Status `running`) heißt: ein Block außer einem anfangs belegten Startblock meldet besetzt.
- Auflösung bei Ankunft: Zielblock erreicht, alle anderen Blöcke frei, Melder des Zielblocks meldet. Der Zug darf im Zielblock stehen bleiben. Fahrstraßen ohne Zielblock wie bisher.

## 1. Fahrautomat (`apps/server/src/auto-drive.ts`)

- Auftrag: Zug, Lokadresse, Fahrstraße, Richtung, Fahrstufe, Kriechzeit. Ein Auftrag je Zug; ein neuer ersetzt den alten ohne Halt.
- Ablauf: warten bis die Fahrstraße `set`/`running` ist → fahren → Zielblock belegt → Kriechfahrt (ein Drittel, mind. Stufe 8) → nach der Kriechzeit Halt (Fahrstufe 0).
- Abbruch mit Halt: Störung, Auflösung unterwegs, Zeitgrenze (5 min). Abbruch ohne Befehl: Handübernahme (Lok angehalten, Richtung gewechselt, Lok-Nothalt), Verbindung getrennt.
- Fahrdaten je Zug (`Train.drive`): `speed`, `stopDelayMs`, `stopCm`. Mit Kennlinie wird `stopCm` in die Kriechzeit umgerechnet.
- Fahrplan: `Trip.drive` (`forward`/`reverse`); der Runner übergibt die Lok einmal, wenn die Abfahrt `set` erreicht.

## 2. Zielfahrt (`apps/server/src/journeys.ts`)

- Breitensuche über die Fahrstraßen mit Start- und Zielblock (wenigste Abschnitte).
- Abschnitt für Abschnitt: anfordern (alle 2 s, höchstens 5 min), auf das Ende warten (`SignalBox.onEnded`), Standort mitführen, nächster Abschnitt.
- Endet eine Fahrstraße anders als `completed`, scheitert die Fahrt; eine gefahrene Lok hält.
- Voraussetzungen: Verbindung, bekannter und bestätigter Standort, keine andere Zielfahrt und keine aktive Fahrplan-Abfahrt des Zugs.
- Benutzer (nicht nur Admins) dürfen Zielfahrten starten und abbrechen.

## 3. Einmessen (`apps/server/src/calibration.ts`)

- Messfahrt je Fahrstufe: Zeit von „Startblock belegt“ bis „Zielblock belegt“ über eine angegebene Strecke; danach Rückfahrt bis beide Blöcke frei sind, Auslauf, nächste Fahrstufe.
- Zeitgrenze je Phase 90 s; jeder Fehler hält die Lok.
- Kennlinie je Lokadresse mit Maßstab; lineare Interpolation vom Stillstand über die Messpunkte.
- Verwendung: km/h am Fahrpult, Halteweg → Kriechzeit.

## Bewusst nicht enthalten

- Durchfahren mehrerer Abschnitte ohne Halt (die Sicherung gibt den nächsten Abschnitt erst nach der Ankunft frei).
- Bremsweg aus Blocklängen, Richtung aus der Gleisgeometrie.
- Erprobung an echter Hardware.
