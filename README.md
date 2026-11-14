# Z21 Web

Plattformunabhängiger Ersatz für `Z21_Maintenance.exe` (Windows/Delphi) und Grundlage für eine vollständige Modellbahnsteuerung. Läuft auf macOS, Linux und Windows mit Node.js ≥ 22.

## Architektur

```
Browser (React/Vite)  ──HTTP + WebSocket──▶  Node-Server (Fastify)  ──UDP :21105──▶  Z21
                                                  │                  ──Serial (später)──▶ zLink-USB
                                                  └── @z21/protocol (Codec, ohne I/O)
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
NODE_ENV=production HOST=0.0.0.0 Z21_PASSWORD='…' npm start
```

Ein einziger Node-Prozess liefert Oberfläche, API und WebSocket auf Port 3001 aus (rund 90 MB RAM). Bedient wird im Browser eines anderen Geräts: `http://<adresse-des-pi>:3001`.

| Variable | Bedeutung |
|---|---|
| `HOST`, `PORT` | Bindeadresse und Port (Standard `127.0.0.1:3001`) |
| `Z21_PASSWORD` | Gemeinsames Passwort. **Pflicht**, sobald `HOST` nicht `127.0.0.1` ist – ohne startet der Server nicht (bewusst offen: `Z21_ALLOW_OPEN=1`) |
| `DATA_DIR` | Ordner für Lokliste, Kameras und Gleisbild (Standard `apps/server/data`) |
| `LOG_LEVEL` | Standard `warn` bei `NODE_ENV=production` (schont die SD-Karte), sonst `info` |
| `TLS_CERT`, `TLS_KEY` | Pfade zu Zertifikat und Schlüssel: der Server spricht dann selbst HTTPS und lädt erneuerte Dateien ohne Neustart nach |
| `TRUST_PROXY=1` | Hinter einem Proxy (Caddy, nginx): `X-Forwarded-*` auswerten |
| `Z21_REQUIRE_HTTPS=1` | Anmeldung über unverschlüsseltes HTTP ablehnen |

### Raspberry Pi: Installation per Kommandozeile

Voraussetzungen sind Raspberry Pi OS (ARM64/64 Bit oder ARMv7/32 Bit), Internetzugang, `sudo`, systemd und ein Projekt-Checkout auf dem Pi. Im Projektverzeichnis ausführen:

```bash
sudo bash deploy/install-raspberry-pi.sh
```

Das Skript fragt interaktiv nach einem Passwort (druckbare ASCII-Zeichen), installiert fehlende Hilfsprogramme und bei Bedarf Node.js 22 passend zur Architektur, kopiert das Projekt nach `/opt/z21-web`, baut die Oberfläche und aktiviert den systemd-Dienst. Die Konfiguration liegt in `/etc/z21-web.env`, die Anwendungsdaten liegen in `/var/lib/z21-web`. Anschließend `http://<adresse-des-pi>:3001` im Browser öffnen. `npm ci` und der Build können auf einem Pi 3 einige Minuten dauern.

Das Skript ist für eine **Erstinstallation** gedacht: Es überschreibt weder eine vorhandene Installation noch eine bestehende Konfiguration oder Dienstdatei. Nach einem Fehler bleiben bereits angelegte Dateien zur Prüfung erhalten; für einen erneuten Versuch müssen diese gezielt geprüft und gegebenenfalls entfernt werden. Bestehende Daten in `/var/lib/z21-web` werden nicht gelöscht.

```bash
sudo systemctl status z21-web      # Dienststatus
sudo journalctl -u z21-web -f      # Protokoll
sudo systemctl restart z21-web     # nach Konfigurationsänderungen
```

Bei Netzwerkkameras einen kleinen Stream (Substream) wählen, jedes Bild läuft durch den Pi.

**HTTPS (optional):** Ohne HTTPS ist das Passwort im Netz mitlesbar. Let's Encrypt stellt nur für einen öffentlichen Domainnamen aus, nicht für `192.168.x.x`.
- *Empfohlen:* Caddy davor, siehe `deploy/Caddyfile`. Caddy holt und erneuert das Zertifikat selbst; mit der DNS-Bestätigung (DNS-01) muss kein Port aus dem Internet erreichbar sein.
- *Ohne Proxy:* Zertifikat z. B. mit certbot holen und `TLS_CERT=/etc/letsencrypt/live/<domain>/fullchain.pem`, `TLS_KEY=…/privkey.pem` setzen (der Dienst-Benutzer braucht Leserechte). Geht auch mit einem selbst erstellten Zertifikat.

