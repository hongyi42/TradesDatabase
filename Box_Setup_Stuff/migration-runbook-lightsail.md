# Migration Runbook — Brev `nemoclaw-box` → AWS Lightsail

**Why we're moving (decided 2026-07-03):** Brev instances routinely get stuck in "starting"
after stop/start — this is documented Brev behavior (restart is a fresh capacity request, and
the [official remedy for a stuck instance](https://docs.nvidia.com/brev/troubleshooting/instances-gpus/instance-stuck-in-waiting-state)
is delete-and-recreate). Our box is CPU-only (inference is NVIDIA cloud), so we get nothing
from Brev's GPU brokering and pay all its instability. Lightsail gives reliable stop/start,
one-click **snapshots** (restore a fully configured box in minutes), and a static IP for
$84/mo (4 vCPU / 16 GB / 320 GB — pricing verified 2026-07-03,
[aws.amazon.com/lightsail/pricing](https://aws.amazon.com/lightsail/pricing/)).

**Companion automation** (this folder): `bootstrap-box.sh` (staged setup phases) and
`apply-bakein.py` (the §6 source edits). `doorman-nemoclaw-setup-guide.md` remains the
authority for *why*; this runbook is the *order of operations* for the migration.

```
BEFORE                                 AFTER
──────                                 ─────
Brev nemoclaw-box  ←— dice-roll        Lightsail trades-box-1 ←— boring stop/start
  (stuck "starting", no snapshot,        (snapshot = golden image, static IP,
   delete = rebuild by hand)              rebuild = restore, ~2 min)
        │                                     │
        ▼                                     ▼
  doorman + sandboxes ——— badge ———→   Render MCP server ———→ Supabase
  (identical on both — nothing about the doorman architecture changes)
```

**Who does what:** 🖥 = your laptop · 📦 = the new box (over SSH) · 🗄 = server-side
(this repo, TEST-project env — where `scripts/assign-host.mjs` runs).

---

## Phase 0 — have in hand before starting

- [ ] AWS account with billing set up (Lightsail lives at [lightsail.aws.amazon.com](https://lightsail.aws.amazon.com))
- [ ] `GATEWAY_IDENTITY_SECRET` — from the password manager; **must match Render**, never generate a new one
- [ ] `NVIDIA_API_KEY` (`nvapi-…`)
- [ ] A **scratch Telegram bot token** — make a throwaway bot via @BotFather. The build is
      verified with this bot so the production bot keeps working on the old box.
      **Never run one bot token on two boxes** — both poll Telegram and conflict; the live bot goes deaf.
- [ ] This `Box_Setup_Stuff/` folder (it carries the scripts the bootstrap installs)
- [ ] ⚠ Standing hazard, unchanged by the migration: **no `npm test` runs** — the suite
      truncates the TEST-project roster the badge-pull (old box today, new box tomorrow)
      reads every 5 min (real outage 2026-07-03).

## Phase 1 — provision the instance  🖥

1. Lightsail console → **Create instance** → Linux/Unix → **OS Only → Ubuntu 22.04 LTS**.
2. Size: the **$84/mo bundle (4 vCPU / 16 GB RAM / 320 GB SSD)**. 16 GB is a hard floor —
   the sandbox image push OOMs below it (guide §1).
3. SSH key: "Create new" → download the `.pem` (or upload your own public key).
4. Name it `trades-box-1`, create.
5. **Networking tab** → Create static IP → attach it to the instance (free while attached).
6. **Firewall** (same tab): delete the default **HTTP :80** rule. Only **SSH :22** should
   remain — nothing dials into this box; the doorman is host-internal and agents dial out.
7. Laptop SSH config — add to `~/.ssh/config`:
   ```
   Host tradesbox
     HostName <the-static-IP>
     User ubuntu
     IdentityFile ~/.ssh/<downloaded-key>.pem
   ```
   Test: `ssh tradesbox` → Ubuntu prompt. (Fallback anytime: the orange **Connect** button
   in the console gives a browser terminal.)
8. Teammate access (anytime): they run `ssh-keygen -t ed25519`, send you the **.pub** file;
   you append its one line to `~/.ssh/authorized_keys` on the box. Revoke = delete the line.

## Phase 2 — register the new host  🗄

```bash
npm run build   # assign-host.mjs imports from dist/
node -r dotenv/config scripts/assign-host.mjs create-host name=trades-box-1
```
It prints the host's **pull token ONCE** → store it in the password manager now. Losing it
means re-creating the host. (The script refuses to run against anything but the TEST project.)

## Phase 3 — bootstrap the box  📦

```bash
# from the laptop:
scp -r Box_Setup_Stuff tradesbox:~/

# on the box (ssh tradesbox), in order:
cd ~/Box_Setup_Stuff
sudo ./bootstrap-box.sh prep                 # docker, ufw, deps
exit && ssh tradesbox                        # re-login: docker group takes effect
export NVIDIA_API_KEY=<nvapi-...>
cd ~/Box_Setup_Stuff
./bootstrap-box.sh nemoclaw                  # installs NemoClaw (Ctrl-C if it auto-launches onboard)
./bootstrap-box.sh bakein                    # §6 edits BEFORE first onboard → image builds pre-wired
./bootstrap-box.sh onboard-help              # cheat sheet, then:
nemoclaw onboard                             # interactive — use the SCRATCH bot token
sudo GATEWAY_IDENTITY_SECRET=... ./bootstrap-box.sh doorman
sudo HOST_PULL_TOKEN=...        ./bootstrap-box.sh badgepull   # token from Phase 2
./bootstrap-box.sh wire <AGENT>              # egress policy + badge-install instructions
sudo ./bootstrap-box.sh boot <AGENT>
sudo ./bootstrap-box.sh verify               # services active, 401/403 gates
```
If `bakein` aborts on an anchor (upstream NemoClaw drifted), apply that one edit by hand from
guide §6 and re-run — already-applied edits skip.

## Phase 4 — badge + end-to-end verify (still isolated from production)  🗄📦

1. 🗄 Point the **test row** at the new box and force a fresh badge:
   ```bash
   node -r dotenv/config scripts/assign-host.mjs assign ref=tech-jane host=trades-box-1 sandbox=<AGENT>
   node -r dotenv/config scripts/assign-host.mjs rotate-badge ref=tech-jane
   ```
   (The moment `assign` runs, the OLD box's next pull drops tech-jane's badge — that ref
   stops working there. Fine: it's the test row.)
2. 📦 Within 5 min (or `sudo systemctl start badge-pull.service` after pre-warming Render)
   the badge lands in `/root/pending-badges.jsonl`. Install it per the `wire` phase's printed
   §5b steps (integrity-check the fingerprint, `openshell provider update`, delete the line).
3. 📦 Gate A — `curl` the doorman with the badge (guide §3f): **HTTP 200 + 8 tools**.
4. 📱 Gate B — message the **scratch** bot "list recent captures" → real trades-spine data;
   OCSF log on the box shows `ALLOWED … → host.openshell.internal:3001`.
5. 📦 Gate C — **the reason we migrated**: `sudo reboot`, wait ~2 min, confirm doorman +
   gateway + sandbox + timer all return (`sudo ./bootstrap-box.sh verify`, then one more bot
   message). Then the real test Brev kept failing: **stop and start the instance from the
   Lightsail console** and verify everything again.

## Phase 5 — snapshot the golden image  🖥

Lightsail console → instance → **Snapshots** → Create. This is the "never rebuild by hand
again" moment: restore ≈ 2 minutes to a configured box.

- ⚠ The snapshot **contains secrets** (doorman.env, pull token) — it's as sensitive as the box.
- ⚠ **Never run two instances from one snapshot simultaneously** — same host identity, same
  pull token, same bot tokens = conflicts everywhere. Restore only as a *replacement*, then
  re-attach the static IP to the new instance.
- Re-snapshot after meaningful config changes (new agents, rotated secrets).

## Phase 6 — cutover, one person/sandbox at a time  📦🗄📱

For each real person currently served by the old box:

1. 📦(old, `brev shell nemoclaw-box`) `docker stop <their-sandbox-CID>` — frees their real
   Telegram bot token.
2. 📦(new) If they need their own sandbox: `NEMOCLAW_GATEWAY_PORT=<port> nemoclaw onboard`
   (scratch token again), then `./bootstrap-box.sh wire <their-AGENT>`.
   Swap in their **real** bot token (safe — the 3b self-heal is baked into this box's image):
   ```bash
   openshell provider update <AGENT>-telegram-bridge --credential TELEGRAM_BOT_TOKEN=<real token>
   ```
3. 🗄 `assign ref=<person> host=trades-box-1 sandbox=<their-AGENT>` then
   `rotate-badge ref=<person>` → 📦(new) install the freshly minted badge (as Phase 4.2).
4. 📱 Their real bot answers a tool question with live data → this person is migrated.

## Phase 7 — retire the Brev box

**DECIDED 2026-07-04: retirement is immediate — Lightsail (`trades-box-1`) is the home from
now on; no soak period.** Remaining operational checklist (each is quick):

1. Server-side roster: any ref still assigned to host `nemoclaw-box` (e.g. `pair-drill`,
   `manager-sam`) either gets re-`assign`ed to `trades-box-1` + `rotate-badge` (badge mints
   on the new box's next pull — install per §5b, mind the versioning trap) or stays parked
   (an inactive/testing ref pointing at a dead host is harmless; its badge simply never
   resolves anywhere).
2. If the old box's sandbox still holds the production Telegram bot token, swap it onto the
   new box's sandbox per Phase 6 (stop the old sandbox container first — two pollers on one
   token conflict).
3. `brev stop nemoclaw-box`, then `brev delete nemoclaw-box`. Nothing on it is unique —
   config is in this folder + the golden snapshot; badges/roster live server-side. The
   server's `nemoclaw-box` hosts-registry row can stay (its pull token simply goes unused);
   there is no delete-host command and none is needed.

## Phase 8 — reattach the Brev workflow (chosen: yes)  📦

You and your teammate keep `brev shell` by registering the *Lightsail* box into Brev
([Registered Compute docs](https://docs.nvidia.com/brev/guides/registered-compute/managing-registered-compute)):
install the brev CLI on the box, `brev register`, then `brev grant-ssh` **on the box** per
teammate (same on-box quirk as before). This installs a NetBird VPN agent; plain SSH from
Phase 1 stays underneath as the always-working fallback — never let Brev become the only
door. Undo anytime with `brev deregister` (documented full cleanup).

---

## What the build actually hit (2026-07-04) — read before the next box

1. **Upstream drift, handled:** NVIDIA rewrote the config generator in TypeScript and
   restructured the placeholder heredoc. `apply-bakein.py` now auto-detects old/new layouts.
   The bake-in worked first-try on the new layout (fresh onboard came up with toolSearch off
   + trades-spine baked).
2. **The versioning trap is alive upstream and bit us again:** the badge `provider update`
   bumped the provider generation; the Telegram placeholder was frozen versioned; the
   post-install `pkill` restart killed the bridge. In the NEW architecture the boot-time
   self-heal never runs (see 3), so the §5b warning stands: after any provider credential
   write, avoid agent restarts until you've confirmed placeholder forms, and expect a
   rebuild (or revive + managed restart) to re-freeze cleanly.
3. **Agents do NOT survive container restarts/reboots in new-generation NemoClaw** —
   `SUPERVISOR_UNAVAILABLE` from every CLI path; only create/rebuild runs the startup
   transaction. Fixed with `nemoclaw-agent-revive.sh` + per-agent systemd unit
   (`bootstrap-box.sh boot <AGENT>`); rebuilds are NOT needed for restarts. Verified:
   reboot + console stop/start both recover hands-off (guide §7 note).
4. **Render `ANTHROPIC_API_KEY` went invalid** (likely rotated in the 2026-07-03 credential
   sweep and never updated on Render): `record_field_note`, `brief_customer`,
   `answer_customer_question` fail with "invalid API key" until it's replaced. Reads
   unaffected. This is server-side — both boxes see it equally.

## Standing gotchas carried over (unchanged by the migration)

- `export NVIDIA_API_KEY=…` in **every** shell that runs onboard/rebuild.
- Render free-tier cold start ~32s > 30s timeouts — pre-warm before first pulls/tool calls.
- `nemoclaw <AGENT> rebuild` restores only standard presets → re-run
  `./bootstrap-box.sh wire <AGENT>` after every rebuild.
- Badge plaintext exists only in `/root/pending-badges.jsonl` → provider store. Never in
  chat, docs, or shell history you'd paste elsewhere.
- No `npm test` until the suite's roster-truncation cleanup is fixed (see Phase 0).
