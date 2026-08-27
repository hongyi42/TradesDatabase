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
| `install-monitor-host.sh` | one-shot host setup (B2/B3), refuses to run on the agent box |
| `monitor-health.sh` + `.service`/`.timer` | this host's own health → Healthchecks (B5) |
| `backup-n8n.sh` | exports n8n's own workflows + credentials (cron this) |
| `workflows/*.json` | tracked workflow definitions — see "Workflows live in git" |
| `import-workflows.sh` | substitutes the ping URLs and imports/activates them |
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

Turn on **automatic snapshots**. Not free — $0.05/GB/month, billed on the incremental
delta rather than the 60 GB disk, so realistically well under $1/mo for this host
(https://aws.amazon.com/lightsail/pricing/). Attach a **static IP** too: a Lightsail instance's
public IP changes across a stop/start, which would silently break every SSH alias and tunnel
pointed at it. Static IPs are free while attached to a running instance.

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

## Workflows live in git

A workflow authored in the n8n UI exists in exactly one place: n8n's own database. It cannot be
reviewed in a diff, cannot be rebuilt after a host loss, and its only copy sits on the same disk as
the thing it monitors. So the definitions are tracked as JSON under `workflows/` and installed from
there.

A Healthchecks ping URL is a **write capability** — anyone holding it can mark the check up or
down — so it never goes in git. The JSON carries `__UPPER_SNAKE__` placeholders instead, and
`import-workflows.sh` substitutes them from `/etc/nemoclaw/monitor-health.env` (the same file
`monitor-health.sh` and `backup-n8n.sh` read). An unresolved placeholder aborts the import: a
workflow POSTing to the literal string `__PROBE_HEALTHCHECK_URL__` would look installed and alert
nobody.

```bash
# on the monitor host, in the directory holding docker-compose.yml
./import-workflows.sh                       # all of workflows/*.json
./import-workflows.sh external-probes.json  # just one
```

That env file is mode `0644`, not `0600`, and deliberately so: `backup-n8n.sh` reads it from
`ubuntu`'s crontab, and tightening it would make the backup's ping stop without any other symptom.
The cost is that any local account can read the ping URLs — acceptable here only because this host
has one human account and holds no tenant data.

`n8n update:workflow --active=true` writes the DB flag and prints "changes will not take effect if
n8n is running" — the script's restart is what actually arms the trigger, and it reads the active
list back afterwards rather than trusting the command's exit code.

### Reaching Supabase from the container — two traps

**IPv6.** `db.<ref>.supabase.co` has an **AAAA record only**. The monitor host has a global IPv6
address, but the Docker network does not, so the direct connection resolves to nothing *inside the
container* while working perfectly from the host shell — a difference that makes host-side testing
actively misleading. Use the **session pooler** instead (Supabase dashboard → Connect → Direct tab
→ Session pooler): IPv4, port 5432, and the username carries the project ref
(`monitor_ro.<project-ref>`) because the pooler is shared across projects and that suffix is how it
routes. Supabase sells a dedicated-IPv4 add-on that fixes the same problem for a monthly fee; the
pooler is free.

**A private CA.** Supabase's Postgres endpoints present a chain rooted at `Supabase Root 2021 CA`,
which is in no public trust store, so Node rejects a verified connection with `self-signed
certificate in certificate chain`. n8n offers an **Ignore SSL Issues** checkbox that makes this go
away by keeping the encryption and discarding the authentication — the connection would then
succeed against anyone able to answer on that address. Instead the real root is checked in at
`certs/supabase-root-2021.crt`, bind-mounted **read-only** (n8n must never be able to add a trust
anchor to itself) and pointed at by `NODE_EXTRA_CA_CERTS`.

That file was fetched over public-CA-verified HTTPS and its SHA-256 confirmed identical to the root
the server actually presented, so it is genuine rather than whatever a MITM would have offered:

```
80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
notAfter = Apr 26 2031
```

Verify the whole path from inside the container — this completes before any password is checked, so
it needs no credential:

```bash
docker compose exec -T n8n node <<'JS'
const net=require('net'),tls=require('tls');
const host='aws-1-us-east-1.pooler.supabase.com';
const s=net.connect(5432,host,()=>{const b=Buffer.alloc(8);b.writeInt32BE(8,0);b.writeInt32BE(80877103,4);s.write(b);});
s.once('data',d=>{if(d[0]!==0x53)process.exit(1);
  const t=tls.connect({socket:s,servername:host,rejectUnauthorized:true},()=>{
    console.log('authorized='+t.authorized);process.exit(0);});
  t.on('error',e=>{console.log('FAIL '+e.message);process.exit(1);});});
JS
```

`authorized=true` means verification is real. Renew before April 2031, or when Supabase rotates.

### `external-probes` — one check, N subjects

Reaching outward is the one thing the box reporters cannot do for us: they answer "is this machine
healthy", never "is the service our assistants talk to answering". This workflow probes from
outside and folds every probe into a **single** verdict, so one Healthchecks check (`external-probes`,
period 10 min, grace 10 min) covers all of them — the same argument as `box-report-ran` covering 17
checks. Healthy → ping. Any probe failing → `POST …/fail` with the reason, which travels into the
alert so a red says *what* broke.

Adding a probe = one more HTTP Request node plus a branch in the `Evaluate probes` code node. No new
check, no new alert routing.

Probe 1, the web service (`https://tradesdatabase.onrender.com/health`), reads its own status code
as a build fingerprint, because `/health` is unauthenticated and routed ahead of both the auth check
and the IP allowlist:

| code | meaning | verdict |
|---|---|---|
| `200` | current branch is live; body carries `{commit, checks.db}` | pass — and the probe has upgraded itself from *is it up* to *is it working* |
| `401` | alive, but the deployed commit predates `/health`, so auth answered first | pass (liveness only) — this is the known commit drift |
| `503` | `/health` ran and the DB round-trip failed | **fail** |
| anything else, or no answer | | **fail** |

Accepting both 200 and 401 is deliberate: it means deploying the branch does not trip a false alarm,
and the probe strengthens on its own the moment the deploy lands. Once you have seen a 200, tighten
the code node to 200-only — 401 then means auth has moved in front of `/health`, which is a
regression worth a red.

Probe 2 is the **only** thing in the estate that can answer *is it doing its job*. From outside a
worker, "zero rows processed because none arrived" and "zero rows processed because it is wedged"
are the same observation — no platform API can tell them apart, because the information is not
there. Only our own data separates them. One query, `select * from monitoring.health`, through a
role that can read that view and nothing else (`supabase/migrations/20260827120000_…`):

| limit | means |
|---|---|
| `calls_pending_oldest_s` > 15 min | Calls-worker stalled — work waiting, nothing taking it |
| `calls_processing_oldest_s` > 30 min | Calls-worker **wedged** — a worker claimed the row and never finished. The strongest signal here, because an empty inbox cannot explain it. Wide grace: transcription legitimately takes minutes |
| `calls_error_1h` > 3 | pipeline erroring |
| `calls_max_attempts` > 4 | retry storm |
| `calls_purge_backlog` > 0 | Calls-purge stopped — audio past its delete date. No threshold to tune: any non-zero value is a retention-promise breach |
| `cost_rollup_age_s` > 1 h | lifecycle-heart stopped. It runs `*/5`, but heavy sweeps self-gate to quarter-hour ticks, so ~15 min is normal and one hour is four missed ticks |
| `nudges_queued_oldest_s` > 1 h | nudge delivery stalled |
| `nudges_asked_oldest_s` > 72 h | escalation sweep stalled. Deliberately **not** mirroring `NUDGE_ESCALATE_HOURS` — a monitor that tracks a code constant breaks quietly when the constant changes |
| `l1_capture_age_s` > 48 h | L1 capture flow stopped. Wide on purpose: 24 h of silence was the very first reading we took on this pilot, so a tight limit would have paged on day one, and a monitor that cries wolf immediately gets muted. Tighten after a week of baseline |

**NULL is not zero.** An empty set (no pending calls, no captures yet) returns NULL, and the code
node treats it as "nothing to say". Comparing NULL numerically would read as `0` and turn every
quiet period into a pass on a check that never really ran.

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
