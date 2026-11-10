# Z21 Maintenance-Protokoll – Analysestand (statisch, aus `Z21_Maintenance.exe`)

Quelle: Delphi-Binary (PE32, SHA-256 `1091ff5d…bb3f`), nur disassembliert, **nie ausgeführt**.
Status: **nicht an Hardware verifiziert.** Die Z21 (z21 start, FW 1.43, per VPN) hat auf keine Testanfrage geantwortet.

## Wo die Funktion sitzt
- UI: `BitBtnIpOverwriteClick` (0x834b0c) → `Send(IP, Subnetz, Gateway)` (0x7a5314) → `THWSettingsThread` (Execute 0x6f2884).
- Registry-Schlüssel der Eingaben: `RegNewIpAddress/NetMask/Gateway 0..2`.
- Die Thread-Daten (`THWSettingsData`) haben vier Blöcke, je mit Aktion (1 = lesen, 2 = schreiben, 3 = löschen/Default):

| Block | Offset Aktion | Nutzdaten | Länge | Befehl lesen / schreiben / Default |
|---|---|---|---|---|
| MAC | +0x16 | +0x17 | 6 | 0x181 / 0x191 / 0x1A1 |
| **IP-Einstellungen** | +0x06 | +0x07 | 12 (IP, Maske, Gateway je ein DWORD) | **0x182 / 0x192 / 0x1A2** |
| Beschreibung | +0x20 | +0x21 | 63 | 0x183 / 0x193 / 0x1A3 |
| Control-Block | +0x62 | +0x63 | 32 | 0x184 / 0x194 / 0x1A4 |

Vor den Blöcken sendet der Thread einmal Befehl 0x201 (Nutzdaten: DWORD 3, DWORD ?, 32 × 0xFF).

## Rahmen (little endian)
```
+0  u16  Länge (Header+Daten); Bit 15 gesetzt = Nutzdaten ab +8 verschlüsselt
+2  u16  Befehl
+4  u16  Ergebniscode in Antworten (0 = ok); in Anfragen unbenutzt
+6  u16  Sequenz/Schlüssel (Zufall)
+8  u32  Parameter (0)
+12 u32  Datenlänge (Lesen: erwartete Länge)
+16      Daten
```
Antwort wie Anfrage; Daten ab +16. Timeout im Original 3000 ms, ein Versuch.

## Verschlüsselung (ab Byte 8, nur volle DWORDs)
```
s = ((key ^ 0x731B) & 0xFFFF) | (((key ^ 0xC57A) & 0xFFFF) << 16)      # key = Sequenzwort
verschlüsseln:  c = rol32(d ^ s, 19) ^ s ;  s = c
entschlüsseln:  d = ror32(c ^ s, 19) ^ s ;  s = c
```
Referenzimplementierung mit Selbsttest: `z21cfg-probe.py`.

## Offen / nicht belegt
1. **Transport.** UDP-Port 21106 ist belegt (Meldungen „Waiting for UDP 21106…“, „Keine Kommunikation auf UDP Port 21106“). Unklar: Ziel- und Quellport, und ob die Z21 per **Broadcast** antwortet (würde das VPN erklären). Anfragen mit Quellport 21106 und Zielport 21105/21106, verschlüsselt und im Klartext, blieben ohne Antwort.
2. Die vier Bytes bei +4/+5 der Anfragen sind im Original nicht initialisiert.
3. Byte-Reihenfolge von IP/Maske/Gateway in den 12 Nutzdatenbytes (Parser 0x6d2b00 nicht zu Ende gelesen). Lösbar, sobald ein Lesezugriff antwortet, weil die eigene IP bekannt ist.
4. Zweck von Befehl 0x201 / DWORD 3.
5. WLAN-Einstellungen (`TZLinkWifiConfigData`: SSID, Passwort, Modus, Region, Kanal, statische IP) gehören vermutlich zum zLink-/WLAN-Modul und laufen über einen anderen Pfad.

Nächster Schritt: Lesezugriff (0x182) **im selben LAN** mit Wireshark-Mitschnitt des Originaltools daneben, danach erst Schreiben.
