#!/usr/bin/env bash
# Back up n8n's OWN workflows + credentials (prod-devops Phase 1 · Step 5).
# n8n does not self-backup; a box loss without this loses every workflow and the
# (encrypted) credential store. Cron this daily and copy backups/ off-box (S3 or a
# private repo). The credential export is encrypted with N8N_ENCRYPTION_KEY, so it
# is only restorable WITH that key — keep the key off-box too (password manager).
#
# Usage (from deploy/n8n/):  ./backup-n8n.sh
# Cron:  0 4 * * *  cd /path/to/deploy/n8n && ./backup-n8n.sh >> backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/${STAMP}"
mkdir -p "${OUT}"

# --backup encrypts the credential export with N8N_ENCRYPTION_KEY (never dump
# --decrypted to disk). Workflows export as plain JSON.
docker compose exec -T n8n n8n export:credentials --all --backup --output=/home/node/.n8n/_export_creds
docker compose exec -T n8n n8n export:workflow    --all           --output=/home/node/.n8n/_export_wf.json

# Pull the exports out of the container into the timestamped dir.
docker compose cp n8n:/home/node/.n8n/_export_creds "${OUT}/credentials"
docker compose cp n8n:/home/node/.n8n/_export_wf.json "${OUT}/workflows.json"
docker compose exec -T n8n rm -rf /home/node/.n8n/_export_creds /home/node/.n8n/_export_wf.json

# Keep the last 14 daily backups locally; off-box copy is the durable one.
ls -1dt backups/*/ 2>/dev/null | tail -n +15 | xargs -r rm -rf

echo "[$(date -u +%FT%TZ)] n8n backup written to ${OUT}"
# TODO: copy "${OUT}" off-box, e.g.:
#   aws s3 cp "${OUT}" "s3://<your-bucket>/n8n/${STAMP}/" --recursive
