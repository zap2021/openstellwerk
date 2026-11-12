# Lok-Bilder (Issue #3)

Stand: 2026-11-12. Umsetzung ohne weitere Rückfrage auf Wunsch des Auftraggebers.

## Ziel

Zu jeder Lok lässt sich ein kleines Bild hochladen, das die Lok in der **Lokliste** (Bedienen → Fahren) und im **Kopf des Fahrpults** zeigt. Die Bilder sind Teil der Datensicherung (wählbar).

Nicht Teil dieser Spezifikation: Bilder auf der Abfahrtstafel, bei Zügen und im Fahrplan; mehrere Bilder je Lok; Bildbearbeitung über das Verkleinern hinaus.

### Entscheidungen aus der Abstimmung

| Thema | Entscheidung |
|---|---|
| Anzeige | Lokliste und Fahrpult. |
| Sicherung | Eigener, wählbarer Teil „Lok-Bilder“. |
| Verkleinern | Im Browser (Canvas), der Server speichert nur. Keine neue Abhängigkeit, keine Last auf dem Pi. |
| Ablage | Dateien im Datenordner, nicht in `garage.json`, denn die Garage-Liste steckt in jedem Zustandspaket an den Browser. |

## Server

- **Ablage:** `<DATA_DIR>/loco-images/<adresse>.jpg`. Der Dateiname entsteht nur aus der geprüften Ganzzahl 1..9999; Pfadbestandteile kommen nie aus der Eingabe.
- **`LocoImageStore`** (`apps/server/src/loco-images.ts`): `set(address, jpeg)`, `get(address)`, `remove(address)`, `has(address)`. Ohne Verzeichnis (Tests) lebt es im Speicher. Schreibt atomar (temporäre Datei, dann umbenennen).
- **Prüfung (`checkJpeg(buf)`):** nur echte JPEG-Dateien (Anfangsbytes `FF D8 FF`, Endmarker `FF D9`), mindestens 100 Bytes und höchstens **200 KB**. Alles andere → 400 (Typ/Inhalt) beziehungsweise 413 (zu groß) mit deutscher Meldung.
- **Schnittstellen** (gleiche Anmeldung wie alle `/api`-Routen):
  - `PUT /api/garage/:addr/image` — Rohbild mit `Content-Type: image/jpeg`. Legt den Garage-Eintrag an, falls es ihn nicht gibt (wie das Setzen des Namens). Antwort `{ imageVersion }`.
  - `GET /api/garage/:addr/image` — liefert das Bild (`image/jpeg`, `Cache-Control: no-cache`, `ETag`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`); 404, wenn keins da ist.
  - `DELETE /api/garage/:addr/image` — entfernt das Bild; 404, wenn keins da ist.
- **Garage-Eintrag:** `GarageLoco.imageVersion?: number` (ms-Zeitstempel des letzten Hochladens), gesetzt und gelöscht über `Garage.setImageVersion(address, version | undefined)`. Der Browser hängt ihn als `?v=` an die Bildadresse (neues Bild sofort sichtbar, sonst aus dem Zwischenspeicher). Nach jeder Änderung wird der Zustand gesendet.
- **Aufräumen:** Wird eine Lok aus der Liste entfernt (`DELETE /api/garage/:addr`), wird auch ihr Bild gelöscht. Beim Laden wird `imageVersion` ohne zugehörige Datei verworfen.
- **Adresse:** 1..9999, sonst 400.

## Oberfläche

- **Verkleinern** (`apps/web/src/loco-image.ts`): reine Funktion `fitSize(width, height, max = 256)` (längste Kante höchstens `max`, Seitenverhältnis bleibt, nie vergrößern) und `resizeToJpeg(file)` über `createImageBitmap` und Canvas (JPEG, Qualität 0,82; liegt das Ergebnis über 200 KB, wird mit 0,6 wiederholt). Kann der Browser die Datei nicht lesen, kommt eine klare Meldung („Dieses Bildformat kann der Browser nicht lesen“).
- **Lokliste:** vor der Adresse ein quadratisches Bild (40 px, zugeschnitten); ohne Bild bleibt die Zeile wie bisher.
- **Fahrpult-Kopf:** Bild (72 px) mit den Knöpfen „Bild ändern“ und „Bild entfernen“ (mit Rückfrage). Der Dateidialog nimmt `image/*`, auf dem Handy auch die Kamera. Fehler erscheinen in der bestehenden Fehlerzeile.

## Datensicherung

- Neuer optionaler Teil `locoImages`: `{ "<adresse>": "<base64 des JPEG>" }`. `BACKUP_PARTS` bekommt `locoImages`; das Format bleibt `version: 1`, ältere Dateien lassen sich unverändert wiederherstellen.
- **Herunterladen:** `GET /api/backup?images=0` lässt die Bilder weg; Standard ist **mit** Bildern. Die Oberfläche bietet dazu ein Häkchen „Lok-Bilder einschließen“ (angehakt).
- **Wiederherstellen:** wählbar wie die übrigen Teile. Vorab (alles vor dem ersten Schreiben): Adresse 1..9999, gültiges Base64, `checkJpeg` besteht, und die Adresse gehört zu einer Lok, die es nach der Wiederherstellung gibt (aus dem `garage`-Teil der Datei, sonst aus der aktuellen Garage); sonst 400 ohne Änderung. Danach werden die Dateien geschrieben und `imageVersion` gesetzt. Beim Wiederherstellen des `garage`-Teils ohne `locoImages` bleiben vorhandene Bilder zu weiter existierenden Adressen erhalten; Bilder zu Adressen, die es danach nicht mehr gibt, werden entfernt.

## Fehlerfälle und Sicherheit

| Fall | Verhalten |
|---|---|
| Datei ist kein JPEG / beschädigt | 400 „Das ist kein gültiges JPEG-Bild“ |
| Bild über 200 KB | 413 „Das Bild ist zu groß (höchstens 200 KB)“ |
| Falscher `Content-Type` | 415 (Fastify) bzw. 400 |
| Adresse außerhalb 1..9999 | 400 |
| Datenordner nicht beschreibbar | 500 mit Meldung, Zustand unverändert (zuerst Datei, dann Version) |
| Bild ohne Garage-Eintrag beim Wiederherstellen | 400 vorab |

Der Pfad entsteht nie aus Benutzertext. Ausgeliefert wird nur, was `checkJpeg` bestanden hat. Die Datei wird nicht interpretiert, nur durchgereicht.

## Tests

- **Server:** `checkJpeg` (gültig, zu klein, falsche Anfangsbytes, kein Endmarker, zu groß); Routen per `inject` (Hochladen legt Garage-Eintrag an und setzt `imageVersion`; GET liefert dieselben Bytes mit den Kopfzeilen; Ersetzen ändert die Version; DELETE; 404; falscher Typ und falscher Inhalt; zu groß → 413; ungültige Adresse); Löschen der Lok entfernt das Bild; Neustart behält Bild und Version (Verzeichnis); Version ohne Datei wird beim Laden verworfen.
- **Sicherung:** Roundtrip mit und ohne `?images=0`; Wiederherstellen nur der Bilder; ungültiges Bild oder fremde Adresse → 400 und nichts geändert; älteres Format ohne `locoImages`.
- **Oberfläche:** `fitSize` (Quer-, Hoch-, Quadratformat, kleiner als das Maximum, extreme Seitenverhältnisse, Mindestgröße 1).

## Erfolgskriterien

1. Ein hochgeladenes Foto erscheint nach der Verkleinerung sofort in Liste und Fahrpult und bleibt nach einem Neustart erhalten.
2. Die Garage-Liste im Zustandspaket enthält nur die Versionsnummer, nie Bilddaten.
3. Falsche oder zu große Dateien werden mit klarer Meldung abgelehnt und verändern nichts.
4. Die Datensicherung enthält die Bilder wählbar und stellt sie vollständig oder gar nicht wieder her.
5. Alle Tests, Typecheck und Build sind grün.