Build und manueller Produktionsstart wurden auf einem Raspberry Pi mit Raspbian 11 (ARMv7) getestet; die vollständige Installation als Dienst noch nicht.

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

- Sie wird nur eingestellt, wenn alle ihre Blöcke sicher frei sind. Ein Melder, der noch nichts gemeldet hat, zählt nicht als frei.
- Weichen werden zuerst gestellt, das Startsignal erst, wenn alle Lagen zurückgemeldet sind. Sie bleiben verriegelt: Handschaltung (auch über den Weichen-Tab, die Signal-Seite und „Testen“ im Editor) und ungesicherte Fahrstraßen auf diese Adressen werden abgelehnt. Halt-Befehle der Sicherung überholen andere Schaltaufträge in der Warteschlange.
- Fährt der Zug ein, geht das Signal auf Halt. Die Fahrstraße löst sich auf, sobald der Zug den Zielblock erreicht hat und alle Blöcke wieder frei sind. Eine kurze Lücke zwischen zwei Meldern löst nichts aus. Erreicht der Zug das Ziel nie, bleibt sie bis zur Notauflösung verriegelt.
- Wird eine verriegelte Weiche verstellt, fällt ein Block aus oder melden die Weichen nicht rechtzeitig (15 s), geht die Fahrstraße in **Störung**: Signal auf Halt, Verriegelung bleibt, bis du sie quittierst. Eine Fahrstraße mit Zug darin löst nur die Notauflösung.
- Bei getrennter Verbindung friert die Sicherung ein und löst nichts auf.
- Gleisbild-Änderungen sind nur ohne angeforderte Fahrstraßen möglich.

Die Sicherung braucht Belegtmelder. Ohne sie lassen sich Fahrstraßen nicht einstellen (im Simulator über `sim.extras.setRmBus` testen). Auflösung gibt es bisher nur für die ganze Fahrstraße, nicht blockweise; Flankenschutz-Weichen lassen sich über die JSON-Datei (`flank`) eintragen, noch nicht im Editor.

**Anzeige für einen zweiten Bildschirm:** `http://<adresse>:3001/#/anzeige` zeigt die Fahrplanuhr (siehe unten), eingestellte Fahrstraßen und das Gleisbild live, ohne Bedienelemente. Die Seite braucht dieselbe Anmeldung wie die Bedienung (Sitzung bleibt 30 Tage).

### Fahrplan und Abfahrtstafel

- **Züge** (Verwaltung → Züge): Name, Nummer (z. B. „RE 1“) und Lokadresse. Den **Standort** (Block) setzt du von Hand; nach einem Neustart oder wenn die Automatik den Zug nicht sicher verfolgen kann, gilt er als **unsicher** und wird so angezeigt, bis du ihn bestätigst oder neu setzt.
- **Fahrten** (Verwaltung → Fahrplan): ein Zug fährt auf einer gesicherten Fahrstraße zu einer Abfahrtszeit, mit Haltezeit und Zieltext. Mit **Takt** wiederholt sich die Fahrt alle N Minuten bis zu einer Endzeit.
- **Fahrplanuhr** (Bedienen → Fahrplan): eigene Modellzeit, unabhängig von der Z21-Uhr. Start/Stopp, Faktor (1 bis 120) und „Uhr stellen“. Sie läuft nur bei bestehender Verbindung.
- **Automatik (Stufe 1):** Zur Abfahrtszeit fordert der Server die gesicherte Fahrstraße an und stellt Weichen und Signal. Die Lok fährt sie nicht automatisch (das tust du am Fahrregler, im Demo-Modus der virtuelle Zug). Lehnt die Sicherung die Fahrstraße ab (z. B. Block belegt), wartet die Abfahrt und versucht es erneut; ist die **Verspätungsgrenze** (Minuten, Standard 5) überschritten, geht sie in Störung. Erreicht der Zug den Zielblock, steht er dort als „mitgeführt“.
- **Abfahrtstafel:** `#/anzeige` zeigt die nächsten Abfahrten mit Fahrplanuhr statt Z21-Uhr.
- **Nach einem Neustart:** Fahrplanuhr gestoppt, alle Standorte unsicher, und die Signale gesicherter Fahrstraßen gehen bei jedem Verbinden auf Halt, solange keine Fahrstraße eingestellt ist.
- **Datensicherung:** enthält Züge (ohne Standort) und den Fahrplan (Fahrten, Verspätungsgrenze).
- **Demo-Modus:** lädt Beispielzüge und -fahrplan (`docs/beispiel-fahrplan.json`), wenn noch keine Züge und Fahrten existieren und das Gleisbild die Blöcke und Fahrstraßen des Beispiels hat; die Uhr startet bei 05:58 mit Faktor 20. Ein älteres gespeichertes Beispiel-Gleisbild ohne die Fahrstraßen r3/r4 bitte im Editor neu importieren (`docs/beispiel-gleisbild.json`).
- **Folgt in Stufe 2:** Lok automatisch fahren.

