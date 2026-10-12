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
npm run dev        # Simulator + Server (:3000) + Web (:5173)
```

Dann <http://localhost:5173> öffnen und mit `127.0.0.1` (Simulator) oder der IP der echten Z21 verbinden. Der Server bindet standardmäßig nur an `127.0.0.1`; es gibt noch keine Authentifizierung. Zum Freigeben im LAN `HOST=0.0.0.0` setzen, nur in vertrauenswürdigen Netzen.

```bash
npm test           # Protokoll- und Integrationstests (Simulator ↔ Server)
npm run typecheck
```

## Stand und Fahrplan

Phase 1 (fertig): öffentliches Z21-LAN-Protokoll – Suche im Netz, Status/Systemzustand, Gleisspannung, Nothalt, Lokfahren und Funktionen F0–F28, Weichen, CV lesen/schreiben (Programmiergleis), Rohdaten-Monitor.

Phase 2 (fertig): Monitore, gebaut gegen die offizielle Spezifikation „Z21 LAN Protocol Specification“ V1.13 (Kap. 2.16, 8, 9, 10):
- **RailCom** (`0x88`/`0x89`): Loks mit Geschwindigkeit, QoS, Empfangs- und Fehlerzähler.
- **LocoNet** (`0xA0`–`0xA4`): Mitschnitt mit dekodierten Opcodes (Weichen, Lok-Befehle, Sensoren, Slots, Gleisspannung), Prüfsummenkontrolle, Filter, Pause, Rohnachricht senden (mit Bestätigung).
- **Melder**: LocoNet-Gleisbesetztmelder (SIC-/Report-Adress-Abfrage, Transponder-Loks) und CAN-Melder 10808 inkl. RailCom-Lokliste je Port.
Die Monitore sind abschaltbar und standardmäßig aus, weil sie viel Netzwerkverkehr erzeugen; der Server aktiviert die zugehörigen Broadcast-Flags nur, solange der Reiter offen ist.

Funktionen von `Z21_Maintenance.exe` (anhand der Ressourcen der EXE) und ihr Stand:

| Bereich in der EXE | Technik | Status |
|---|---|---|
| Z21-Status / Einstellungen, Lok-Liste, Weichen | öffentliches LAN-Protokoll | teilweise (Status, Lok, Weiche) |
| CV-Programmierung | LAN-Protokoll | Grundfunktion fertig |
| RailCom-Monitor, LocoNet-Monitor, LocoNet-/CAN-Melder | LAN-Protokoll (0x88/0x89, 0xA0–0xA4, 0xC4) | fertig (Phase 2) |
| LNCV lesen/schreiben | LocoNet-Programmiernachrichten über 0xA2 | geplant |
| IP-/WLAN-Einstellungen | teils proprietär | zu klären |
| Z21 Booster / Weichen- und Signaldecoder 10836/10837, Signal Box | CAN, teils proprietär | Phase 3 |
| Firmware-Updates (Z21, Booster 10806/7, 10808, Multimaus, LocoNet-Adapter) | proprietärer Bootloader, LAN bzw. zLink-USB seriell | Phase 4 |
| Zimo-MX/MS-Decoder-Update (MDU), Sound-/SUSI-Update | seriell über zLink | Phase 4 |

Phase 4 setzt Analyse des Bootloader-Protokolls voraus (die EXE meldet u. a. Flash-/EEPROM-/IAP-Fehlercodes, Firmware-Dateien `.bin`/`.hex`, Signatur- und Verifizierungsschritte). Fehlerhafte Flash-Vorgänge können ein Gerät unbrauchbar machen – das wird erst mit Testgerät und mit Sicherheitsabfragen umgesetzt, nicht blind.

## Hinweise zum Protokoll

- Öffentliche Spezifikation: „Z21 LAN Protokoll“ von Z21/Roco (PDF auf z21.eu).
- Adressen in der API sind benutzerfreundlich 1-basiert (Weiche, CV); auf dem Draht sind sie 0-basiert. Die Umrechnung steckt ausschließlich in `commands.ts`/`messages.ts`.
- Die Z21 trennt Clients nach ca. 60 s Stille; der Server fragt alle 20 s den Systemzustand ab.
- Lok-Geschwindigkeit wird bisher nur mit 128 Fahrstufen gesendet; 14/28 Stufen werden empfangen, aber nicht umgerechnet.
- Der Simulator spielt im Dev-Modus Demo-Verkehr (Melder wechseln alle 4 s). Abschalten mit `Z21_SIM_DEMO=0`.
- LISSY-Abfragen (Typ 0x82) und LocoNet-Dispatch sind im Protokoll vorhanden, aber im Simulator nicht nachgebildet.
- Ungeprüft an echter Hardware: bitte beim ersten Test Gleisspannung, Lokfahren und CV-Lesen am Programmiergleis mit einer Zentrale kontrollieren. Die Bytecodes folgen der öffentlichen Spezifikation, sind aber bisher nur gegen den eigenen Simulator getestet.
