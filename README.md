# OpenStellwerk

Projektseite: <https://openstellwerk.de> · Quellcode, Releases und Issues: <https://github.com/zap2021/openstellwerk>

Freie Modellbahnsteuerung im Browser für Zentralen mit Z21-LAN-Protokoll: Fahren, Stellwerk mit gesicherten Fahrstraßen, Fahrplan und Verwaltung. Ersetzt außerdem die meisten Funktionen der `Z21_Maintenance.exe` (Windows/Delphi). Läuft auf macOS, Linux und Windows mit Node.js ≥ 22.

OpenStellwerk ist ein privates Projekt und kein Produkt von Roco, Fleischmann oder der Modelleisenbahn GmbH und wird von ihnen nicht unterstützt. „Z21“ ist eine Marke ihres Inhabers und steht hier nur für das Gerät und sein öffentlich dokumentiertes LAN-Protokoll. Bis Version 0.4.1 hieß das Projekt „z21-web“.

## Architektur

```
Browser (React/Vite)  ──HTTP + WebSocket──▶  Node-Server (Fastify)  ──UDP :21105──▶  Z21
                                                  │                  ──Serial (später)──▶ zLink-USB
                                                  └── @openstellwerk/protocol (Codec, ohne I/O)
```

Ein Browser kann weder UDP noch zuverlässig serielle Ports ansprechen (Web Serial gibt es nicht in Safari/Firefox). Deshalb übernimmt ein lokaler Node-Server die Hardware-Anbindung; die Oberfläche läuft im Browser und ist damit auch auf Tablet/Handy am Anlagenrand nutzbar.

| Paket | Inhalt |
|---|---|
| `packages/z21-protocol` | Frames, XOR-Checksummen, Befehle, Antwort-Parser. Reines TypeScript, ohne I/O, mit Tests. |
| `packages/interlocking` | Stellwerkslogik (Sicherung): Zustandsautomat für Fahrstraßen mit Verriegelung, Belegtprüfung und Auflösung. Rein, ohne I/O, mit Tests. |
| `packages/z21-simulator` | Z21 in Software (UDP). Entwicklung und Tests ohne Hardware. |
| `apps/server` | UDP-Client mit Keepalive, `Station`-Modell (Zustand der Zentrale), REST- und WebSocket-API. |
| `apps/web` | Oberfläche: Zentrale, Fahren, Weichen, CV-Programmierung, Protokoll-Monitor. |

Die Sicherung (`packages/interlocking`) läuft im Server oberhalb von `Station` und nutzt die Schaltqueue der `SignalBox`. Der Fahrplan (`packages/timetable`, Automatik Stufe 1) baut darauf auf und fordert die gesicherten Fahrstraßen zur Abfahrtszeit an. `Station` ist die einzige Stelle, die Hardware-Zustand besitzt.

## Starten

```bash
npm install
npm run dev        # Simulator + Server (:3001) + Web (:5173)
```

Dann <http://localhost:5173> öffnen und mit `127.0.0.1` (Simulator) oder der IP der echten Z21 verbinden. Der Server bindet standardmäßig nur an `127.0.0.1` und fragt dann kein Passwort ab. Für den Zugriff aus dem Netz siehe „Dauerbetrieb“.

## Dauerbetrieb (z. B. Raspberry Pi 3 ohne Bildschirm)

```bash
npm ci
npm run build                                   # Oberfläche einmal bauen (apps/web/dist)
NODE_ENV=production HOST=0.0.0.0 OPENSTELLWERK_PASSWORD='…' npm start
```

Ein einziger Node-Prozess liefert Oberfläche, API und WebSocket auf Port 3001 aus (rund 90 MB RAM). Bedient wird im Browser eines anderen Geräts: `http://<adresse-des-pi>:3001`.

| Variable | Bedeutung |
|---|---|
| `HOST`, `PORT` | Bindeadresse und Port (Standard `127.0.0.1:3001`) |
| `OPENSTELLWERK_PASSWORD` | Gemeinsames Passwort. **Pflicht**, sobald `HOST` nicht `127.0.0.1` ist – ohne startet der Server nicht (bewusst offen: `OPENSTELLWERK_ALLOW_OPEN=1`) |
| `DATA_DIR` | Ordner für Lokliste, Kameras und Gleisbild (Standard `apps/server/data`) |
| `LOG_LEVEL` | Standard `warn` bei `NODE_ENV=production` (schont die SD-Karte), sonst `info` |
| `TLS_CERT`, `TLS_KEY` | Pfade zu Zertifikat und Schlüssel: der Server spricht dann selbst HTTPS und lädt erneuerte Dateien ohne Neustart nach |
| `TRUST_PROXY=1` | Hinter einem Proxy (Caddy, nginx): `X-Forwarded-*` auswerten |
| `OPENSTELLWERK_REQUIRE_HTTPS=1` | Anmeldung über unverschlüsseltes HTTP ablehnen |