#### Bekannte Einschränkung der Automatik (Stufe 1)

Die gesicherten Fahrstraßen aus Phase 1 verlangen, dass alle ihre Blöcke frei sind – auch der Startblock. Steht der Zug im Startblock und meldet dort ein echter Melder besetzt, lehnt die Sicherung die Fahrstraße ab; ein Zug, der im Zielblock hält, hält die Fahrstraße bis zur Notauflösung offen. Mit dem Simulator und im Demo-Modus tritt das nicht auf, mit echten Rückmeldern schon. Das Verhalten der Sicherung (Startblock darf vom Zug selbst belegt sein, Auflösung beim Erreichen des Zielblocks) wird als Erstes in der nächsten Ausbaustufe geändert. Bis dahin lässt sich der Fahrplan nur ohne echte Melder (Simulator, Demo) vollständig nutzen.

### Noch nicht enthalten

| Funktion der `Z21_Maintenance.exe` | Grund |
|---|---|
| **Firmware-Updates** (Z21, Booster, Decoder, Multimaus, LocoNet-Adapter, Zimo MX/MS inkl. Sound/SUSI) | Proprietärer Bootloader, nicht öffentlich dokumentiert. Erfordert Reverse Engineering und ein Testgerät; ein Fehler beim Flashen kann das Gerät unbrauchbar machen. Bewusst nicht „blind“ gebaut. |
| LNCV lesen/schreiben (Uhlenbrock) | Nicht in der Z21-Spezifikation; das Bitpacking der LocoNet-Nachrichten ist hier nicht verifiziert. |
| IP-/WLAN-Einstellungen, Signaltyp/Signal Box, Decoder-Konfiguration über die EXE-Oberfläche | Teils proprietär bzw. nur über CV-Zugriff möglich (CV-Reiter funktioniert auch an den zLink-Decodern). |
| Zimo-Decoder-Updates, Multimaus-Update, CAN-Detektor-Firmware | siehe Firmware-Updates |

Diese Teile sind vorgesehen, sobald Testhardware vorhanden ist.

## Automatik je Lok

Unter **Bedienen → Fahren** gibt es unter den Funktionen den Bereich **Automatik**. Ein Automatismus besteht aus **Auslöser → Bedingungen → Aktionen** (nach dem Muster von Home Assistant):

- **Auslöser:** Lok fährt an, hält an, beschleunigt, bremst, Richtung wechselt, Lok-Nothalt, Funktion wird ein-/ausgeschaltet.
- **Bedingungen** (alle müssen zutreffen): Richtung, fährt/steht, Funktion ein/aus.
- **Aktionen:** Funktion F0–F28 ein-, ausschalten oder umschalten, optional mit Verzögerung und (beim Einschalten) mit Dauer.

