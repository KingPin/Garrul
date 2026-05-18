#!/usr/bin/env bash
# Export production D1 to a local .sql dump.
#
# Usage:
#   npm run db:export           # writes garrul-backup-YYYYMMDD.sql
#   npm run db:export -- foo    # writes foo.sql
#
# Cloudflare also keeps point-in-time backups of D1. This export is for
# your local archive (e.g., to load into a fresh dev DB).

set -euo pipefail

DB_NAME="${DB_NAME:-garrul-db}"

if [ -n "${1:-}" ]; then
  OUT="$1"
else
  OUT="garrul-backup-$(date +%Y%m%d).sql"
fi

echo "[db-export] target: $DB_NAME (remote)"
echo "[db-export] output: $OUT"

wrangler d1 export "$DB_NAME" --remote --output "$OUT"

echo "[db-export] done"