Installationen aus der Zeit vor der Umbenennung (bis 0.4.1) laufen weiter: Wo eine Variable `OPENSTELLWERK_…` fehlt, gilt die gleichnamige mit dem alten Präfix `Z21_…`. Sicherungsdateien aus dieser Zeit lassen sich weiter einspielen.

### Raspberry Pi: Installation per Kommandozeile

Voraussetzungen sind Raspberry Pi OS (ARM64/64 Bit oder ARMv7/32 Bit), Internetzugang, `sudo`, systemd und ein Projekt-Checkout auf dem Pi. Im Projektverzeichnis ausführen:

```bash
sudo bash deploy/install-raspberry-pi.sh
```

Das Skript fragt interaktiv nach einem Passwort (druckbare ASCII-Zeichen), installiert fehlende Hilfsprogramme und bei Bedarf Node.js 22 passend zur Architektur, kopiert das Projekt nach `/opt/openstellwerk`, baut die Oberfläche und aktiviert den systemd-Dienst. Die Konfiguration liegt in `/etc/openstellwerk.env`, die Anwendungsdaten liegen in `/var/lib/openstellwerk`. Anschließend `http://<adresse-des-pi>:3001` im Browser öffnen. `npm ci` und der Build können auf einem Pi 3 einige Minuten dauern.

Das Skript ist für eine **Erstinstallation** gedacht: Es überschreibt weder eine vorhandene Installation noch eine bestehende Konfiguration oder Dienstdatei. Nach einem Fehler bleiben bereits angelegte Dateien zur Prüfung erhalten; für einen erneuten Versuch müssen diese gezielt geprüft und gegebenenfalls entfernt werden. Bestehende Daten in `/var/lib/openstellwerk` werden nicht gelöscht.

```bash
sudo systemctl status openstellwerk      # Dienststatus
sudo journalctl -u openstellwerk -f      # Protokoll
sudo systemctl restart openstellwerk     # nach Konfigurationsänderungen
```

Bei Netzwerkkameras einen kleinen Stream (Substream) wählen, jedes Bild läuft durch den Pi.

**HTTPS (optional):** Ohne HTTPS ist das Passwort im Netz mitlesbar. Let's Encrypt stellt nur für einen öffentlichen Domainnamen aus, nicht für `192.168.x.x`.
- *Empfohlen:* Caddy davor, siehe `deploy/Caddyfile`. Caddy holt und erneuert das Zertifikat selbst; mit der DNS-Bestätigung (DNS-01) muss kein Port aus dem Internet erreichbar sein.
- *Ohne Proxy:* Zertifikat z. B. mit certbot holen und `TLS_CERT=/etc/letsencrypt/live/<domain>/fullchain.pem`, `TLS_KEY=…/privkey.pem` setzen (der Dienst-Benutzer braucht Leserechte). Geht auch mit einem selbst erstellten Zertifikat.

Build und manueller Produktionsstart wurden auf einem Raspberry Pi mit Raspbian 11 (ARMv7) getestet; die vollständige Installation als Dienst noch nicht.

### Version und Update

Die installierte Version steht oben in der Kopfzeile neben „OpenStellwerk“ (z. B. `v0.5.9`) und über `GET /api/version`. Sie kommt aus dem `version`-Feld der `package.json`; Releases sind Git-Tags der Form `vX.Y.Z` mit einem GitHub-Release im öffentlichen Repository `zap2021/openstellwerk`.

**Update aus der Oberfläche** (Verwaltung → Verbindung → Update, nur Admin). Der Server fragt GitHub alle 12 Stunden nach dem neuesten Release; Admins sehen dann oben „Update vX.Y.Z“. Die Seite zeigt die Release-Notizen und spielt die Version auf Knopfdruck ein:

1. Archiv des Release-Tags laden und in einen Arbeitsordner entpacken (`<Datenordner>/update/staging`)
2. dort `npm ci` und `npm run build`
3. Probelauf: Die neue Version startet auf einem freien Port mit leerem Datenordner und muss antworten
4. die laufende Installation nach `<Datenordner>/update/previous` sichern
5. die neue Version einspielen und den Prozess beenden; systemd startet ihn neu (`Restart=on-failure`)

Scheitert ein Schritt vor 5, bleibt die laufende Installation unberührt und die Seite zeigt den Grund. Die Anwendungsdaten werden nie angefasst. Solange Fahrstraßen angefordert sind oder eine Zielfahrt, eine Fahrplanfahrt oder eine Messreihe läuft, startet kein Update. Alles läuft als Dienstbenutzer, ohne root; auf einem Raspberry Pi 3 dauert es einige Minuten.

Einstellungen in `/etc/openstellwerk.env` (danach `sudo systemctl restart openstellwerk`):

| Variable | Bedeutung |
|---|---|
| `OPENSTELLWERK_UPDATE_REPO` | GitHub-Repository „besitzer/name“, Standard `zap2021/openstellwerk` (nur für einen eigenen Fork nötig). Ein alter Eintrag `sebastian/z21-web` wird ignoriert. |
| `OPENSTELLWERK_UPDATE_TOKEN` | Optional. Für Update und Prüfung ist kein Token nötig, das Repository ist öffentlich; ein ungültiges (z. B. altes) Token wird dabei übergangen. Nur der Knopf „Problem melden“ braucht eins: ein GitHub-Token (fine-grained, nur dieses Repository, Berechtigung „Issues: Lesen und Schreiben“). |
| `OPENSTELLWERK_UPDATE_CHECK=0` | keine regelmäßige Prüfung (die Seite kann weiter von Hand prüfen) |

