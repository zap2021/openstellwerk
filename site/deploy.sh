#!/usr/bin/env bash
# Lädt die Projektseite per FTPS auf den Webspace (Zugang aus ~/.netrc).
set -euo pipefail
cd "$(dirname "$0")"
H=ftp://w00d7152.kasserver.com
for f in fonts/*.woff2 fonts.css poster.png film.webm index.html; do
  curl -sS --netrc --ssl-reqd --ftp-create-dirs -T "$f" "$H/$f"
done
echo "Hochgeladen."
