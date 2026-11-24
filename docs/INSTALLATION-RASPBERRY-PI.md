# Installation auf einem „blanken“ Raspberry Pi

Diese Anleitung bringt OpenStellwerk auf einem Raspberry Pi zum Laufen, der noch nichts darauf hat: ohne Bildschirm und Tastatur, nur mit Netzwerk. Am Ende läuft OpenStellwerk als Dienst, startet mit dem Pi und ist von Tablet, Handy oder Rechner im Heimnetz erreichbar.

> **Stand:** Das Installationsskript ist geschrieben und geprüft, wurde aber noch nicht auf einem frisch aufgesetzten Pi durchgespielt (siehe README). Klappt ein Schritt nicht, bitte ein [Issue](https://github.com/zap2021/openstellwerk/issues) mit der Fehlermeldung anlegen.

## Was du brauchst

- **Raspberry Pi 3, 4, 5 oder Zero 2 W** (ARM64 oder ARMv7). Der Pi Zero (W) und der Pi 1 (ARMv6) werden nicht unterstützt.
- **microSD-Karte** mit mindestens 16 GB und ein Kartenleser am Rechner
- **Netzteil** für den Pi und, wenn du kein WLAN nutzt, ein **Netzwerkkabel**
- **Z21** (oder z21 start mit freigeschaltetem LAN) im selben Netz wie der Pi
- einen **Rechner** mit Internet für die Vorbereitung und ein **Tablet/Handy** zum Bedienen

## Schritt 1: Betriebssystem auf die Karte schreiben

1. Auf dem Rechner den **Raspberry Pi Imager** installieren: <https://www.raspberrypi.com/software/>
2. Imager starten. **Raspberry Pi-Modell** wählen, bei **Betriebssystem** „Raspberry Pi OS (other)“ → **„Raspberry Pi OS Lite (64-bit)“** (bei Pi 3 und neuer; ein Pi mit 32 Bit nimmt „Lite (32-bit)“). Die Lite-Fassung hat keine Oberfläche, die du nicht brauchst.
3. Bei **Speicher** die SD-Karte wählen. Achtung: Ihr Inhalt wird gelöscht.
4. Auf **Weiter** und dann **„Einstellungen bearbeiten“** klicken (OS-Anpassung) und eintragen:
   - **Hostname:** z. B. `stellwerk` (der Pi heißt dann im Netz `stellwerk.local`)
   - **Benutzername und Passwort:** eigene Wahl, das Passwort gut merken
   - **WLAN:** Name und Passwort deines Heimnetzes samt Land (nur, wenn der Pi nicht per Kabel angeschlossen wird)
   - **Zeitzone und Tastatur:** `Europe/Berlin`, `de`
   - Reiter **Dienste:** **SSH aktivieren** (Passwort-Anmeldung)
5. Speichern, **Ja** und das Schreiben starten. Danach die Karte sicher auswerfen.

## Schritt 2: Pi starten und verbinden

1. Karte in den Pi stecken, Netzteil (und ggf. Netzwerkkabel) anschließen. Der erste Start dauert 1 bis 2 Minuten.
2. Auf dem Rechner ein Terminal öffnen (Windows: PowerShell, macOS/Linux: Terminal) und anmelden (Benutzername und Hostnamen aus Schritt 1 einsetzen):

   ```bash
   ssh DEIN-BENUTZER@stellwerk.local
   ```

   Die Rückfrage nach dem Fingerabdruck mit `yes` bestätigen, dann das Passwort eingeben.
3. Klappt `stellwerk.local` nicht, die Adresse des Pi im Router (Liste der Geräte) nachsehen und `ssh DEIN-BENUTZER@192.168.x.x` verwenden. Notiere sie, du brauchst sie auch für die Bedienung.

## Schritt 3: System aktualisieren

Auf dem Pi:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

Nach etwa einer Minute wieder per `ssh` anmelden.

## Schritt 4: OpenStellwerk herunterladen

Auf dem Pi (die Versionsnummer durch die neueste aus der [Release-Liste](https://github.com/zap2021/openstellwerk/releases/latest) ersetzen, hier 0.6.0):

```bash
mkdir ~/openstellwerk && cd ~/openstellwerk
curl -fsSL -o openstellwerk.tar.gz https://github.com/zap2021/openstellwerk/archive/refs/tags/v0.6.0.tar.gz
tar -xzf openstellwerk.tar.gz --strip-components=1
```

## Schritt 5: Installieren

```bash
sudo bash deploy/install-raspberry-pi.sh
```

Das Skript:
- fragt nach einem **Passwort** für OpenStellwerk (zweimal, mindestens 3 Zeichen, nur druckbare ASCII-Zeichen). Es ist das Passwort des ersten Benutzers `admin`. Es hat nichts mit dem Passwort des Pi zu tun.
- installiert fehlende Hilfsprogramme und, wenn nötig, **Node.js 22** (mit Prüfsumme)
- legt den Benutzer `openstellwerk` an und kopiert das Programm nach `/opt/openstellwerk`
- installiert die Abhängigkeiten und baut die Oberfläche (`npm ci`, `npm run build`)
- richtet den Dienst ein und startet ihn

**Das dauert auf einem Pi 3 einige Minuten.** Das Fenster dabei nicht schließen. Am Ende steht „Installation abgeschlossen“.

Das Skript ist für eine **Erstinstallation** gedacht und überschreibt nichts Vorhandenes. Bei einem Fehler bleiben angelegte Dateien erhalten; für einen neuen Versuch müssen sie gezielt geprüft und gegebenenfalls entfernt werden (siehe README, „Raspberry Pi: Installation per Kommandozeile“).

## Schritt 6: Prüfen

```bash
sudo systemctl status openstellwerk
```

Dort sollte **active (running)** stehen (mit `q` beenden). Dann im Browser von Tablet, Handy oder Rechner öffnen:

```
http://stellwerk.local:3001
```

(oder `http://<IP-des-Pi>:3001`). Anmelden mit dem Benutzernamen **`admin`** und dem Passwort aus Schritt 5.

## Schritt 7: Z21 verbinden

1. In OpenStellwerk die Zentrale suchen lassen oder deren IP-Adresse (steht in der Z21-App oder im Router) eintragen und verbinden.
2. Beim ersten erfolgreichen Verbinden merkt sich OpenStellwerk die Adresse. Ab dann wird sie nach jeder Anmeldung wieder verbunden.
3. Bei der **z21 start** muss die LAN-Schnittstelle zuvor mit dem Freischaltcode des Herstellers freigegeben sein.
4. Die Gleisspannung schaltest du in OpenStellwerk ein, dann kannst du eine Lok anlegen und fahren.

Wer erst ausprobieren will, startet den **Demo-Modus**: eine simulierte Zentrale mit Beispiel-Anlage, ganz ohne Z21.

## Danach

- **Weitere Benutzer** (Kinder, Gäste) legst du unter Verwaltung → Anlage → Benutzer an.
- **Updates** kommen aus der Oberfläche (Verwaltung → Verbindung → Update, nur Admin) direkt von GitHub. Vor dem Einspielen läuft ein Probelauf, deine Daten bleiben unangetastet.
- **Sicherung:** Unter Verwaltung gibt es die Datensicherung als eine Datei zum Herunterladen.
- **Sicherheit:** OpenStellwerk gehört ins Heimnetz. Ohne HTTPS ist das Passwort im Netzwerk mitlesbar. Den Pi nicht ungeschützt aus dem Internet erreichbar machen. Wer HTTPS möchte, nimmt Caddy davor (siehe README, „HTTPS“).

## Nützliche Befehle

```bash
sudo systemctl status openstellwerk      # läuft der Dienst?
sudo journalctl -u openstellwerk -f      # Protokoll mitlesen (mit Strg+C beenden)
sudo systemctl restart openstellwerk     # Dienst neu starten
sudo systemctl stop openstellwerk        # Dienst anhalten
```

Die Anwendungsdaten liegen in `/var/lib/openstellwerk`, die Einstellungen in `/etc/openstellwerk.env`. Sie bleiben bei Updates erhalten.

## Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| `stellwerk.local` nicht gefunden | IP-Adresse des Pi im Router nachsehen und stattdessen verwenden. |
| Seite lädt nicht | `sudo systemctl status openstellwerk` prüfen, Protokoll mit `journalctl` ansehen. Pi und Gerät müssen im selben Netz sein. |
| Zentrale wird nicht gefunden | Z21 und Pi im selben Netz? IP der Z21 von Hand eintragen. UDP-Port 21105 darf nicht gesperrt sein. |
| Installation bricht ab | Meldung lesen. Häufig fehlt das Internet oder die Uhrzeit ist falsch (`date` prüfen). Nach dem Beheben die vom Skript angelegten Dateien prüfen und das Skript erneut ausführen. |