**Zurück zur vorherigen Version**, falls die neue nach dem Neustart Ärger macht (über SSH):

```bash
sudo systemctl stop openstellwerk
sudo rsync -a --delete /var/lib/openstellwerk/update/previous/ /opt/openstellwerk/
sudo chown -R openstellwerk: /opt/openstellwerk && sudo systemctl start openstellwerk
```

**Update von Hand** (ohne Zugriff des Pi auf GitHub); die Daten in `/var/lib/openstellwerk` und `/etc/openstellwerk.env` bleiben unberührt:

```bash
# auf dem Rechner mit dem Checkout (neue Version ausgecheckt, z. B. git checkout v0.5.9)
rsync -az --delete --exclude=.git --exclude=node_modules --exclude='*/node_modules' --exclude='*/dist' ./ <pi>:/tmp/openstellwerk-new/

# auf dem Pi
sudo tar -czf ~/openstellwerk-backup-$(date +%Y%m%d).tgz --exclude=node_modules -C / opt/openstellwerk var/lib/openstellwerk   # Sicherung
sudo rsync -a --delete --exclude=node_modules --exclude='*/node_modules' --exclude='*/dist' /tmp/openstellwerk-new/ /opt/openstellwerk/
sudo chown -R openstellwerk: /opt/openstellwerk && sudo systemctl stop openstellwerk
sudo runuser -u openstellwerk -- env PATH="/opt/openstellwerk-node/bin:/usr/bin:/bin" bash -c 'cd /opt/openstellwerk && npm ci && npm run build'
sudo systemctl start openstellwerk && sudo journalctl -u openstellwerk -n 20 --no-pager
```

(`/opt/openstellwerk-node/bin` gilt, wenn das Skript Node.js selbst installiert hat; sonst den Pfad des systemweiten Node verwenden.)

### Als App auf dem Handy oder Tablet

Die Seite bringt ein App-Icon und ein Web-Manifest mit. Auf **iOS/iPadOS** in Safari „Teilen → Zum Home-Bildschirm“: Die Oberfläche startet dann ohne Browserleisten, auch ohne HTTPS. Unter **Android** legt Chrome ohne HTTPS nur ein Lesezeichen mit Icon an; als eigenständige App lässt sie sich erst mit HTTPS und einem gültigen Zertifikat installieren (siehe „HTTPS“ oben, am einfachsten mit Caddy). In jedem Browser schaltet der Knopf ⤢ oben rechts auf **Vollbild**.

## Gestaltung

Die Oberfläche ist einem Stelltisch nachempfunden: ein dunkles Pult trägt die Tischfelder mit den Inhalten. Zustände leuchten wie am Gleisbildstellwerk: **gelb** = gestellt oder gewählt, gelb blinkend = wird gestellt, **rot** = belegt oder Störung, **grün** nur für Signal „Fahrt“ und Gleisspannung. Gewählte Tasten sind dunkel mit gelbem Leuchtstreifen, die Fahrstufe erscheint als Leuchtband.

Der Knopf **Nacht** in der Kopfzeile schaltet die Nachtschaltung (dunkle Felder, Standard) aus und ein; ohne sie sind die Felder hell. Die Wahl bleibt je Browser gespeichert. Schrift ist Barlow (SIL Open Font License), sie wird mit der App ausgeliefert und braucht kein Internet. Auf schmalen Bildschirmen bleibt der Nothalt am unteren Rand stehen. Farben und Maße stehen als Variablen am Anfang von `apps/web/src/styles.css`.

## Tests

```bash
npm test           # Protokoll- und Integrationstests (Simulator ↔ Server)
npm run typecheck
```

## Stand

Umgesetzt ist das **gesamte öffentliche Z21-LAN-Protokoll** (Spezifikation V1.13, Kap. 2–12), gebaut und getestet gegen die offiziellen Beispiel-Frames und gegen den Simulator:

