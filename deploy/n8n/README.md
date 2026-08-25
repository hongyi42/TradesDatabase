# Self-hosted n8n on a dedicated host (prod-devops Phase 1b)

n8n is the fleet's **central monitor**. This bundle moves it off the agent box onto its own small
instance, so it can witness that box dying instead of dying with it.

It stays **one** n8n no matter how many boxes you add. Boxes report themselves outbound
(`Box_Setup_Stuff/box-report.sh`); n8n pulls everything that has an API. Box #4 costs a systemd
timer, not a fourth n8n.

## Licence

n8n is under the **Sustainable Use License v1.0** — fair-code, not OSI open source. Running it for
your own internal business purposes is explicitly permitted and free
(https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md). You are not exempt from the
licence; it grants exactly this use. Two boundaries that could matter later given the product is
customer-facing: you may not provide paid hosting or services to third parties with it, and files
marked `.ee.` or under `.ee/` need a separate Enterprise Licence. Stay on Community features.

## Files

| File | What |
|---|---|
| `docker-compose.yml` | n8n only — loopback bind, pinned tag, prune, task runner. Read its header |
| `.env.example` | copy to `.env`, fill in encryption key + tz |
| `backup-n8n.sh` | exports n8n's own workflows + credentials (cron this) |
| `.gitignore` | keeps `.env` and `backups/` out of git |

There is deliberately no `Caddyfile`. See "Why no TLS" below.

---

## Phase A — on the AGENT BOX, before anything moves

**A1 is blocking. Do not skip it and do not reorder it.**

### A1 · Give the box its own heartbeat

Right now the box-alive signal *is* the n8n container on the box. Move n8n and the box goes dark
with nothing to say so. Replace it first, while both are still running:

```bash
# on the agent box
crontab -e
*/5 * * * * curl -fsS -m 10 https://hc-ping.com/<box-alive-uuid> >/dev/null 2>&1
```

Deliberately a bare `curl` in cron and **not** part of `box-report.sh`: a dead-man's switch has to
have nothing in it that can break. A bug in the reporter must never be able to masquerade as the
box being dead.

Watch Healthchecks for **20+ minutes** and confirm pings keep arriving with n8n's workflow still
running. Both are pinging the same check during this window, which is fine — you are proving cron
alone is sufficient before you remove the other one.

Side benefit independent of the move: today a dead n8n *container* reads as a dead *box*. Cron
separates them.

### A2 · Install the box reporter

From `Box_Setup_Stuff/`:

```bash
sudo install -m 0755 box-report.sh /usr/local/sbin/box-report.sh
sudo install -m 0644 box-report.service box-report.timer /etc/systemd/system/

# optional overrides + the reporter's own liveness check
sudo mkdir -p /etc/nemoclaw
sudo tee /etc/nemoclaw/box-report.env >/dev/null <<'EOF'
DISK_PCT_MAX=85
MEM_AVAIL_MIN_MB=400
REPORTER_HEALTHCHECK_URL=
EOF
sudo chmod 600 /etc/nemoclaw/box-report.env

sudo systemctl daemon-reload
sudo systemctl start box-report.service     # run once, read the output
sudo journalctl -u box-report.service -n 40 --no-pager
```

Every line should read `box:<something>=ok`. Investigate anything reporting `down` **before**
enabling the timer — a first run that opens six incidents will send six Telegram messages.

```bash
sudo systemctl enable --now box-report.timer
```

`REPORTER_HEALTHCHECK_URL` is a **third** Healthchecks check (period 5 min, grace 15 min). It
catches the reporter itself dying — silence from a stateless reporter otherwise looks exactly like
health, because no report means no incident opens.

Three checks per box, each answering a different question:

| check | answers |
|---|---|
| `box-alive` | is the machine powered and on the network |
| `box-report-ran` | is the reporter still sweeping |
| `n8n-alive` | is the monitor itself running |

---

## Phase B — the new n8n host

### B1 · Provision

AWS Lightsail, **2 GB / 2 vCPU, Ubuntu 24.04**, in a **different region from the agent box**
(box is us-west-2 → put this in us-east-1). Different region is a different physical failure
domain; same account keeps one bill and one set of tooling.

A whole-AWS outage would take both. That is already covered: Healthchecks.io sits off all our
infrastructure and alarms on the silence.

Firewall: **port 22 only.** Delete every other rule Lightsail adds by default, including 80/443.

Turn on **automatic snapshots** (free, one toggle).

