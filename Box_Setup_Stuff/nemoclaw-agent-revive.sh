#!/usr/bin/env bash
# Revive the in-sandbox NemoClaw supervisor+agent after a container/box restart.
#
# Background (2026-07-04, discovered during the Lightsail migration): in this
# NemoClaw generation the agent supervisor is started ONLY by the create/rebuild
# flow (`openshell sandbox create -- env nemoclaw-start`); a container restart
# brings up bare PID1 (openshell-sandbox) and nothing relaunches the agent —
# every CLI recovery path fails with SUPERVISOR_UNAVAILABLE. The working fix:
# re-run the stored startup command via a gateway-mediated exec (which carries
# the startup-transaction ownership a raw `docker exec` lacks), then clear the
# device-pairing residue with a managed `nemoclaw <agent> gateway restart`.
#
# Run under systemd (nemoclaw-agent-<AGENT>.service) with Restart=always:
# if the exec session dies (container restarted), systemd re-runs this wrapper,
# which waits for the container+gateway and revives again. The wrapper is also
# a no-op babysitter when the agent is already supervised (fresh rebuild).
set -u
AGENT="${1:?usage: nemoclaw-agent-revive.sh <agent>}"
BIN=/home/ubuntu/.local/bin

# Wait for the sandbox container and the OpenShell gateway (:8080).
while :; do
  CID=$(docker ps -q --filter "name=openshell-${AGENT}-" | head -1)
  [ -n "$CID" ] && ss -tln 2>/dev/null | grep -q ":8080 " && break
  sleep 5
done

# Already supervised (fresh onboard/rebuild)? Hold the unit active and watch;
# if the supervisor dies later, fall through and revive on the next loop.
while docker exec "$CID" pgrep -f /usr/local/bin/nemoclaw-start >/dev/null 2>&1; do
  sleep 30
  CID=$(docker ps -q --filter "name=openshell-${AGENT}-" | head -1)
  [ -n "$CID" ] || exit 1   # container gone; systemd restarts us into the wait loop
done

# Clear pairing residue once the revived gateway settles (best-effort).
( sleep 75; "$BIN/nemoclaw" "$AGENT" gateway restart >/dev/null 2>&1 || true ) &

echo "reviving agent in sandbox ${AGENT} (container ${CID})"
exec "$BIN/openshell" sandbox exec --name "$AGENT" -- env nemoclaw-start