| Reiter | Inhalt | Spez.-Kapitel |
|---|---|---|
| Zentrale | Suche im Netz, Status, Firmware (BCD), Seriennummer, z21-start-Sperre, Strom/Spannung/Temperatur | 2 |
| Fahren | Geschwindigkeit, Richtung, F0–F31, Lok-Nothalt, Lok entfernen, Ausgabeformat DCC/Motorola, Binärzustände | 3, 4 |
| Stellwerk | Gleisbild-Editor auf Kachelraster, verknüpft mit Weichen, Signalen (Weichenadresse oder DCCext) und Besetztmeldern (R-BUS, LocoNet, CAN); Blöcke und gesicherte Fahrstraßen (siehe unten). Beispiel zum Importieren: `docs/beispiel-gleisbild.json` | 5, 7–10 |
| Weichen | Schalten, Ausgabeformat DCC/Motorola | 3, 5 |
| Signale | DCCext (RCN-213): Signalbilder 10837, Weichen mit Schaltzeit 10836, Zubehör-Nothalt | 5.4–5.6 |
| CV-Programmierung | Programmiergleis (direkt), POM Lok (Byte/Bit/Lesen per RailCom), POM Zubehör, Registermodus, Motorola | 6 |
| R-BUS | Rückmeldemodule 1–20, Modul-Adresse programmieren | 7 |
| Uhr | Modellbahn-Uhr: Anzeige, Start/Stopp, Zeit/Faktor, dauerhafte Einstellungen | 12 |
| Booster | CAN-Booster 10806/7/9 an der Z21: Status, Namen, Ausgänge einzeln schalten | 10.2 |
| Gerät | zLink-Booster und -Decoder 10836/10837 hinter einem 10838 Z21 pro LINK: Status, Namen, Ausgänge | 11 |
| RailCom, LocoNet, Melder | Monitore, LocoNet-Rohnachrichten, LocoNet-/CAN-Gleisbesetztmelder | 8, 9, 10.1 |

Die Monitore (RailCom, LocoNet, Melder, R-BUS, Booster, Uhr) sind standardmäßig aus, weil sie viel Netzwerkverkehr erzeugen; der Server aktiviert die Broadcast-Flags nur, solange der Reiter offen ist.

### Gesicherte Fahrstraßen und Anzeige

Im Gleisbild-Editor fasst du Gleisfelder zu **Blöcken** zusammen; ein Block gilt als belegt, sobald einer seiner Melder belegt meldet. Eine Fahrstraße mit Start- oder Ziel-Block ist **gesichert**. Streckenblöcke ohne Weiche trägst du bei der Fahrstraße unter „Blöcke dazwischen“ ein, sonst werden sie weder geprüft noch verriegelt. Schritte einer Fahrstraße müssen schaltbare Felder sein (Weiche, Signal):

- Sie wird nur eingestellt, wenn alle ihre Blöcke sicher frei sind. Einzige Ausnahme ist der Startblock: Er darf belegt sein, denn dort steht der Zug, für den die Fahrstraße ist. Ein Melder, der noch nichts gemeldet hat, zählt nicht als frei.
- Weichen werden zuerst gestellt, das Startsignal erst, wenn alle Lagen zurückgemeldet sind. Sie bleiben verriegelt: Handschaltung (auch über den Weichen-Tab, die Signal-Seite und „Testen“ im Editor) und ungesicherte Fahrstraßen auf diese Adressen werden abgelehnt. Halt-Befehle der Sicherung überholen andere Schaltaufträge in der Warteschlange.
- Fährt der Zug ein (ein anderer Block als der schon belegte Startblock meldet besetzt), geht das Signal auf Halt. Die Fahrstraße löst sich auf, sobald der Zug angekommen ist: Der Zielblock wurde erreicht und alle anderen Blöcke sind wieder frei; im Zielblock darf der Zug stehen bleiben. Eine kurze Lücke zwischen zwei Meldern löst nichts aus. Erreicht der Zug das Ziel nie, bleibt sie bis zur Notauflösung verriegelt.
- Wird eine verriegelte Weiche verstellt, fällt ein Block aus oder melden die Weichen nicht rechtzeitig (15 s), geht die Fahrstraße in **Störung**: Signal auf Halt, Verriegelung bleibt, bis du sie quittierst. Eine Fahrstraße mit Zug darin löst nur die Notauflösung.
- Bei getrennter Verbindung friert die Sicherung ein und löst nichts auf.
- Gleisbild-Änderungen sind nur ohne angeforderte Fahrstraßen möglich.

Die Sicherung braucht Belegtmelder. Ohne sie lassen sich Fahrstraßen nicht einstellen (im Simulator über `sim.extras.setRmBus` testen). Auflösung gibt es bisher nur für die ganze Fahrstraße, nicht blockweise; Flankenschutz-Weichen lassen sich über die JSON-Datei (`flank`) eintragen, noch nicht im Editor.

**Anzeige für einen zweiten Bildschirm:** `http://<adresse>:3001/#/anzeige` zeigt die Fahrplanuhr (siehe unten), eingestellte Fahrstraßen und das Gleisbild live, ohne Bedienelemente. Die Seite braucht dieselbe Anmeldung wie die Bedienung (Sitzung bleibt 30 Tage).

### Fahrplan und Abfahrtstafel

