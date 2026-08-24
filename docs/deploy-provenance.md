# Deploy Provenance

**Purpose:** answer "what code is running in production, and where did it come from?" with a
one-line, verifiable answer. This closes prod-migration-checklist B2's "confirm the live commit
hash" and the system-design Tier 3 rule *"verify the live commit hash after deploying."*

> Doc-only file (repo doc carve-out): safe to commit to `main` and push directly. Keep it synced
> when the deploy source changes.

## Source of truth

- **Repository:** `https://github.com/hongyi42/TradesDatabase.git`
- **Branch Render deploys:** `main`
- **Confirmed:** 2026-08-24 — Render deploys the canonical repo on `main` (the "separate/unrecorded
  repo" concern from the 2026-08-17 research is resolved: it is this repo, `main`).

> **The repo was renamed** (2026-08-24, found on the first push of this branch): it used to live at
> `hhesecured-web/TradesDatabase` and GitHub now answers that URL with
> `This repository moved. Please use the new location: https://github.com/hongyi42/TradesDatabase.git`.
> The old URL still works **only** through GitHub's redirect. That redirect is not a durable
> address: it disappears the moment anyone creates a new repository at the old owner/name, and a
> push that follows a stale remote then either fails or lands somewhere nobody is watching — which
> is precisely the class of "we don't know where prod's code comes from" this file exists to
> prevent. Anything still holding the old URL (local clones' `origin`, **each Render service's
> connected repo**, CI configuration, deploy keys) should be repointed at the canonical URL above.

Merging to `origin/main` **does** move production. (Historical note: a local checkout was once found
160 commits behind `origin/main`; the fix is simply to work from `origin/main` — the deploy source
was never in doubt once checked. `main` is the source of truth.)

## Per-service (confirm each in Render → service → Settings)

All Render services deploy from the repo + branch above. Record auto-deploy per service; if any
differs, note it here — a service on a different branch is exactly the drift this doc exists to catch.

While confirming each service, check **which owner/name its connected repo records** — a service
still wired to `hhesecured-web/...` is running on the redirect (see the rename note above).

| Service          | Repo / branch      | Auto-deploy | Owner recorded | Notes |
|------------------|--------------------|-------------|----------------|-------|
| web              | this repo · `main` | confirm     | confirm        | central MCP/HTTP entrypoint |
| Board_Worker     | this repo · `main` | confirm     | confirm        | dispatch board worker |
| lifecycle-heart  | this repo · `main` | confirm     | confirm        | `*/5`… lifecycle cron |
| calls-worker     | this repo · `main` | confirm     | confirm        | phone-call feature |
| calls-purge      | this repo · `main` | confirm     | confirm        | phone-call purge cron |

## Verify what's actually live (not a proxy)

The web service exposes the running commit at **`GET /health`** (added 2026-08-24; reads Render's
injected `RENDER_GIT_COMMIT`):

```bash
curl -s https://<web-service-host>/health
# {"status":"ok","commit":"<sha>","checks":{"db":"ok"}}
```

- `commit` = the exact SHA running. Compare it to `git rev-parse origin/main` to confirm prod is
  current. `"unknown"` means `RENDER_GIT_COMMIT` wasn't injected (check the service's env).
- **After every deploy, read this back** — Render's "Redeploy" re-runs the *old* commit
  (system-design Tier 3); the SHA here is ground truth, the deploy button is not.
- `status: "degraded"` / HTTP 503 = the DB round-trip failed; Render's zero-downtime gate holds the
  old instance instead of cutting traffic to a broken deploy.

## At prod cutover (B2)

The fresh prod DB (`lzlgysoydhknsdvovntz`) is a config repoint, not a code-source change: services
still deploy this repo on `main`. Re-confirm the live SHA at `/health` after the cutover deploy, and
that `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` point at prod on every service + the box.
