#!/usr/bin/env bash
# sandbox-orphan-reaper.sh — reap orphaned openclaw-device processes inside the
# sandbox containers.
#
# WHY. Discovered 2026-09-06 during the gateway-heal drill. Restarting s3 put it
# into a state where a STABLE, serving gateway spawns an `openclaw-devices`
# process roughly every 40s and never reaps it. Each one holds ~300 MB. The
# parent exits, the child is reparented to PID 1 inside the container, and
# nothing collects it.
#
# s3 is the only seat with a cgroup memory cap (3.85 GiB = the "gamer 25%"
# resource profile; the other five are `max`), so on s3 the leak becomes an OOM
# crash loop within ~11 minutes: the kernel kills a process at the cap, and when
# it picks the GATEWAY rather than an orphan the seat goes dark and the revive
# loop leaks another orphan on every retry. Measured that morning: 11 orphans
# holding 2,828 MB; reaping them took the cgroup from 3.12 GB to 1.12 GB.
#
# This is a SYMPTOM treatment and is deliberately labelled as one. The real bug
# is whatever spawns and abandons those children; until that is found, this
# keeps the cap from ever being reached, so the OOM killer never has to choose
# between an orphan and the gateway.
#
# SAFETY — why this cannot kill a live agent:
#   - comm must match openclaw-device*. The live gateway's comm is `openclaw`,
#     which this NEVER touches. Orphaned `openclaw` processes are deliberately
#     left alone: identifying the live one by "ppid != 1" is unsafe, because a
#     gateway whose parent died is reparented to 1 and would look identical.
#   - ppid must be exactly 1 (already abandoned).
#   - the process must be at least MIN_AGE_SECS old, so one that is legitimately
#     mid-spawn is never taken.
# Every external command is bounded and the script ALWAYS exits 0 — the same
# bargain box-report.sh, ops-report.sh and gateway-heal.sh keep. A reaper that
# can wedge is worse than no reaper.
set -uo pipefail

MIN_AGE_SECS="${MIN_AGE_SECS:-120}"

log() { echo "[$(date -u +%FT%TZ)] orphan-reaper: $*"; }

total_killed=0
total_mb=0

for c in $(timeout 15 docker ps --filter 'name=openshell-' --format '{{.Names}}' 2>/dev/null); do
  ps_out="$(timeout 15 docker exec "$c" ps -eo pid,ppid,etimes,rss,comm 2>/dev/null)" || continue
  [ -n "$ps_out" ] || continue

  # ppid==1, comm starts with openclaw-device, old enough to be a true orphan.
  victims="$(printf '%s\n' "$ps_out" \
    | awk -v age="$MIN_AGE_SECS" '$2==1 && $3>=age && $5 ~ /^openclaw-device/ {print $1}')"
  [ -n "$victims" ] || continue

  mb="$(printf '%s\n' "$ps_out" \
    | awk -v age="$MIN_AGE_SECS" '$2==1 && $3>=age && $5 ~ /^openclaw-device/ {s+=$4} END {printf "%d", s/1024}')"

  n=0
  for p in $victims; do
    timeout 10 docker exec "$c" kill -9 "$p" 2>/dev/null && n=$((n + 1))
  done

  if [ "$n" -gt 0 ]; then
    log "${c#openshell-}: reaped ${n} orphan(s), ~${mb} MB"
    total_killed=$((total_killed + n))
    total_mb=$((total_mb + mb))
  fi
done

if [ "$total_killed" -gt 0 ]; then
  log "done: ${total_killed} orphan(s) reaped, ~${total_mb} MB reclaimed"
else
  log "done: no orphans"
fi
exit 0