- **Züge** (Verwaltung → Züge): Name, Nummer (z. B. „RE 1“) und Lokadresse. Den **Standort** (Block) setzt du von Hand; nach einem Neustart oder wenn die Automatik den Zug nicht sicher verfolgen kann, gilt er als **unsicher** und wird so angezeigt, bis du ihn bestätigst oder neu setzt. Ein Zug mit unsicherem Standort startet keine Fahrplanfahrt.
- **Fahrten** (Verwaltung → Fahrplan): ein Zug fährt auf einer gesicherten Fahrstraße zu einer Abfahrtszeit, mit Haltezeit und Zieltext. Mit **Takt** wiederholt sich die Fahrt alle N Minuten bis zu einer Endzeit.
- **Fahrplanuhr** (Bedienen → Fahrplan): eigene Modellzeit, unabhängig von der Z21-Uhr. Start/Stopp, Faktor (1 bis 120) und „Uhr stellen“. Sie läuft nur bei bestehender Verbindung.
- **Automatik (Stufe 1):** Zur Abfahrtszeit fordert der Server die gesicherte Fahrstraße an und stellt Weichen und Signal. Die Lok fährst du am Fahrregler, oder der Server fährt sie (Stufe 2, siehe unten). Lehnt die Sicherung die Fahrstraße ab (z. B. Block belegt), wartet die Abfahrt und versucht es erneut; ist die **Verspätungsgrenze** (Minuten, Standard 5) überschritten, geht sie in Störung. Erreicht der Zug den Zielblock, steht er dort als „mitgeführt“.
- **Abfahrtstafel:** `#/anzeige` zeigt die nächsten Abfahrten mit Fahrplanuhr statt Z21-Uhr.
- **Nach einem Neustart:** Fahrplanuhr gestoppt, alle Standorte unsicher, und die Signale gesicherter Fahrstraßen gehen bei jedem Verbinden auf Halt, solange keine Fahrstraße eingestellt ist.
- **Datensicherung:** enthält Züge (ohne Standort) und den Fahrplan (Fahrten, Verspätungsgrenze).
- **Demo-Modus:** lädt Beispielzüge und einen Beispielfahrplan, wenn noch keine Züge und Fahrten existieren und das Gleisbild die Blöcke und Fahrstraßen des Beispiels hat; die Uhr startet bei 05:58 mit Faktor 20. Beim Start wählst du das Beispiel:
  - **Bahnhof mit Zufahrt** (`docs/beispiel-gleisbild.json`, Fahrplan `docs/beispiel-fahrplan.json`): zwei Züge pendeln zwischen Zufahrt und zwei Bahnhofsgleisen; die Loks fährst du selbst.
  - **Rundkurs** (`docs/beispiel-rundkurs.json`, Fahrplan `docs/beispiel-rundkurs-fahrplan.json`): ein Oval mit zweigleisigem Bahnhof, fünf Blöcken (Gleis 1, Gleis 2, Strecke West, Nord, Ost) und sechs Fahrstraßen im Uhrzeigersinn. Ein Güterzug und eine Regionalbahn umrunden den Kurs im 20-Minuten-Takt, der Server fährt die Loks (Automatik Stufe 2) und hält sie in jedem Block.

  Gibt es schon ein anderes Gleisbild, fragt die Oberfläche, ob das Beispiel es ersetzen soll. Züge und Fahrplan des Beispiels kommen nur in einen leeren Fahrplan.
- **Automatik (Stufe 2), Lok fährt selbst:** Bei einer Fahrt stellst du unter „Lok fahren“ ein, ob der Server die Lok vorwärts oder rückwärts fährt. Er fährt erst an, wenn die Sicherung die Fahrstraße gestellt hat, bremst beim Einfahren in den Zielblock auf Kriechfahrt und hält dort an. Ein Pendelzug sind zwei Fahrten im Takt mit entgegengesetzter Richtung.

**Problem melden.** In der Kopfzeile jeder Seite öffnet „Problem melden“ einen Dialog: Fehler oder Wunsch, Titel, Beschreibung, auf Wunsch der eigene Name als Absender. Die Vorschau zeigt genau den Text, der gesendet wird; es wird nichts automatisch erfasst. „Senden“ legt über den Server ein Issue im Update-Repository an (gleiches Token, höchstens eine Meldung je 20 s und Person; Label `bug` oder `enhancement`, wenn es existiert). Ohne Token oder ohne Schreibrecht erklärt der Dialog das, und „Text kopieren“ bleibt möglich.

### Selbst fahren: Fahrautomat, Zielfahrt, Einmessen

**Fahrautomat.** Er fährt eine Lok über eine gesicherte Fahrstraße und stellt selbst nichts: Weichen, Signale und Verriegelung bleiben Sache der Sicherung.

- Fahrdaten je Zug (Verwaltung → Züge): Fahrstufe (Standard 40), Kriechzeit im Zielblock (Standard 1,5 s) und optional ein Halteweg in cm. Im Zielblock fährt die Lok mit einem Drittel der Fahrstufe (mindestens Stufe 8) weiter und hält dann.
- Störung oder Auflösung der Fahrstraße unterwegs: Die Lok hält sofort. Erreicht sie das Ziel nicht in 5 Minuten, hält sie ebenfalls.
- Hältst du die Lok am Fahrregler an, wechselst die Richtung oder löst den Lok-Nothalt aus, lässt der Automat die Lok los und fährt nicht wieder an. Änderst du nur die Geschwindigkeit, hält er trotzdem im Ziel.
- Gehalten wird mit Fahrstufe 0, also mit der Bremsverzögerung des Decoders (CV 4). Wie weit die Lok im Zielblock kommt, hängt davon ab; taste dich mit der Kriechzeit heran.

