#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/berlingerhaus}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/berlingerhaus}"
KEEP_DAYS="${KEEP_DAYS:-35}"
TIMESTAMP="$(date +%F-%H%M%S)"

mkdir -p "$BACKUP_DIR"

tar -czf "$BACKUP_DIR/berlingerhaus-$TIMESTAMP.tar.gz" \
  -C "$APP_DIR" \
  db.sqlite \
  app/assets/products

find "$BACKUP_DIR" -type f -name 'berlingerhaus-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

echo "Backup creado en $BACKUP_DIR/berlingerhaus-$TIMESTAMP.tar.gz"
