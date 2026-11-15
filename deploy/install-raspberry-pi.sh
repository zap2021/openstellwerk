#!/usr/bin/env bash
# Erstinstallation auf Raspberry Pi OS (ARM64 oder ARMv7), aus einem Projekt-Checkout.
set -Eeuo pipefail

SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
INSTALL_DIR=/opt/openstellwerk
NODE_DIR=/opt/openstellwerk-node
ENV_FILE=/etc/openstellwerk.env
UNIT_FILE=/etc/systemd/system/openstellwerk.service
DROPIN_DIR=/etc/systemd/system/openstellwerk.service.d

die() { printf 'Fehler: %s\n' "$*" >&2; exit 1; }
trap 'printf "Installation fehlgeschlagen (Zeile %s). Bereits angelegte Dateien bleiben erhalten.\n" "$LINENO" >&2' ERR

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf 'Aufruf: sudo bash deploy/install-raspberry-pi.sh\nInstalliert OpenStellwerk auf Raspberry Pi OS (ARM64 oder ARMv7) als systemd-Dienst.\n'
  exit 0
fi
[[ $# == 0 ]] || die 'Unbekannte Argumente. Hilfe: --help'
[[ $EUID == 0 ]] || die 'Bitte mit sudo ausführen.'
case $(uname -m) in
  aarch64) NODE_ARCH=arm64 ;;
  armv7l) NODE_ARCH=armv7l ;;
  *) die 'Dieses Skript unterstützt nur ARM64 (aarch64) und ARMv7 (armv7l).' ;;
esac
[[ -d /run/systemd/system ]] || die 'Ein laufendes systemd wird benötigt.'
[[ -f $SOURCE_DIR/package-lock.json && -f $SOURCE_DIR/deploy/openstellwerk.service ]] || die 'Projektdateien nicht gefunden.'
[[ ! -e $INSTALL_DIR && ! -L $INSTALL_DIR ]] || die "$INSTALL_DIR existiert bereits; es wird nichts überschrieben."
[[ ! -e $ENV_FILE && ! -L $ENV_FILE ]] || die "$ENV_FILE existiert bereits; es wird nichts überschrieben."
[[ ! -e $UNIT_FILE && ! -L $UNIT_FILE && ! -e $DROPIN_DIR && ! -L $DROPIN_DIR ]] || die 'Die systemd-Konfiguration für openstellwerk existiert bereits.'
[[ -t 0 ]] || die 'Ein Terminal für die Passworteingabe wird benötigt.'

printf 'Passwort für den Zugriff auf OpenStellwerk: '
read -r -s PASSWORD
printf '\nPasswort wiederholen: '
read -r -s PASSWORD_CONFIRM
printf '\n'
[[ -n $PASSWORD && $PASSWORD == "$PASSWORD_CONFIRM" ]] || die 'Passwörter sind leer oder stimmen nicht überein.'
(( ${#PASSWORD} >= 3 )) || die 'Das Passwort braucht mindestens 3 Zeichen.'
LC_ALL=C grep -q '^[ -~]*$' <<< "$PASSWORD" || die 'Das Passwort darf nur druckbare ASCII-Zeichen enthalten.'
unset PASSWORD_CONFIRM

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils

# Ein systemweit installiertes Node.js ab Version 22 kann weiterverwendet werden.
NODE_BIN=$(command -v node || true)
if [[ -n $NODE_BIN ]] && (( $("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])') >= 22 )) && command -v npm >/dev/null; then
  NODE_BIN=$(readlink -f "$NODE_BIN")
  NODE_PATH="$(dirname -- "$NODE_BIN"):$(dirname -- "$(command -v npm)")"
else
  [[ ! -e $NODE_DIR && ! -L $NODE_DIR ]] || die "$NODE_DIR existiert bereits; es wird nichts überschrieben."
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf -- "$TMP_DIR"' EXIT
  printf 'Lade aktuelles Node.js 22 für %s herunter …\n' "$NODE_ARCH"
  curl -fsSL https://nodejs.org/dist/index.tab -o "$TMP_DIR/index.tab"
  NODE_VERSION=$(awk '$1 ~ /^v22\./ { print $1; exit }' "$TMP_DIR/index.tab")
  [[ $NODE_VERSION =~ ^v22\.[0-9]+\.[0-9]+$ ]] || die 'Node.js-22-Version konnte nicht ermittelt werden.'
  ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "$TMP_DIR/$ARCHIVE"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "$TMP_DIR/SHASUMS256.txt"
  (cd "$TMP_DIR" && grep -F "  $ARCHIVE" SHASUMS256.txt | sha256sum -c -)
  mkdir "$NODE_DIR"
  tar -xJf "$TMP_DIR/$ARCHIVE" -C "$NODE_DIR" --strip-components=1
  NODE_BIN="$NODE_DIR/bin/node"
  NODE_PATH="$NODE_DIR/bin"
fi
printf 'Node.js: %s\n' "$("$NODE_BIN" --version)"

if ! id openstellwerk >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin openstellwerk
fi
mkdir "$INSTALL_DIR"
# Keine lokalen Daten, Git-Metadaten oder plattformspezifischen node_modules übernehmen.
tar -C "$SOURCE_DIR" --exclude='./.git' --exclude='./.superpowers' --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='./apps/server/data' --exclude='*/dist' --exclude='./.env' -cf - . |
  tar -C "$INSTALL_DIR" --no-same-owner -xf -
chown -R openstellwerk: "${INSTALL_DIR}"

printf 'Installiere Abhängigkeiten und baue die Oberfläche …\n'
runuser -u openstellwerk -- env PATH="$NODE_PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash -c \
  'cd "$1" && npm ci && npm run build' _ "$INSTALL_DIR"

# systemd EnvironmentFile verwendet eigene Regeln für Anführungszeichen und Backslashes.
PASSWORD=${PASSWORD//\\/\\\\}
PASSWORD=${PASSWORD//\"/\\\"}
umask 077
printf 'OPENSTELLWERK_PASSWORD="%s"\n' "$PASSWORD" > "$ENV_FILE"
unset PASSWORD
install -m 644 "$INSTALL_DIR/deploy/openstellwerk.service" "$UNIT_FILE"
mkdir -m 755 "$DROPIN_DIR"
printf '[Service]\nExecStart=\nExecStart=%s --import tsx apps/server/src/main.ts\n' "$NODE_BIN" > "$DROPIN_DIR/node.conf"
chmod 644 "$DROPIN_DIR/node.conf"
systemctl daemon-reload
systemctl enable --now openstellwerk.service

printf '\nInstallation abgeschlossen. Zugriff: http://<IP-des-Pi>:3001\n'
printf 'Status: sudo systemctl status openstellwerk\nProtokoll: sudo journalctl -u openstellwerk -f\n'
printf 'Hinweis: Ohne HTTPS wird das Passwort im Netzwerk unverschlüsselt übertragen.\n'