**Zielfahrt** (Bedienen → Fahrplan). Zug und Zielblock wählen: Der Server sucht die kürzeste Kette gesicherter Fahrstraßen vom Standort des Zugs zum Ziel und stellt sie Abschnitt für Abschnitt. Wahlweise fährst du selbst, oder der Server fährt die Lok vorwärts bzw. rückwärts. Ist ein Abschnitt nicht frei, wartet die Fahrt und fordert ihn alle 2 s neu an, höchstens 5 Minuten. Zwischen zwei Abschnitten hält die Lok kurz, bis die nächste Fahrstraße steht. Der Standort des Zugs muss bekannt und bestätigt sein. REST: `GET/POST /api/journeys`, `POST /api/journeys/:id/cancel`.

**Einmessen** (Verwaltung → Programmieren → Einmessen). Misst die Geschwindigkeit einer Lok je Fahrstufe über zwei Blöcke mit Meldern: Zeit vom Belegen des Startblocks bis zum Belegen des Zielblocks über eine Strecke, die du in cm angibst. Die Lok steht vor dem Startblock, beide Blöcke sind frei; nach jeder Messung fährt sie selbst zurück vor die Messstrecke. Jede Phase hat eine Zeitgrenze von 90 s, bei jedem Fehler und bei „Abbrechen“ hält die Lok. Aus den Messpunkten entsteht eine Kennlinie (Fahrstufe → cm/s, mit dem Maßstab in km/h umgerechnet). Sie zeigt am Fahrpult die Geschwindigkeit in km/h und rechnet den Halteweg eines Zugs in die passende Kriechzeit um. Gespeichert in `calibration.json`, Teil der Datensicherung.

**Mit echter Hardware noch nicht erprobt.** Fahrautomat, Zielfahrt und Einmessen sind mit Tests und im Demo-Modus geprüft, nicht an einer echten Anlage. Beginne mit niedriger Fahrstufe und bleib beim ersten Versuch am Nothalt. Die Messfahrt beim Einmessen prüft keine Fahrstraße: Sorge selbst für freie Strecke und richtig gestellte Weichen.

### Noch nicht enthalten

| Funktion der `Z21_Maintenance.exe` | Grund |
|---|---|
| **Firmware-Updates** (Z21, Booster, Decoder, Multimaus, LocoNet-Adapter, Zimo MX/MS inkl. Sound/SUSI) | Proprietärer Bootloader, nicht öffentlich dokumentiert. Erfordert Reverse Engineering und ein Testgerät; ein Fehler beim Flashen kann das Gerät unbrauchbar machen. Bewusst nicht „blind“ gebaut. |
| LNCV lesen/schreiben (Uhlenbrock) | Nicht in der Z21-Spezifikation; das Bitpacking der LocoNet-Nachrichten ist hier nicht verifiziert. |
| IP-/WLAN-Einstellungen, Signaltyp/Signal Box, Decoder-Konfiguration über die EXE-Oberfläche | Teils proprietär bzw. nur über CV-Zugriff möglich (CV-Reiter funktioniert auch an den zLink-Decodern). |
| Zimo-Decoder-Updates, Multimaus-Update, CAN-Detektor-Firmware | siehe Firmware-Updates |

Diese Teile sind vorgesehen, sobald Testhardware vorhanden ist.

## Lok-Bilder

Unter **Bedienen → Fahren** lässt sich zu jeder Lok ein kleines Bild hinzufügen („Bild hinzufügen“ im Kopf des Fahrpults, auf dem Handy auch direkt mit der Kamera). Der Browser verkleinert das Foto auf höchstens 256 Pixel Kantenlänge und lädt es als JPEG hoch; der Server nimmt nur echte JPEG-Dateien bis 200 KB an. Das Bild erscheint in der Lokliste und im Fahrpult. Gespeichert wird es als Datei im Datenordner (`loco-images/<adresse>.jpg`); im Zustand, den der Server an die Browser schickt, steht nur eine Versionsnummer. Wird eine Lok aus der Liste entfernt, verschwindet auch ihr Bild.

## Automatik je Lok

Unter **Bedienen → Fahren** hat jede Lok drei Untermenüs: **Fahren** (Fahrpult und Funktionen), **Automatik** und **Einstellungen** (Name, Bild, Beschriftung der Funktionen, Format in der Zentrale, Binärzustand, Lok aus der Zentrale entfernen). Ein Automatismus besteht aus **Auslöser → Bedingungen → Aktionen** (nach dem Muster von Home Assistant):

- **Auslöser:** Lok fährt an, hält an, beschleunigt, bremst, Richtung wechselt, Lok-Nothalt, Funktion wird ein-/ausgeschaltet.
- **Bedingungen** (alle müssen zutreffen): Richtung, fährt/steht, Funktion ein/aus.
- **Aktionen:** Funktion F0–F28 ein-, ausschalten oder umschalten, optional mit Verzögerung und (beim Einschalten) mit Dauer.

