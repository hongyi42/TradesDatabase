---
name: data-security
description: The gate for any change touching data access, identity/auth, secrets, tenant scoping, or customer PII — tenant isolation, the doorman/HMAC identity model, secret custody, and privacy/disclosure obligations. Consult before writing or editing any DB accessor, auth/identity check, badge/credential handling, or anything that reads or logs customer data. Fires on every data or auth edit; a miss here (cross-tenant leak, leaked secret, PII into append-only L1) is often irreversible.
---

# Data security

The rules that must hold on **every** change that touches data, identity, secrets, or PII — because
these are the mistakes that are *irreversible* (L1 has no delete path; a cross-tenant leak can't be
un-leaked; a leaked badge means rotating every badge). This skill is the trigger + the load-bearing
rules; it does **not** restate what other sources own — it points to them:

- **Append-only L1, classify-before-write, keys-only redaction, the disclosure carve-outs** → already
  in `CLAUDE.md` (always loaded). Don't duplicate; obey it.
- **Fail-closed guards, secrets-as-fingerprints, DB-constraint invariants** → `system-design` Tiers
  1/2/6. This skill is the data-specific application of those.
- **Full detail** → `docs/prod-migration-checklist.md` B1/Tier 2/Tier 3 (tenant isolation + secrets),
  `docs/doorman-runbook.md` (identity model), `docs/nemoclaw-tech-agent.md` §7 (sessions, scopes,
  custody).

---

## 1. Tenant isolation (the #1 risk — `prod-migration-checklist.md` B1)

- **Every read/write is tenant-scoped.** Today isolation rests entirely on a hand-written
  `.eq('tenant_id', …)` in each accessor — RLS is off and the app uses `service_role` (bypasses RLS).
  One missed filter = a silent cross-tenant leak. Route every query through the typed `src/db/` layer;
  never hand-write a Supabase query elsewhere (CLAUDE.md).
- **Identity comes from the verified header, never a tool argument.** `(tenant, technician)` is
  resolved from the HMAC-signed `x-tenant-id`/`x-technician-ref`/`x-identity-signature`
  (`resolveIdentityFromHeaders`), not from anything the caller can set. A forged `connectedAccountId`
  or `technicianRef` in tool args must be ignored.
- **PostgREST embeds don't inherit tenancy** — a nested/related read can cross tenants even when the
  top-level filter is right; scope the embedded resource too.
- **When you add a table or accessor:** add its tenant filter *and* a case to the 2-tenant leak test
  (checklist Tier 2). Forgetting the filter must fail a test, not reach prod.

## 2. Identity & auth (the doorman model — `doorman-runbook.md`)

- **No secret or signed header ever lives in a sandbox** — a sandbox holds only its own revocable
  **badge** (a random token, useless if stolen, accepted only by the doorman). The
  `GATEWAY_IDENTITY_SECRET` and the badge table live only on the host.
- **Fail closed.** Unknown / malformed / revoked badge → reject at the doorman; the request must never
  reach Render. Default-deny anything you're unsure about.
- **The badge file is keyed by sha256 fingerprint**, re-read per request (revocation is instant). A
  badge's tier comes from an **active** roster row matching its ref — a manager badge without an
  active manager roster row silently acts as a plain technician.

## 3. Secret custody

- **Fingerprints only — never plaintext.** Never paste a badge/key in chat, docs, or commits (a
  2026-07-03 plaintext leak forced rotating every badge). Store sha256, not values.
- **The Composio master API key never enters a sandbox** — the SDK's session auth header *is* the
  master key (act-as-anyone). Sandbox access is doorman-relayed with per-person session pinning.
- **Credentials inject at container launch only** — any badge/token write needs a container restart
  to take effect (a badge in the store but absent from the process env is silently dead; it killed a
  real spine MCP for 4 days).
- **Least privilege at the action layer:** managed Gmail OAuth is one broad token (read+send
  together), so the boundary is the per-person Composio **session** (execution-enforced, HTTP 400
  code `4310`) + the per-tier gateway allowlist — not a scope split (`nemoclaw-tech-agent.md` §7).

## 4. Privacy & disclosure (customer PII)

- **Classify before the L1 insert, always** (CLAUDE.md) — `raw_captures` is undeletable, so a
  misrouted personal email is retained forever. The two recorded carve-outs (pending-verification
  inbound; classifier-free *outbound*) are in CLAUDE.md — apply them exactly, don't invent new ones.
- **Keys-only redaction** on outbound/agent-action captures — argument key names, never values.
- **Disclosure is an obligation, not optional:** managers/technicians must be told "emails sent via
  the assistant are logged." Surface it; don't bury it.
- **Name the trust boundaries in any privacy summary:** Composio stores a full-mailbox *read* token
  (Gmail read scope is all-or-nothing) plus profile/contacts scopes — a customer-data-handling
  reviewer needs to know real mail transits Composio's storage.

## 5. Before you ship a data/auth change — quick gate

1. Every new query tenant-scoped (incl. embeds) + covered by the leak test?
2. Identity read from the verified header, not a tool arg?
3. No secret/signed-header added to a sandbox path? Fingerprints, not plaintext, in any log/doc?
4. Any new PII read/logged → classify-before-L1, keys-only, disclosure covered?
5. Guard fails **closed** (unsure → deny)? Encoded as a DB constraint where it must be structural
   (`system-design` Tier 2)?

---

*Sources (verify against code, don't assert from memory): `CLAUDE.md`;
`docs/prod-migration-checklist.md` B1 / Tier 2 / Tier 3; `docs/doorman-runbook.md`;
`docs/nemoclaw-tech-agent.md` §7; `docs/engineering-memory.md` §1/§2/§5. Companion skill:
`system-design` (fail-closed guards, DB-constraint invariants, secrets fingerprints).*
