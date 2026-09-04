#!/usr/bin/env bash
# Export production D1 to a local .sql dump.
#
# Usage:
#   npm run db:export                          # garrul-backup-YYYYMMDD.sql
#   npm run db:export -- garrul-backup-pre-upgrade.sql
#
# Cloudflare also keeps point-in-time backups of D1. This export is for
# your local archive (e.g., to load into a fresh dev DB).
#
# The output name is not free-form. This dump contains every comment body,
# every subscriber email address and every ip_hash in the database, and the
# only thing keeping it out of a commit is the `garrul-backup-*.sql` rule in
# .gitignore — which a name like `foo.sql` or `backup.sql` slips straight
# past, one `git add -A` from a public repo. So the name is enforced here
# rather than left as a convention in a comment.

set -euo pipefail

# Same data, other exposure: the file `wrangler d1 export` writes gets the
# shell's default mode, which on most workstations is 0644 — readable by
# every other account on the machine, and by anything that later syncs
# `$HOME`. Owner-only from the first byte; wrangler creates the file under
# this umask, so there is no window where it exists more openly.
umask 077

# The binding, not `database_name` — `wrangler d1 export` takes either, and
# the binding is identical on every install however the operator named their
# database. Override with DB=<name> if you keep more than one around.
DB="${DB:-DB}"

if [ -n "${1:-}" ]; then
  OUT="$1"
else
  OUT="garrul-backup-$(date +%Y%m%d).sql"
fi

# Match .gitignore:25 exactly: the basename must be garrul-backup-*.sql. A
# directory prefix is fine — the rule is unanchored, so it applies at any
# depth — but the file itself has to carry the name the rule matches.
OUT_BASE="$(basename -- "$OUT")"
case "$OUT_BASE" in
  garrul-backup-*.sql) ;;
  *)
    echo "[db-export] refusing to write '$OUT'." >&2
    echo "[db-export] The dump holds comment bodies, subscriber emails and" >&2
    echo "[db-export] ip_hashes; only 'garrul-backup-*.sql' is gitignored." >&2
    echo "[db-export] Try: npm run db:export -- garrul-backup-mylabel.sql" >&2
    exit 2
    ;;
esac

echo "[db-export] target: $DB (remote)"
echo "[db-export] output: $OUT"

wrangler d1 export "$DB" --remote --output "$OUT"

echo "[db-export] done"