Die Funktionsbezeichnungen der Lok erscheinen in den Auswahlfeldern. Gespeichert wird in `automations.json` im Datenordner. Beschleunigen und Bremsen lösen höchstens alle 3 s aus, alle anderen Auslöser höchstens alle 0,5 s je Automatismus. Eine Funktion, die ein Automatismus eben selbst geschaltet hat, löst 1,5 s lang keinen weiteren aus (Schutz vor Schleifen). Offene Verzögerungen verfallen, wenn die Verbindung getrennt wird. REST: `GET/PUT /api/locos/:addr/automations`.

## Regeln der Anlage (Rückmelder lösen etwas aus)

Unter **Verwaltung → Anlage → Regeln** (Admin) legst du Regeln nach dem Muster **Auslöser → Bedingungen → Aktionen** an, unabhängig von einer Lok:

- **Auslöser:** Ein Block wird belegt oder frei, auf Wunsch erst, wenn das eine einstellbare Zeit so bleibt (gegen flackernde Melder). Oder ein **Taster**: Die Regel wird zum Ablauf (Makro) und erscheint mit ihrem Namen als Knopf oben in der Bedienung, auch für Benutzer ohne Admin-Rolle.
- **Bedingungen** (alle müssen zutreffen): anderer Block belegt/frei, Weiche oder Signal in bestimmter Lage, Fahrstraße angefordert oder nicht.
- **Aktionen** (optional verzögert): Weiche oder Signal stellen, Fahrstraße anfordern oder auflösen, die Lok im auslösenden Block anhalten.

Alle Stellbefehle laufen über die Sicherung: Ein von einer Fahrstraße verriegeltes Feld wird nicht umgestellt, eine abgelehnte Fahrstraße bleibt abgelehnt. „Lok anhalten“ wirkt nur, wenn der Block eine Lok kennt (Melder mit Lokerkennung über LocoNet/CAN oder ein Zug mit Standort im Block); sonst passiert nichts. Unter jeder Regel steht, wann sie zuletzt ausgelöst hat und was dabei herauskam, z. B. „Fahrstraße abgelehnt: …“.

Das erste Lesen der Melder nach dem Verbinden löst nichts aus, ein ausgefallener Melder gilt weder als belegt noch als frei, und jede Regel löst höchstens alle 2 s aus. Verweist eine Regel auf einen Block, ein Feld oder eine Fahrstraße, die es im Gleisbild nicht mehr gibt, läuft sie nicht und wird markiert. Gespeichert in `layout-rules.json` im Datenordner, Teil der Datensicherung. REST: `GET/PUT /api/layout-rules`.

## Verlauf

Unter **Verwaltung → Diagnose → Verlauf** steht, was die Anlage und der Server getan haben: Verbindung, Ende jeder Fahrstraße, Zielfahrten, Fahrautomat, Regeln und Abläufe, beendete oder gestörte Fahrplanfahrten, Messreihen und Updates, jeweils mit Zeit und Ergebnis; „nur Probleme“ filtert auf das, was nicht gelungen ist. Der Server behält die letzten 500 Einträge (`history.json` im Datenordner, nicht Teil der Datensicherung). REST: `GET /api/history`, `DELETE /api/history` (Admin).

## Benutzer und Rollen

Zugriff mit **Benutzername und Passwort**, zwei Rollen:

| Rolle | Darf |
|---|---|
| **Benutzer** | Fahren, Weichen und Signale schalten, Fahrstraßen anfordern, Zielfahrten starten, Nothalt, Fahrplan und Stellwerk ansehen, Lok-Bilder ändern, eigenes Profil (Anzeigename, Passwort) und eigene Erfolge |
| **Admin** | zusätzlich die ganze Verwaltung: Benutzer, Gleisbild, Regeln, Züge, Fahrplan, Kameras, CV-Programmierung, Netzwerk, Datensicherung, Automatismen, Zurücksetzen der Erfolge |

- **Erster Start:** Gibt es keine `users.json` und ist `OPENSTELLWERK_PASSWORD` gesetzt, entsteht der Admin `admin` mit diesem Passwort (einmalige Neuanmeldung). Danach gilt das Konto; `OPENSTELLWERK_PASSWORD` wird nicht mehr zum Anmelden benutzt. Läuft der Server nur lokal ohne Passwort und ohne Konten, ist alles offen wie bisher; das erste in der Verwaltung angelegte Konto wird Admin und schaltet die Anmeldung ein.
- **Verwaltung → Anlage → Benutzer** (Admin): anlegen, Rolle ändern, sperren, Passwort setzen, löschen. Der letzte aktive Admin lässt sich nicht löschen, sperren oder herabstufen. Rollenwechsel und Sperren wirken sofort.
- **Passwörter** (mindestens 3 Zeichen; mit `OPENSTELLWERK_MIN_PASSWORD=8` in `/etc/openstellwerk.env` strenger, empfohlen sobald der Server von außen erreichbar ist) liegen nur als scrypt-Hash in `users.json`. Wer sein Passwort ändert, meldet alle anderen Geräte ab. Fehlversuche werden gebremst.
- **Rechte** prüft der Server (`apps/server/src/roles.ts`): Standard ist *Admin*, nur ausdrücklich freigegebene Routen sind für Benutzer offen. Die Oberfläche blendet die Verwaltung für Benutzer nur zusätzlich aus.
- **Erfolge je Benutzer:** Anfahren, Halten und Nothalt zählen für den Benutzer, der der Lok zuletzt (bis 15 s vorher) einen Fahrbefehl gegeben hat, und immer auch für die Anlage. Fahrplanfahrten zählen für die Anlage. Die Abfahrtstafel nennt den Benutzer beim Freischalten. Profil mit eigenen Erfolgen und Rangliste unter dem Namen oben rechts.
- **Datensicherung** enthält die Konten mit Passwort-Hashes; Wiederherstellen verlangt mindestens einen aktiven Admin in der Datei.

