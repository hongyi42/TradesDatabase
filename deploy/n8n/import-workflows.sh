#!/usr/bin/env bash
# Import the tracked workflow definitions in workflows/ into the running n8n.
#
# WHY THIS EXISTS. n8n's workflows live only in its own database. Authored in the
# UI, they are invisible to review, unreproducible after a host loss, and the only
# copy is the nightly export sitting on the same disk. Tracking them as JSON makes
# them reviewable in a diff and rebuildable from the repo.
#
# PLACEHOLDERS. A Healthchecks ping URL is a write capability — anyone holding it
# can mark the check up or down — so it does NOT go in git. Workflow JSON carries
# __UPPER_SNAKE__ tokens instead, substituted here from the same env file the shell
# reporters read. An unresolved token is a HARD FAILURE, never a pass-through: a
# workflow that posts to the literal string "__PROBE_HEALTHCHECK_URL__" would look
# installed and alert nobody.
#
# Usage (on the monitor host, from the directory holding docker-compose.yml):
#   ./import-workflows.sh                   # import + activate everything
#   ./import-workflows.sh external-probes.json
#
# No root needed: the env file is 0644 on purpose, because backup-n8n.sh reads it
# from ubuntu's crontab and 0600 would make the backup's ping silently stop. The
# tradeoff is that any local account can read the ping URLs, which is acceptable
# only because this host has exactly one human account and no tenant data.
set -uo pipefail

cd "$(dirname "$0")"

ENV_FILE="${MONITOR_HEALTH_ENV:-/etc/nemoclaw/monitor-health.env}"
WF_DIR="${WF_DIR:-workflows}"
COMPOSE_DIR="${COMPOSE_DIR:-$PWD}"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -f "${COMPOSE_DIR}/docker-compose.yml" ] || die "no docker-compose.yml in ${COMPOSE_DIR} — run this from the n8n directory"
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (run with sudo)"
[ -d "$WF_DIR" ] || die "no ${WF_DIR}/ directory"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  mapfile -t FILES < <(find "$WF_DIR" -maxdepth 1 -name '*.json' | sort)
fi
[ "${#FILES[@]}" -gt 0 ] || die "no workflow JSON found in ${WF_DIR}/"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

IMPORTED=()

for f in "${FILES[@]}"; do
  [ -f "$f" ] || f="${WF_DIR}/${f}"
  [ -f "$f" ] || die "no such workflow file: $f"
  base="$(basename "$f")"
  echo "── $base"

  # CRLF here would survive into the container and corrupt the JSON. Editing these
  # on Windows already cost us one broken deploy (a bash script with \r in its
  # shebang), so strip rather than trust.
  tr -d '\r' < "$f" > "${TMP}/${base}"

  # Resolve every __TOKEN__ from the env file. Unset -> refuse.
  tokens="$(grep -o '__[A-Z0-9_]\+__' "${TMP}/${base}" | sort -u || true)"
  for tok in $tokens; do
    name="${tok#__}"; name="${name%__}"
    val="${!name:-}"
    [ -n "$val" ] || die "$base needs $name, which is not set in $ENV_FILE"
    # | is safe: URLs never contain it, and the values here are URLs.
    sed -i "s|${tok}|${val}|g" "${TMP}/${base}"
  done

  grep -q '__[A-Z0-9_]\+__' "${TMP}/${base}" \
    && die "$base still has unresolved placeholders after substitution"

  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${TMP}/${base}" 2>/dev/null \
    || die "$base is not valid JSON after substitution"

  wf_id="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d[0]['id'] if isinstance(d,list) else d['id'])" "${TMP}/${base}")"
  [ -n "$wf_id" ] || die "$base has no workflow id"

  (cd "$COMPOSE_DIR" && docker compose cp "${TMP}/${base}" "n8n:/home/node/.n8n/_import.json") >/dev/null \
    || die "could not copy $base into the container"
  (cd "$COMPOSE_DIR" && docker compose exec -T n8n n8n import:workflow --input=/home/node/.n8n/_import.json) \
    || die "import failed for $base"
  (cd "$COMPOSE_DIR" && docker compose exec -T n8n rm -f /home/node/.n8n/_import.json) >/dev/null 2>&1 || true

  # update:workflow writes the DB flag and says so itself: "changes will not take
  # effect if n8n is running". The restart below is what actually arms the trigger.
  (cd "$COMPOSE_DIR" && docker compose exec -T n8n n8n update:workflow --id="$wf_id" --active=true) \
    || die "could not activate $wf_id"
  IMPORTED+=("$wf_id")
done

echo "── restarting n8n so the schedule triggers re-register"
(cd "$COMPOSE_DIR" && docker compose restart n8n) >/dev/null || die "restart failed"

# Read back what is actually running, rather than trusting the commands above.
sleep 8

# Captured ONCE into a variable, and matched without a pipe. Both details are
# load-bearing under `set -o pipefail`:
#   `docker compose exec … | grep -q "^${id}|"` reports FAILURE ON SUCCESS —
#   grep -q exits the moment it matches, the closed pipe gives the upstream exec
#   a SIGPIPE, and pipefail propagates that as the pipeline's status. It only
#   shows up for an id that is NOT the last line of output, which is why it hid
#   until a second workflow was added.
# A verifier that cries wolf gets disabled, so this one must never false-alarm.
ACTIVE="$( (cd "$COMPOSE_DIR" && docker compose exec -T n8n n8n list:workflow --active=true 2>/dev/null) || true )"

echo "── active workflows now:"
printf '%s\n' "$ACTIVE" | grep -v '^Failed to load' || true

for id in "${IMPORTED[@]}"; do
  case "$ACTIVE" in
    *"${id}|"*) ;;
    *) die "$id imported but is NOT active — check the n8n log" ;;
  esac
done
echo "ok — ${#IMPORTED[@]} workflow(s) imported and active"
