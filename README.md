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
| `packages/z21-simulator` | Z21 in Software (UDP). Entwicklung und Tests ohne Hardware. |
| `apps/server` | UDP-Client mit Keepalive, `Station`-Modell (Zustand der Zentrale), REST- und WebSocket-API. |
| `apps/web` | Oberfläche: Zentrale, Fahren, Weichen, CV-Programmierung, Protokoll-Monitor. |

Spätere Steuerungsfunktionen (Fahrstraßen, Blocksicherung, Fahrplan/Automatik, Gleisbild, Rückmelder) kommen als eigene Module im Server oberhalb von `Station` und als weitere Pakete (`packages/interlocking`, …). `Station` ist die einzige Stelle, die Hardware-Zustand besitzt.

## Starten

```bash
npm install
npm run dev        # Simulator + Server (:3001) + Web (:5173)
```

Dann <http://localhost:5173> öffnen und mit `127.0.0.1` (Simulator) oder der IP der echten Z21 verbinden. Der Server bindet standardmäßig nur an `127.0.0.1`; es gibt noch keine Authentifizierung. Zum Freigeben im LAN `HOST=0.0.0.0` setzen, nur in vertrauenswürdigen Netzen.

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
| Weichen | Schalten, Ausgabeformat DCC/Motorola | 3, 5 |
| Signale | DCCext (RCN-213): Signalbilder 10837, Weichen mit Schaltzeit 10836, Zubehör-Nothalt | 5.4–5.6 |
| CV-Programmierung | Programmiergleis (direkt), POM Lok (Byte/Bit/Lesen per RailCom), POM Zubehör, Registermodus, Motorola | 6 |
| R-BUS | Rückmeldemodule 1–20, Modul-Adresse programmieren | 7 |
| Uhr | Modellbahn-Uhr: Anzeige, Start/Stopp, Zeit/Faktor, dauerhafte Einstellungen | 12 |
| Booster | CAN-Booster 10806/7/9 an der Z21: Status, Namen, Ausgänge einzeln schalten | 10.2 |
| Gerät | zLink-Booster und -Decoder 10836/10837 hinter einem 10838 Z21 pro LINK: Status, Namen, Ausgänge | 11 |
| RailCom, LocoNet, Melder | Monitore, LocoNet-Rohnachrichten, LocoNet-/CAN-Gleisbesetztmelder | 8, 9, 10.1 |

Die Monitore (RailCom, LocoNet, Melder, R-BUS, Booster, Uhr) sind standardmäßig aus, weil sie viel Netzwerkverkehr erzeugen; der Server aktiviert die Broadcast-Flags nur, solange der Reiter offen ist.

### Noch nicht enthalten

| Funktion der `Z21_Maintenance.exe` | Grund |
|---|---|
| **Firmware-Updates** (Z21, Booster, Decoder, Multimaus, LocoNet-Adapter, Zimo MX/MS inkl. Sound/SUSI) | Proprietärer Bootloader, nicht öffentlich dokumentiert. Erfordert Reverse Engineering und ein Testgerät; ein Fehler beim Flashen kann das Gerät unbrauchbar machen. Bewusst nicht „blind“ gebaut. |
| LNCV lesen/schreiben (Uhlenbrock) | Nicht in der Z21-Spezifikation; das Bitpacking der LocoNet-Nachrichten ist hier nicht verifiziert. |
| IP-/WLAN-Einstellungen, Signaltyp/Signal Box, Decoder-Konfiguration über die EXE-Oberfläche | Teils proprietär bzw. nur über CV-Zugriff möglich (CV-Reiter funktioniert auch an den zLink-Decodern). |
| Zimo-Decoder-Updates, Multimaus-Update, CAN-Detektor-Firmware | siehe Firmware-Updates |

Diese Teile sind als nächste Phase vorgesehen, sobald Testhardware vorhanden ist. Danach folgt der Ausbau zur Modellbahnsteuerung (Fahrstraßen, Blocksicherung, Fahrplan, Gleisbild).

## Hinweise zum Protokoll

- Öffentliche Spezifikation: „Z21 LAN Protokoll“ von Z21/Roco (PDF auf z21.eu).
- Adressen in der API sind benutzerfreundlich 1-basiert (Weiche, CV); auf dem Draht sind sie 0-basiert. Die Umrechnung steckt ausschließlich in `commands.ts`/`messages.ts`.
- Die Z21 trennt Clients nach ca. 60 s Stille; der Server fragt alle 20 s den Systemzustand ab.
- Lok-Geschwindigkeit wird bisher nur mit 128 Fahrstufen gesendet; 14/28 Stufen werden empfangen, aber nicht umgerechnet.
- Der Simulator spielt im Dev-Modus Demo-Verkehr (Melder wechseln alle 4 s). Abschalten mit `Z21_SIM_DEMO=0`. Als zLink-Gerät starten: `Z21_SIM_PORT=21201 Z21_SIM_DEVICE=booster npm run dev:sim` (auch `switchDecoder`, `signalDecoder`), dann per API `POST /api/connect {"host":"127.0.0.1","port":21201}`.
- LISSY-Abfragen (Typ 0x82) und LocoNet-Dispatch sind im Protokoll vorhanden, aber im Simulator nicht nachgebildet.
- Fehlgeschlagene Programmierungen (kein Decoder-ACK, Kurzschluss) liefern HTTP 422, ausbleibende Antworten der Zentrale HTTP 504.
- Ungeprüft an echter Hardware: bitte beim ersten Test Gleisspannung, Lokfahren und CV-Lesen am Programmiergleis mit einer Zentrale kontrollieren. Die Bytecodes folgen der öffentlichen Spezifikation, sind aber bisher nur gegen den eigenen Simulator getestet.
