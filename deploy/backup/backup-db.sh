#!/usr/bin/env bash
# backup-db.sh — take an off-vendor logical backup of the Supabase database.
#
# WHY THIS EXISTS. The pilot is on Supabase's free tier, which takes ZERO backups.
# Four tenants live there, one of them a real firm with customer and job history, and
# `raw_captures` is append-only — losing it is not recoverable from anywhere else.
# Supabase Pro ($25/mo) would add daily snapshots, but this is better on the axis that
# matters most and costs ~$1/mo: the copy lands OUTSIDE the vendor, so it survives
# losing the Supabase project or account itself, not just a bad write.
#
# WHY DOCKER FOR pg_dump. pg_dump refuses to dump a server NEWER than itself, so the
# client major version is load-bearing, and the box has no postgres-client installed.
# Pinning `postgres:17-alpine` matches the server exactly (supabase/config.toml
# major_version = 17) and keeps the box free of apt state that can drift. Bump this
# pin when the database is upgraded — a mismatch fails loudly, which is the point.
#
# HOW FAILURE IS REPORTED — two different failure modes, two mechanisms:
#   - backup RAN and BROKE  -> POST /control/ops (service=db-backup, status=down).
#     That reuses the proven alert path: recordOpsEvent folds repeats into ONE
#     incident and opsNotify pushes it to Telegram. `service` is free text precisely
#     so a new producer needs no migration.
#   - backup NEVER RAN      -> the success ping to Healthchecks stops arriving and
#     Healthchecks alarms on the silence. A failure report cannot cover this case:
#     a dead cron sends nothing at all, including nothing about being dead.
#
# WHAT IS NOT COVERED. A backup that succeeds but is unrestorable. Nothing here proves
# restorability — only a restore drill does. Run one; a backup nobody has restored is
# a guess (docs/prod-migration-checklist.md).
#
# Usage:  ./backup-db.sh          (reads ./backup.env, or $BACKUP_ENV_FILE)
# Cron:   30 4 * * *  /home/ubuntu/backup/backup-db.sh >> /home/ubuntu/backup/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE="${BACKUP_ENV_FILE:-./backup.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (see backup.env.example)"; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"
PGIMAGE="${PGIMAGE:-postgres:17-alpine}"
OUT_DIR="${OUT_DIR:-./backups}"
KEEP_LOCAL="${KEEP_LOCAL:-14}"
DOCKER_NET="${DOCKER_NET:-host}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/pilot-${STAMP}.sql.gz"
mkdir -p "$OUT_DIR"

log() { echo "[$(date -u +%FT%TZ)] backup-db: $*"; }

# Report a failure through the ops pipeline, then exit non-zero. Every early exit goes
# through here so there is no silent-failure path — a backup that fails quietly is
# indistinguishable from one that never ran, and the whole design rests on telling
# those apart. Best-effort: if the collector is unreachable we still exit non-zero so
# cron's own mail/log carries it.
fail() {
  local reason="$1"
  log "FAILED: ${reason}"
  if [ -n "${OPS_REPORT_URL:-}" ] && [ -n "${HOST_PULL_TOKEN:-}" ]; then
    # Keys-only discipline: the reason is our own text, never the DB URL or output
    # that could contain a connection string.
    curl -sS -m 10 --connect-timeout 5 -X POST "$OPS_REPORT_URL" \
      -H "Authorization: Bearer ${HOST_PULL_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data-binary "$(printf '{"service":"db-backup","status":"down","detail":{"reason":"%s","reportedBy":"backup-db.sh"}}' "$reason")" \
      >/dev/null 2>&1 || log "(could not reach the ops collector)"
  fi
  exit 1
}

log "starting → ${FILE}"

# --no-owner/--no-acl: the dump must restore into a DIFFERENT project (that is the
# whole point of an off-vendor copy), where Supabase's internal role names may not
# match. Roles are recreated by the platform, not by us.
if ! docker run --rm --network "$DOCKER_NET" "$PGIMAGE" \
      pg_dump --no-owner --no-acl --format=plain "$SUPABASE_DB_URL" 2>/tmp/pgdump.err \
      | gzip -9 > "$FILE"; then
  fail "pg_dump exited non-zero: $(tail -c 300 /tmp/pgdump.err | tr -d '\n"' || true)"
fi

# A truncated dump is the dangerous case: it exists, has a plausible name, and restores
# into a partial database. Check the file is substantial AND that gzip considers the
# stream complete AND that the SQL actually terminates the way pg_dump ends a dump.
SIZE=$(wc -c < "$FILE")
[ "$SIZE" -gt 10000 ] || fail "dump is only ${SIZE} bytes — treating as truncated"
gzip -t "$FILE" 2>/dev/null || fail "gzip integrity check failed"
zcat "$FILE" | tail -5 | grep -q "PostgreSQL database dump complete" \
  || fail "dump does not end with pg_dump's completion marker — likely truncated"

log "dump ok (${SIZE} bytes)"

# Off-box copy. A backup that only exists on the box dies with the box, which is the
# scenario it is meant to survive. Local-only is a staging area, not a backup.
if [ -n "${S3_BUCKET:-}" ]; then
  if ! docker run --rm --network "$DOCKER_NET" \
        -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
        -v "$(cd "$OUT_DIR" && pwd)":/data \
        amazon/aws-cli:2 s3 cp "/data/$(basename "$FILE")" "s3://${S3_BUCKET}/db/$(basename "$FILE")" \
        >/dev/null 2>/tmp/s3.err; then
    fail "s3 upload failed: $(tail -c 200 /tmp/s3.err | tr -d '\n"' || true)"
  fi
  log "uploaded to s3://${S3_BUCKET}/db/$(basename "$FILE")"
else
  log "S3_BUCKET unset — LOCAL ONLY, this does not survive losing the box"
fi

# Local retention. The off-box copy is the durable one; these are for fast restores.
ls -1t "${OUT_DIR}"/pilot-*.sql.gz 2>/dev/null | tail -n "+$((KEEP_LOCAL + 1))" | xargs -r rm -f

# Success ping LAST, so it means "a verified dump landed", not "the script started".
# This is the dead-man's switch: Healthchecks alarms when these stop arriving, which
# is the only way a never-ran backup can announce itself.
if [ -n "${HEALTHCHECK_URL:-}" ]; then
  curl -sS -m 10 --connect-timeout 5 "$HEALTHCHECK_URL" >/dev/null 2>&1 \
    || log "(healthcheck ping failed — backup itself is fine)"
fi

# Clear any open db-backup incident so a recovery is recorded and announced.
if [ -n "${OPS_REPORT_URL:-}" ] && [ -n "${HOST_PULL_TOKEN:-}" ]; then
  curl -sS -m 10 --connect-timeout 5 -X POST "$OPS_REPORT_URL" \
    -H "Authorization: Bearer ${HOST_PULL_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "{\"service\":\"db-backup\",\"status\":\"ok\",\"detail\":{\"bytes\":${SIZE},\"reportedBy\":\"backup-db.sh\"}}" \
    >/dev/null 2>&1 || true
fi

log "done"
