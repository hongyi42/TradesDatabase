# Self-hosted n8n (prod-devops Phase 1)

Ready-to-deploy, hardened n8n for the Lightsail box. n8n is the **automation backbone**
(monitoring alerts, cost watchdog, backups) — and once it holds real credentials it is the
**highest-privilege system in the stack**. It has shipped multiple CVSS-10 RCEs, so hardening is a
**prerequisite**, not polish. Do not put a real production credential into n8n until every step here
is done.

## Files

| File | What |
|---|---|
| `docker-compose.yml` | n8n + Caddy, locked down (no public n8n port, TLS, prune, task runner) |
| `Caddyfile` | HTTPS reverse proxy → n8n; optional IP allowlist |
| `.env.example` | copy to `.env`, fill in host + encryption key + tz |
| `backup-n8n.sh` | exports n8n's own workflows + credentials (cron this) |
| `.gitignore` | keeps `.env` and `backups/` out of git |

## Prereqs (Phase 1 · Step 1)

On the box: `docker --version` and `docker compose version` both work; `free -h` shows ~1 GB
headroom (n8n idles ~300–500 MB, and this box also runs the agent fleet); a subdomain (e.g.
`n8n.<yourdomain>`) with a **DNS A record pointing at this box** so Caddy can get a cert.

## Pick the version (do NOT skip — this is the CVSS-10 mitigation)

`docker-compose.yml` ships `n8nio/n8n:1.NNN.N` as a placeholder. Replace it with the **current
patched release**:

1. Check https://github.com/n8n-io/n8n/releases for the latest stable tag.
2. Check n8n security advisories (https://github.com/n8n-io/n8n/security/advisories) — make sure the
   tag you pick is at or past every fixed CVE.
3. Pin that exact tag (e.g. `n8nio/n8n:1.112.3`). **Never `:latest`** — an unpinned image can pull an
   un-vetted build, and you lose the "which version am I running" answer (same disease as unknown
   prod provenance).
4. Re-check periodically; bump the pin when a security release lands.

## Deploy (Phase 1 · Steps 2–3)

```bash
# on the box, in this directory:
cp .env.example .env
openssl rand -hex 32            # paste into N8N_ENCRYPTION_KEY in .env
# edit .env: N8N_HOST=<your subdomain>, TZ=<your tz>
# edit Caddyfile: replace n8n.example.com with your subdomain
# edit docker-compose.yml: set the pinned image tag

docker compose up -d
docker compose logs -f n8n      # wait for "Editor is now accessible"
```

Then open `https://<your subdomain>` and **create the owner account** (strong, unique password).

**Verify the lockdown:**
- `https://<subdomain>` shows a valid TLS padlock.
- `http://<box-ip>:5678` is **not** reachable (n8n has no public port — only Caddy does).

## Dead-man's switch — something OUTSIDE n8n must watch n8n (Phase 1 · Step 4)

If n8n dies it can't alert you that it died. Put a heartbeat on an external service:

1. Free https://healthchecks.io account → new check "n8n-alive", period ~5 min, grace ~5 min. Copy
   its ping URL.
2. In n8n: new workflow → **Schedule Trigger** (every 5 min) → **HTTP Request** GET the ping URL →
   **Activate**.
3. Now if n8n (or the box) goes dark, the pings stop and Healthchecks alerts you. This is the
   terminating watcher — it lives off your infra and fires on silence.

## Back up n8n's own workflows + credentials (Phase 1 · Step 5)

Nothing backs up n8n's workflows/credentials automatically. Cron `backup-n8n.sh` (daily):

```bash
crontab -e
# 0 4 * * *  cd /path/to/deploy/n8n && ./backup-n8n.sh >> backups/backup.log 2>&1
```

It writes encrypted credential + workflow exports under `backups/` (gitignored). Copy that folder
off-box (S3 / a private repo) so a box loss doesn't take the workflows with it. **Also** store
`N8N_ENCRYPTION_KEY` in a password manager off-box — the exports are encrypted with it.

## Security recap (why each choice)

- **No public n8n port** — only Caddy is exposed; the editor is never directly on the internet.
- **Pinned patched image** — the CVSS-10 RCE history makes "which version" load-bearing.
- **Task runner enabled** — isolates the code/tool-execution surface the CVEs targeted.
- **Encryption key off-box + backed up** — single custody point for every stored credential.
- **Prune on** — execution data doesn't grow unbounded.
- **External dead-man's switch** — n8n can't monitor itself; a hosted heartbeat can.

## Only after all of the above

Proceed to Phase 2 (build workflows), starting with the **ops_events → Telegram notifier** — the
cheapest, highest-value one (Postgres → Telegram, no new vendor API). Use a **read-only,
tenant/backup-scoped DB role** for any workflow that touches Postgres — never the app's service-role
key.
