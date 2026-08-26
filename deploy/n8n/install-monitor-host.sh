#!/usr/bin/env bash
# install-monitor-host.sh — bring up the dedicated n8n monitor host (Phase B2-B6).
#
# Run ON THE NEW INSTANCE, after copying docker-compose.yml and backup-n8n.sh
# into the same directory. Everything here is idempotent: re-running installs
# nothing twice, and it will NOT regenerate the encryption key.
#
#   scp -i <key.pem> docker-compose.yml backup-n8n.sh install-monitor-host.sh \
#       ubuntu@<new-ip>:~/n8n/
#   ssh -i <key.pem> ubuntu@<new-ip> 'cd ~/n8n && ./install-monitor-host.sh'
set -euo pipefail

cd "$(dirname "$0")"
say() { echo; echo "── $* ────────────────────────────────────────────"; }

# ── 0. refuse to run on the wrong machine ───────────────────────────────────
# Installing the monitor onto the box it is supposed to monitor would look like
# success and silently undo the entire point of the move: a monitor sharing a
# host with its subject cannot report that host dying. Cheap guard, total cost
# of getting it wrong is a monitoring system that lies.
if systemctl list-units --all --no-legend --plain 'nemoclaw-*' 2>/dev/null | grep -q .; then
  echo "REFUSING: this machine runs nemoclaw units — it is the AGENT BOX, not the monitor host."
  exit 1
fi
[ -f docker-compose.yml ] || { echo "REFUSING: docker-compose.yml not found in $(pwd)"; exit 1; }

# ── 1. docker + the compose plugin ──────────────────────────────────────────
# The agent box has no compose plugin, which is why n8n runs there under a raw
# `docker run`. This host gets it, so deploy/n8n/docker-compose.yml is used as
# written rather than hand-translated.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  say "docker + compose already present ($(docker --version))"
else
  say "installing docker + compose plugin"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "docker installed: $(docker --version)"
fi
# The group change does not apply to this shell, so everything below uses sudo
# explicitly rather than relying on a re-login that has not happened yet.
DC="sudo docker compose"

# ── 2. .env — generate ONCE, never overwrite ────────────────────────────────
# Regenerating N8N_ENCRYPTION_KEY on a re-run would make every stored credential
# undecryptable AND make every existing backup unrestorable, with no error at the
# moment it happens. So this is create-if-absent, never update.
if [ -f .env ]; then
  say ".env already exists — leaving it alone (NOT regenerating the encryption key)"
else
  say "generating .env"
  umask 077
  {
    echo "N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)"
    echo "TZ=${TZ_OVERRIDE:-America/Los_Angeles}"
  } > .env
  chmod 600 .env
  echo "written, chmod 600."
  echo
  echo "  ⚠ COPY THE KEY INTO A PASSWORD MANAGER NOW, off this host:"
  echo "      grep N8N_ENCRYPTION_KEY .env"
  echo "    It decrypts every credential n8n will store, and the nightly backup"
  echo "    is encrypted with it. Lose it and the backups are unrestorable."
fi

# ── 3. start ────────────────────────────────────────────────────────────────
say "starting n8n"
$DC up -d
echo "waiting for the editor to come up..."
for i in $(seq 1 60); do
  if $DC exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; then
    echo "healthz OK after ${i}0s"; break
  fi
  sleep 10
  [ "$i" = 60 ] && { echo "TIMEOUT — check: sudo docker compose logs n8n"; exit 1; }
done

# ── 4. verify the lockdown, do not assume it ────────────────────────────────
# The 127.0.0.1 prefix in the ports mapping is one character away from publishing
# the editor on the public internet, and the failure is invisible from inside.
# Read the actual listening socket back rather than trusting the config.
say "verifying the lockdown"
LISTEN="$(sudo ss -tlnp 2>/dev/null | grep ':5678' || true)"
echo "${LISTEN:-(nothing listening on 5678 — unexpected)}"
if printf '%s' "$LISTEN" | grep -qE '0\.0\.0\.0:5678|\[::\]:5678'; then
  echo
  echo "  ⛔ FAIL: n8n is listening on ALL interfaces. The editor is on the public"
  echo "     internet and only the Lightsail firewall stands in front of it."
  echo "     Fix the ports: line in docker-compose.yml to \"127.0.0.1:5678:5678\"."
  exit 1
fi
echo "  OK: loopback only."

# ── 5. nightly backup of n8n's own workflows + credentials ──────────────────
# Nothing backs these up automatically. Same crontab discipline as the box: read
# first, verify the read worked, keep a copy, and never let a failed read cause
# the write to replace the whole crontab with a single line.
say "installing the nightly backup cron"
if [ ! -x ./backup-n8n.sh ]; then
  echo "  SKIP: backup-n8n.sh not present or not executable — copy it here and re-run"
else
  CUR="$(crontab -l 2>/dev/null || true)"
  if printf '%s' "$CUR" | grep -q 'backup-n8n\.sh'; then
    echo "  already present — not adding a second"
  else
    [ -n "$CUR" ] && printf '%s\n' "$CUR" > "$HOME/crontab.backup.$(date -u +%Y%m%dT%H%M%SZ)"
    printf '%s\n%s\n' "$CUR" "0 4 * * * cd $(pwd) && ./backup-n8n.sh >> $(pwd)/backups/backup.log 2>&1" \
      | sed '/^$/d' | crontab -
    echo "  added (04:00 daily)"
  fi
fi

# ── done ────────────────────────────────────────────────────────────────────
cat <<'NEXT'

── DONE. Remaining steps are yours, deliberately ───────────────────────

1. Open the editor over an SSH tunnel — there is no public port:

     ssh -N -L 5678:127.0.0.1:5678 -i <key.pem> ubuntu@<this-host>
     then browse to  http://localhost:5678

2. Create the owner account. Strong, unique password — only you should know it.

3. Confirm from your laptop that  http://<this-host-ip>:5678  REFUSES.
   If it answers, stop and fix the ports: mapping before creating any credential.

4. B5 — n8n's own dead-man's switch. New healthchecks.io check "n8n-alive"
   (period 10m, grace 10m), then in n8n:
     Schedule Trigger (5 min) -> HTTP Request GET <ping url> -> Activate.
   n8n cannot report its own death; only absence detects it.

Do NOT migrate the box's heartbeat workflow onto this host pointed at the
box-alive check. It would keep that check green from here while the box was
dead. The box already has its own cron heartbeat; this host gets a SEPARATE
check answering a SEPARATE question.
NEXT
