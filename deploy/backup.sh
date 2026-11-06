#!/usr/bin/env bash
# Daily backup of the production SQLite database for notas-whatsapp.
#
# Copies the live DB to ~/backups/notas-whatsapp/notas-YYYY-MM-DD.db, then
# deletes backups older than 7 days. Meant to be installed as a daily cron
# entry — see deploy/README.md, "Install the daily backup cron job".
#
# Usage:
#   APP_DIR=/home/ubuntu/notas-whatsapp deploy/backup.sh
# (APP_DIR defaults to the repo this script lives in, two levels up from
# deploy/backup.sh, so it also works unmodified when run manually from a
# checkout.)
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$APP_DIR/.env"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/notas-whatsapp}"
RETENTION_DAYS=7

if [[ ! -f "$ENV_FILE" ]]; then
	echo "backup.sh: $ENV_FILE not found — can't read DATABASE_URL" >&2
	exit 1
fi

# Pull DATABASE_URL out of .env without sourcing the whole file (it may
# contain values with characters that aren't safe to eval, e.g. the bcrypt
# hash in WEBAPP_PASSWORD_HASH).
raw_url="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
raw_url="${raw_url%\"}"
raw_url="${raw_url#\"}"

if [[ -z "$raw_url" ]]; then
	echo "backup.sh: DATABASE_URL not set in $ENV_FILE" >&2
	exit 1
fi

# Prisma's sqlite connector resolves a relative "file:" path relative to
# prisma/schema.prisma's directory, NOT the process's cwd — so
# DATABASE_URL="file:./prod.db" lives at $APP_DIR/prisma/prod.db on disk,
# not $APP_DIR/prod.db. An absolute "file:" path is used as-is.
db_rel_path="${raw_url#file:}"
if [[ "$db_rel_path" = /* ]]; then
	db_file="$db_rel_path"
else
	db_file="$APP_DIR/prisma/${db_rel_path#./}"
fi

if [[ ! -f "$db_file" ]]; then
	echo "backup.sh: database file not found at $db_file (from DATABASE_URL=$raw_url)" >&2
	exit 1
fi

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%F)"
dest="$BACKUP_DIR/notas-$timestamp.db"

# Use sqlite3's own online ".backup" command rather than a plain `cp`: the
# app may be mid-write (WAL mode / an open transaction) when this cron job
# fires, and `.backup` takes a consistent snapshot safely while the
# database is in use, instead of risking a half-written copy. Falls back
# to `cp` only if the sqlite3 CLI isn't installed.
if command -v sqlite3 >/dev/null 2>&1; then
	sqlite3 "$db_file" ".backup '$dest'"
else
	echo "backup.sh: sqlite3 CLI not found, falling back to a plain file copy (install sqlite3 for a safer online backup)" >&2
	cp "$db_file" "$dest"
fi

echo "backup.sh: wrote $dest"

# Prune backups older than $RETENTION_DAYS days.
find "$BACKUP_DIR" -maxdepth 1 -name 'notas-*.db' -mtime "+$RETENTION_DAYS" -print -delete