Die Funktionsbezeichnungen der Lok erscheinen in den Auswahlfeldern. Gespeichert wird in `automations.json` im Datenordner (noch nicht Teil der Datensicherung). Beschleunigen und Bremsen lösen höchstens alle 3 s aus, alle anderen Auslöser höchstens alle 0,5 s je Automatismus. Eine Funktion, die ein Automatismus eben selbst geschaltet hat, löst 1,5 s lang keinen weiteren aus (Schutz vor Schleifen). Offene Verzögerungen verfallen, wenn die Verbindung getrennt wird. REST: `GET/PUT /api/locos/:addr/automations`.

## Benutzer und Rollen

Zugriff mit **Benutzername und Passwort**, zwei Rollen:

| Rolle | Darf |
|---|---|
| **Benutzer** | Fahren, Weichen und Signale schalten, Fahrstraßen anfordern, Nothalt, Fahrplan und Stellwerk ansehen, Lok-Bilder ändern, eigenes Profil (Anzeigename, Passwort) und eigene Erfolge |
| **Admin** | zusätzlich die ganze Verwaltung: Benutzer, Gleisbild, Züge, Fahrplan, Kameras, CV-Programmierung, Netzwerk, Datensicherung, Automatismen, Zurücksetzen der Erfolge |

- **Erster Start:** Gibt es keine `users.json` und ist `Z21_PASSWORD` gesetzt, entsteht der Admin `admin` mit diesem Passwort (einmalige Neuanmeldung). Danach gilt das Konto; `Z21_PASSWORD` wird nicht mehr zum Anmelden benutzt. Läuft der Server nur lokal ohne Passwort und ohne Konten, ist alles offen wie bisher; das erste in der Verwaltung angelegte Konto wird Admin und schaltet die Anmeldung ein.
- **Verwaltung → Anlage → Benutzer** (Admin): anlegen, Rolle ändern, sperren, Passwort setzen, löschen. Der letzte aktive Admin lässt sich nicht löschen, sperren oder herabstufen. Rollenwechsel und Sperren wirken sofort.
- **Passwörter** (mindestens 8 Zeichen) liegen nur als scrypt-Hash in `users.json`. Wer sein Passwort ändert, meldet alle anderen Geräte ab. Fehlversuche werden gebremst.
- **Rechte** prüft der Server (`apps/server/src/roles.ts`): Standard ist *Admin*, nur ausdrücklich freigegebene Routen sind für Benutzer offen. Die Oberfläche blendet die Verwaltung für Benutzer nur zusätzlich aus.
- **Erfolge je Benutzer:** Anfahren, Halten und Nothalt zählen für den Benutzer, der der Lok zuletzt (bis 15 s vorher) einen Fahrbefehl gegeben hat, und immer auch für die Anlage. Fahrplanfahrten zählen für die Anlage. Die Abfahrtstafel nennt den Benutzer beim Freischalten. Profil mit eigenen Erfolgen und Rangliste unter dem Namen oben rechts.
- **Datensicherung** enthält die Konten mit Passwort-Hashes; Wiederherstellen verlangt mindestens einen aktiven Admin in der Datei.

## Erfolge

Eine kleine Wertung **pro Anlage** (noch ohne Benutzerprofile). Gezählt wird serverseitig: Anfahren und Halten einer Lok, Lok-Nothalt und abgeschlossene Fahrplanfahrten. Beispiele: „Anfahrer“ (zehnmal anfahren), „Fahrdienstleiter“ (zehn Fahrplanfahrten). Die Liste mit Fortschritt steht unter **Verwaltung → Anlage → Erfolge**; dort lässt sich die Wertung auch zurücksetzen. Wird ein Erfolg freigeschaltet, blendet die Abfahrtstafel (`#/anzeige`) ihn 15 Sekunden lang groß ein. Gespeichert in `achievements.json`; Erfolge und Zähler sind Teil der Datensicherung.

## Datensicherung

Unter **Verwaltung → Datensicherung** lädst du alles herunter, was du in der Oberfläche pflegst und was nicht in der Z21 gespeichert ist:

- **Loks:** Namen, Funktionsbezeichnungen und von Hand ergänzte Loks
- **Gleisbild:** Felder, Blöcke und Fahrstraßen
- **Züge und Fahrplan:** Züge (ohne Standort), Fahrten und Verspätungsgrenze
- **Automatismen** der Loks und **Erfolge** mit Zählern
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