### B2 · Docker

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker ubuntu && newgrp docker
```

Install the **compose plugin** — the agent box lacks it, which is why n8n runs there under a raw
`docker run`. This host gets compose, so this bundle is used as written.

### B3 · Deploy

```bash
cd deploy/n8n
cp .env.example .env
openssl rand -hex 32          # paste into N8N_ENCRYPTION_KEY, then save it to a password manager
docker compose up -d
docker compose logs -f n8n    # wait for "Editor is now accessible"
```

Generate a **fresh** encryption key rather than copying the box's. The only workflow moving is a
bare URL GET with no stored credential, so there is nothing to decrypt on the other side, and a
fresh key rotates it for free.

### B4 · Reach the editor

```bash
# from your laptop
ssh -N -L 5678:127.0.0.1:5678 ubuntu@<n8n-host-ip>
# then open http://localhost:5678
```

Create the owner account with a strong unique password.

**Verify the lockdown** — `http://<n8n-host-ip>:5678` from anywhere must **refuse**. If it answers,
`ports:` lost its `127.0.0.1:` prefix and the editor is on the public internet.

#### Why no TLS

The previous revision of this bundle put Caddy on 80/443 with Let's Encrypt. Right shape for a
service with real users; wrong shape for this one. n8n holds Render, Supabase, Fireworks,
Anthropic, AWS and Telegram credentials behind one key, and its CVE history is dominated by
editor-reachable sandbox escapes ending in host RCE — five advisories on 2026-08-19, four High. The
editor has one user. A public endpoint buys convenience and pays in permanent internet exposure of
the highest-privilege system in the stack.

**Consequence, stated on purpose:** n8n can make outbound calls but cannot receive webhooks. Every
workflow is a Schedule trigger. If an inbound webhook is ever genuinely needed, that is a new
decision with a new threat model — do not quietly open a port to get it.

### B5 · n8n's own dead-man's switch

n8n cannot report its own death. New Healthchecks check `n8n-alive` (period 10 min, grace 10 min),
then in n8n: **Schedule Trigger** every 5 min → **HTTP Request** GET the ping URL → **Activate**.

### B6 · Back up n8n itself

Nothing backs up n8n's workflows or credentials automatically.

```bash
crontab -e
0 4 * * *  cd /home/ubuntu/deploy/n8n && ./backup-n8n.sh >> backups/backup.log 2>&1
```

The credential export is encrypted with `N8N_ENCRYPTION_KEY`, so the key must live off-host or the
backups are unrestorable. Copy `backups/` off-host too — a backup that only exists on the machine
it protects is a staging area, not a backup.

---

## Phase C — decommission n8n on the agent box

Only after Phase B is verified.

1. In the **box's** n8n, deactivate workflow `deadmanhb0000001` (the old heartbeat).
2. Confirm `box-alive` on Healthchecks **keeps receiving pings** — that is now the A1 cron.
3. Then stop and remove it:
   ```bash
   docker stop n8n && docker rm n8n
   # keep the volume until you are certain nothing else is needed:
   #   docker volume rm n8n_data
   ```
4. Keep `~/n8n/backup-n8n.sh` and its cron until the volume is deleted.

Do **not** delete the box's n8n volume the same day. If something was in there that nobody
remembered, that is when you find out.

---

## The portability rule

**Never let an n8n workflow depend on being on a box.**

| goes in n8n | goes in `box-report.sh` |
|---|---|
| SQL against Supabase (read-only role — never `service_role`) | `docker ps` |
| HTTP to vendor APIs (Fireworks, Anthropic, SignalWire, AssemblyAI) | `df -h` |
| `GET /health` on Render services | `systemctl show` |
| `POST /control/ops` | local process checks |

n8n is a **producer** into `/control/ops`, exactly like the boxes — not the alert sink. One incident
model, one dedup, one Telegram group, and n8n going down does not take alerting with it.

Build order for the first workflows:

1. **worker staleness** — Supabase only, no dependencies
2. **backlog value check** — `call_ingest` audio-delete backlog climbing
3. **cost collector** — Fireworks + Anthropic; from scratch, the DeepInfra puller was deleted
   2026-08-19 (`49d9974`), so the inference cost line currently reads $0 while real money is spent
4. **Render `/health` probe** — blocked until `/health` is merged, the `Yu-C1` fork is synced, and
   the two Auto-Deploy-OFF services are hand-deployed

## Version bumps

`docker-compose.yml` pins `n8nio/n8n:2.35.7` — current **stable** as of 2026-08-21. Never `:latest`
(you lose the "which version am I running" answer) and never a `2.36.x` tag (those are prereleases
on the beta channel).

Before bumping: check https://github.com/n8n-io/n8n/releases for the latest non-prerelease tag and
https://github.com/n8n-io/n8n/security/advisories to confirm it is at or past every fixed CVE. Bump
whenever a security release lands.