## Erfolge

Eine kleine Wertung **pro Anlage** (zusätzlich je Benutzer, siehe oben). Gezählt wird serverseitig: Anfahren und Halten einer Lok, Lok-Nothalt und abgeschlossene Fahrplanfahrten. Beispiele: „Anfahrer“ (zehnmal anfahren), „Fahrdienstleiter“ (zehn Fahrplanfahrten). Die Liste mit Fortschritt steht unter **Verwaltung → Anlage → Erfolge**; dort lässt sich die Wertung auch zurücksetzen. Wird ein Erfolg freigeschaltet, blendet die Abfahrtstafel (`#/anzeige`) ihn 15 Sekunden lang groß ein. Gespeichert in `achievements.json`; Erfolge und Zähler sind Teil der Datensicherung.

## Datensicherung

Unter **Verwaltung → Datensicherung** lädst du alles herunter, was du in der Oberfläche pflegst und was nicht in der Z21 gespeichert ist:

- **Loks:** Namen, Funktionsbezeichnungen und von Hand ergänzte Loks
- **Gleisbild:** Felder, Blöcke und Fahrstraßen
- **Züge und Fahrplan:** Züge (ohne Standort), Fahrten und Verspätungsgrenze
- **Lok-Bilder:** die kleinen Bilder der Loks (standardmäßig dabei, über „Lok-Bilder einschließen“ abwählbar); die Datei wird dadurch etwas größer
- **Automatismen** der Loks, **Regeln der Anlage**, **Kennlinien** (Einmessen) und **Erfolge** mit Zählern
- **Benutzer** mit Rollen und Passwort-Hashes (Wiederherstellen verlangt mindestens einen aktiven Admin)
- **Kameras:** Kamera-Passwörter nur, wenn du sie ausdrücklich einschließt (sie stehen dann im Klartext in der Datei)

Beim Wiederherstellen wählst du die Teile einzeln aus. Alles wird vorher geprüft; ist ein Teil fehlerhaft, ändert sich nichts. Das Gleisbild lässt sich nicht ersetzen, solange Fahrstraßen angefordert sind. Fahrzustand, Weichenlagen, CVs, Uhr und Netzwerk-Einstellungen liegen in der Z21 selbst und gehören nicht dazu. Das Gleisbild allein kannst du weiter im Editor exportieren und importieren.

## Hinweise zum Protokoll

- Öffentliche Spezifikation: „Z21 LAN Protokoll“ von Z21/Roco (PDF auf z21.eu).
- Adressen in der API sind benutzerfreundlich 1-basiert (Weiche, CV); auf dem Draht sind sie 0-basiert. Die Umrechnung steckt ausschließlich in `commands.ts`/`messages.ts`.
- Die Z21 trennt Clients nach ca. 60 s Stille; der Server fragt alle 20 s den Systemzustand ab.
- Lok-Geschwindigkeit wird bisher nur mit 128 Fahrstufen gesendet; 14/28 Stufen werden empfangen, aber nicht umgerechnet.
- Der Simulator spielt im Dev-Modus Demo-Verkehr (Melder wechseln alle 4 s). Abschalten mit `Z21_SIM_DEMO=0`. Als zLink-Gerät starten: `Z21_SIM_PORT=21201 Z21_SIM_DEVICE=booster npm run dev:sim` (auch `switchDecoder`, `signalDecoder`), dann per API `POST /api/connect {"host":"127.0.0.1","port":21201}`.
- LISSY-Abfragen (Typ 0x82) und LocoNet-Dispatch sind im Protokoll vorhanden, aber im Simulator nicht nachgebildet.
- Fehlgeschlagene Programmierungen (kein Decoder-ACK, Kurzschluss) liefern HTTP 422, ausbleibende Antworten der Zentrale HTTP 504.
- Ungeprüft an echter Hardware: bitte beim ersten Test Gleisspannung, Lokfahren und CV-Lesen am Programmiergleis mit einer Zentrale kontrollieren. Die Bytecodes folgen der öffentlichen Spezifikation, sind aber bisher nur gegen den eigenen Simulator getestet.
