#!/usr/bin/env bash
# second-stack.sh — bring up an ADDITIONAL local Supabase stack for this git
# worktree, so a second feature branch can run `npm test` / `npm run seed:local`
# concurrently with the main checkout's stack.
#
# Everything happens inside the CURRENT worktree; the main checkout's stack
# (project_id "TradesDatabase", ports 543xx) is untouched:
#   1. Rewrites supabase/config.toml (kept uncommitted): unique project_id and
#      shifted ports, so containers, volumes, and ports don't collide.
#   2. Starts the stack (npx supabase start — applies migrations).
#   3. Writes this worktree's .env.test pointing at the shifted ports. Both the
#      test suite (src/test.setup.ts) and the seeder (scripts/seed.mjs --local)
#      read .env.test, so they target THIS stack automatically. testEnvGuard
#      only requires 127.0.0.1 — ports don't matter to it.
#
# Usage: scripts/second-stack.sh [N]
#   N = stack index 1..6 (default 1) → ports 54(3+N)xx (N=1 → 544xx).
#       Use a different N for each extra concurrent worktree.
#
# Re-running it IS the repair path: it renames a stale or oversized project_id
# and re-shifts the ports to the N you pass, then starts. It refuses while a
# stack is still up under the old id, since renaming would orphan it.
#
# Cleanup for a scratch worktree (stops ONLY this stack, deletes its data):
#   npx supabase stop --no-backup
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Refuse to run in the main checkout: it owns the default stack, and rewriting
# its config.toml would orphan the already-running containers.
if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]; then
  echo "ERROR: this is the main checkout, which keeps the default stack (543xx)." >&2
  echo "Run this from a linked worktree (git worktree add <path> <branch>)." >&2
  exit 1
fi

N="${1:-1}"
case "$N" in
  [1-6]) ;;
  *) echo "ERROR: N must be 1..6 (got '$N')" >&2; exit 1 ;;
esac
PORT_PREFIX="54$((3 + N))"

# The project_id has to survive the CLI's own sanitiser unchanged. That sanitiser
# replaces every run of characters outside [a-zA-Z0-9_.-] with "_", trims leading
# "_.-", and then CUTS THE RESULT AT 40 BYTES — a plain byte cut that happily
# leaves the id ending in "-" (sanitizeProjectId, supabase/cli v2.107.0:
# https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/pkg/config/config.go#L1036-L1053).
# Every container is then named supabase_<svc>_<id>, and that name is the hostname
# the other containers dial. Go's resolver rejects a hostname whose label ends in
# "-" WITHOUT querying DNS, so a trailing hyphen shows up as auth failing with
# "no such host" against a db container that is up and healthy, and `start` rolls
# the whole stack back (hit 2026-09-11: a 40-character worktree directory name).
# So cap it at 40 here, always ending alphanumeric, and mix in a hash of the full
# name so two long worktrees sharing a prefix don't silently share one stack.
SUFFIX="$(basename "$PWD" | tr -cd 'a-zA-Z0-9-')"
PROJECT_ID="TradesDatabase-${SUFFIX}"
if [ "${#PROJECT_ID}" -gt 40 ]; then
  if command -v md5 >/dev/null 2>&1; then
    HASH="$(printf '%s' "$SUFFIX" | md5 -q)"
  else
    HASH="$(printf '%s' "$SUFFIX" | md5sum | cut -d' ' -f1)"
  fi
  PROJECT_ID="$(printf '%s' "${PROJECT_ID:0:33}" | sed -E 's/[-_.]+$//')-${HASH:0:6}"
fi

CURRENT_ID="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -1)"
case "$CURRENT_ID" in
  "$PROJECT_ID")
    echo "config.toml already names ${PROJECT_ID}."
    ;;
  "TradesDatabase" | TradesDatabase-*)
    if [ "$CURRENT_ID" != "TradesDatabase" ]; then
      # Renaming leaves anything still running under the old id orphaned: the CLI
      # would no longer know those containers belong to this worktree.
      OLD_LABEL="$(printf '%s' "$CURRENT_ID" | cut -c1-40)"
      if [ -n "$(docker ps -q --filter "name=^supabase_db_${OLD_LABEL}\$" 2>/dev/null)" ]; then
        echo "ERROR: a stack is still running as ${OLD_LABEL}; stop it before renaming:" >&2
        echo "  npx supabase stop --no-backup" >&2
        exit 1
      fi
      echo "NOTE: renaming stale project_id ${CURRENT_ID} → ${PROJECT_ID}."
    fi
    perl -pi -e "s/^project_id = \".*\"\$/project_id = \"${PROJECT_ID}\"/" supabase/config.toml
    ;;
  *)
    echo "ERROR: supabase/config.toml has an unexpected project_id ('${CURRENT_ID}'); won't rewrite." >&2
    exit 1
    ;;
esac

# Shift every 54[3-9]xx port onto this stack's prefix (54321→${PORT_PREFIX}21, ...);
# re-running with a different N moves an already-shifted stack.
perl -pi -e "s/\b54[3-9](\d\d)\b/${PORT_PREFIX}\$1/g if /port/" supabase/config.toml
# Edge-runtime inspector is outside the 543xx range; shift it too.
perl -pi -e "s/^inspector_port = 8\d?83\$/inspector_port = 8${N}83/" supabase/config.toml
echo "config.toml: project_id=${PROJECT_ID}, ports ${PORT_PREFIX}xx (leave uncommitted)."

npx supabase start

# supabase status -o env prints KEY="value" lines; pull the three .env.test values.
STATUS="$(npx supabase status -o env 2>/dev/null)"
env_val() { printf '%s\n' "$STATUS" | grep "^$1=" | head -1 | cut -d= -f2- | tr -d '"'; }
API_URL="$(env_val API_URL)"
DB_URL="$(env_val DB_URL)"
SECRET_KEY="$(env_val SECRET_KEY)"   # sb_secret_... — the "Secret" key .env.test wants

for v in API_URL DB_URL SECRET_KEY; do
  if [ -z "${!v}" ]; then
    echo "ERROR: could not read $v from 'npx supabase status -o env'." >&2
    exit 1
  fi
done
case "$API_URL" in
  http://127.0.0.1:${PORT_PREFIX}*) ;;
  *) echo "ERROR: stack came up at ${API_URL}, expected 127.0.0.1:${PORT_PREFIX}xx — is another config active?" >&2
     exit 1 ;;
esac

[ -f .env.test ] && echo "NOTE: overwriting existing .env.test (regenerated from this stack)."
cat > .env.test <<EOF
# Generated by scripts/second-stack.sh — stack ${PROJECT_ID} (ports ${PORT_PREFIX}xx).
SUPABASE_URL=${API_URL}
SUPABASE_SERVICE_ROLE_KEY=${SECRET_KEY}
DATABASE_URL=${DB_URL}
EOF

echo
echo "Second stack ready: ${PROJECT_ID} @ ${API_URL}"
echo ".env.test written — npm test and npm run seed:local now target this stack."
echo "Next steps in this worktree:"
echo "  npm ci                # if node_modules is missing"
echo "  npm run seed:local    # optional: rebuild the playground on this stack"
echo "  npm test"
