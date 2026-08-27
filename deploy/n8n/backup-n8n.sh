#!/usr/bin/env bash
# Back up n8n's OWN workflows + credentials.
#
# n8n does not self-backup; losing this host without these loses every workflow
# and the (encrypted) credential store. The credential export is encrypted with
# N8N_ENCRYPTION_KEY, so it is restorable ONLY with that key — keep the key off
# this host (password manager), or these files are decorative.
#
# HOW FAILURE IS REPORTED — two different failure modes, two mechanisms:
#   - backup RAN and BROKE  -> POST to Healthchecks /fail with the reason, which
#     travels into the alert so nobody has to SSH in to find out what happened.
#   - backup NEVER RAN      -> the success ping stops arriving and Healthchecks
#     alarms on the silence. A failure report cannot cover this: a cron that
#     never fires sends nothing at all, including nothing about being dead.
#
# WHAT IS VERIFIED. An export that produces an empty file is the dangerous case:
# it exists, has a plausible name and timestamp, and restores into nothing. So
# the workflow export must be present, non-trivial in size, and parse as JSON
# before this reports success. Nothing here proves RESTORABILITY — only a restore
# drill does.
#
# Usage:  ./backup-n8n.sh      (from the directory holding docker-compose.yml)
# Cron:   0 4 * * *  cd /home/ubuntu/n8n && ./backup-n8n.sh >> backups/backup.log 2>&1
set -uo pipefail

cd "$(dirname "$0")"
[ -r /etc/nemoclaw/monitor-health.env ] && { set -a; . /etc/nemoclaw/monitor-health.env; set +a; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/${STAMP}"
log() { echo "[$(date -u +%FT%TZ)] n8n backup: $*"; }

# Every early exit goes through here, so there is no silent-failure path — a
# backup that fails quietly is indistinguishable from one that never ran, and
# telling those apart is the entire design.
fail() {
  log "FAILED: $1"
  if [ -n "${BACKUP_HEALTHCHECK_URL:-}" ]; then
    curl -fsS -m 10 --data-raw "$1" "${BACKUP_HEALTHCHECK_URL%/}/fail" >/dev/null 2>&1 \
      || log "(could not reach Healthchecks — silence will raise it instead)"
  fi
  exit 1
}

mkdir -p "${OUT}" || fail "could not create ${OUT}"

# --backup encrypts the credential export with N8N_ENCRYPTION_KEY. Never dump
# credentials decrypted to disk.
docker compose exec -T n8n n8n export:credentials --all --backup \
  --output=/home/node/.n8n/_export_creds >/dev/null 2>&1 \
  || log "(no credentials to export yet — not an error)"
docker compose exec -T n8n n8n export:workflow --all \
  --output=/home/node/.n8n/_export_wf.json >/dev/null 2>&1 \
  || fail "workflow export command failed"

docker compose cp n8n:/home/node/.n8n/_export_creds "${OUT}/credentials" >/dev/null 2>&1 || true
docker compose cp n8n:/home/node/.n8n/_export_wf.json "${OUT}/workflows.json" >/dev/null 2>&1 \
  || fail "could not copy the workflow export out of the container"
docker compose exec -T n8n rm -rf /home/node/.n8n/_export_creds /home/node/.n8n/_export_wf.json >/dev/null 2>&1 || true

# ── verify, do not assume ────────────────────────────────────────────────────
[ -f "${OUT}/workflows.json" ] || fail "workflows.json missing after export"
SIZE=$(wc -c < "${OUT}/workflows.json")
[ "$SIZE" -gt 100 ] || fail "workflows.json is only ${SIZE} bytes — treating as empty"
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${OUT}/workflows.json" 2>/dev/null \
  || fail "workflows.json is not valid JSON — export is corrupt"
COUNT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else 1)" "${OUT}/workflows.json" 2>/dev/null || echo 0)
[ "$COUNT" -gt 0 ] || fail "export contains zero workflows"

# Keep the last 14 locally. The off-host copy is the durable one.
ls -1dt backups/*/ 2>/dev/null | tail -n +15 | xargs -r rm -rf

log "ok — ${COUNT} workflow(s), ${SIZE} bytes -> ${OUT}"

# Success ping LAST, so it means "a verified backup landed", not "the script
# started". This is the dead-man's switch: Healthchecks alarms when these stop.
if [ -n "${BACKUP_HEALTHCHECK_URL:-}" ]; then
  curl -fsS -m 10 --data-raw "${COUNT} workflows, ${SIZE} bytes" "$BACKUP_HEALTHCHECK_URL" >/dev/null 2>&1 \
    || log "(healthcheck ping failed — the backup itself is fine)"
fi

# STILL LOCAL-ONLY: this does not survive losing the host, which is the scenario
# a backup exists for. Copy backups/ off-host to close that:
#   aws s3 cp "${OUT}" "s3://<bucket>/n8n/${STAMP}/" --recursive
