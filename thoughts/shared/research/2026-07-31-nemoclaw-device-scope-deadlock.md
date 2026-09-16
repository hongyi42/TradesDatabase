# NemoClaw: agent gateway tools are permanently blocked by an unresolvable device-scope approval

**Filed:** 2026-07-31 · **Reporter:** TradesDatabase pilot (trades-box-1, AWS Lightsail)
**nemoclaw** v0.0.73 · **OpenClaw** 2026.5.27 (27ae826) · 6 sandboxes, Ubuntu/Docker

## Summary

Every OpenClaw tool that routes through `callGatewayTool` — `cron`, `nodes`, `gateway`, `wake` —
fails for the in-sandbox agent with:

```
gateway closed (1008): pairing required: device is not approved yet
```

`nemoclaw <s> doctor` detects this correctly and names its own remedy:

```
[fail] Tool-call device scope: 1 pending allowlisted tool-scope upgrade(s) blocking OpenClaw
       tool calls; the in-sandbox auto-pair watcher is not running
       hint: run `nemoclaw <s> doctor --fix` to approve pending dashboard/CLI tool-scope upgrades
```

**`doctor --fix` cannot fix it.** It deadlocks (issue 1), and even if it did run, its allowlist
cannot grant the scope cron actually needs (issue 2). On our box this meant **no sandbox had ever
had an approved device and no scheduled job had ever run** — across 6 sandboxes and ~25 days.

| sandbox | `pairing required` in gateway log | `devices/paired.json` | cron jobs stored |
|---|---|---|---|
| s2 | 22,271 | absent | 0 |
| s3 | 7,241 | absent | – |
| s5 | 6,518 | absent | – |
| s6 | 6,203 | absent | – |
| s7 | 6,145 | absent | – |
| s8 | 6,495 | absent | – |

## Issue 1 — the recovery pass deadlocks and exits silently

`src/lib/actions/sandbox/auto-pair-approval.ts` builds an in-sandbox script whose first action is:

```python
proc = subprocess.run([OPENCLAW, 'devices', 'list', '--json'],
                      capture_output=True, text=True, timeout=2)
...
if proc.returncode != 0 or not proc.stdout.strip():
    sys.exit(0)
```

`openclaw devices list` is **gateway-pinned** — it dials `OPENCLAW_GATEWAY_URL`, which
`scripts/nemoclaw-start.sh:473` sets to the sandbox bridge address:

```sh
export OPENCLAW_GATEWAY_URL="ws://${_GATEWAY_WS_HOST}:${_DASHBOARD_PORT}"   # ws://10.200.0.2:18789
```

That connection is refused for exactly the reason the pass exists to resolve, so `returncode != 0`
and the pass exits **0** without listing, approving, or reporting anything. `doctor --fix` prints
no error and changes no state.

**The recovery requires the approval it is supposed to grant.**

**The in-sandbox auto-pair watcher has the identical defect** (`scripts/nemoclaw-start.sh`), which
is why restarting the container does not help:

```python
rc, out, err = run(OPENCLAW, 'devices', 'list', '--json')      # gateway-pinned
if rc != 0:
    continue                                                   # silent, forever
...
rc, out, err = run(OPENCLAW, 'devices', 'approve', request_id,
                   '--json', strip_gateway_env=True)           # ← stripped HERE, but not above
```

The `approve` call already knows it must strip the gateway env to reach the local pairing
fallback; the `list` call two lines earlier does not. So on an unpaired sandbox the watcher starts,
logs `[auto-pair] watcher started`, and then loops for its full 8h deadline without ever listing a
request. Verified: restarted a cold sandbox (s6), watcher came up, an allowlisted
`cli`/`operator.pairing` request sat pending, and after 15+ seconds of 1s-cadence fast polling the
watcher log still contained exactly one line and no `paired.json` was created.

Suggested fix: pass `strip_gateway_env=True` to the `devices list` call in **both** the watcher and
`auto-pair-approval.ts`, and surface a diagnostic instead of `continue`/`sys.exit(0)` when listing
fails. As written, a sandbox that misses pairing during its very first window can never be paired
by any supported path.

## Issue 2 — the allowlist cannot grant the scope cron requires

`scripts/lib/openclaw_device_approval_policy.py`:

```python
ALLOWED_CLIENTS = {"openclaw-control-ui"}
ALLOWED_MODES   = {"webchat", "cli"}
ALLOWED_SCOPES  = {"operator.pairing", "operator.read", "operator.write"}
```

But OpenClaw classifies cron **mutations** as `operator.admin`, not `operator.write`
(`dist/core-descriptors-*.js`; 189 classified methods total):

| scope | count | cron methods in this scope |
|---|---|---|
| `operator.read` | 63 | `cron.get`, `cron.list`, `cron.runs`, `cron.status` |
| `operator.write` | 49 | — none — |
| **`operator.admin`** | **47** | **`cron.add`, `cron.update`, `cron.remove`, `cron.run`** |
| `operator.pairing` | 13 | — |
| `operator.approvals` | 9 | — |

So an agent restricted to the allowlist can *read* cron state but can never *create a job*. Even a
fully working auto-approver cannot enable scheduling. We confirmed this empirically: with
`['operator.pairing','operator.read']` approved, `cron status` succeeds and `cron add` is refused.

This is uncomfortable, because `operator.admin` is not "admin methods only" —
`authorizeOperatorScopesForMethod` treats it as a **universal allow**:

```js
if (scopes.includes("operator.admin")) return { allowed: true };
```

It short-circuits authorization for all 189 methods, including `config.set`/`config.patch`,
`agents.create`/`delete`, `channels.logout`, `chat.inject`, `exec.approvals.set`, and
`gateway.restart.request`. **Granting an agent the ability to schedule a reminder currently
requires granting it everything.** That looks like the real design bug: cron mutation should be
`operator.write`, or there should be a narrower `operator.cron` scope.

## Issue 3 — `gateway.port` drift breaks the documented local fallback

`auto-pair-approval.ts` documents a workaround for an OpenClaw 2026.5.x scope-upgrade issue: strip
`OPENCLAW_GATEWAY_URL/PORT/TOKEN` so `devices approve` uses OpenClaw's local pairing fallback.
That fallback dials loopback on `openclaw.json` → `gateway.port`. On our sandboxes that value had
drifted from the port the gateway actually listens on (`OPENCLAW_GATEWAY_PORT`):

| sandbox | `openclaw.json` `gateway.port` | actually listening |
|---|---|---|
| s2 | 18790 | **18789** |
| s7 | 18793 | **18789** |

so the fallback dialed a dead port and failed with `1006 abnormal closure`. Correcting
`gateway.port` to 18789 (and `controlUi.allowedOrigins` to match) is necessary but **not
sufficient** — it removes one failure mode, and on an already-part-paired sandbox it let
`devices approve` complete, but on a cold sandbox the deadlock in issue 5 still applies.
OpenClaw's own tool-level validator expects 18789 (*"Allowed: ws(s) loopback on port 18789"*),
so the config value is the outlier either way.

## Issue 4 — the agent's own client is outside the allowlist by design

The agent's connection identifies as:

```json
{ "clientId": "gateway-client", "clientMode": "backend", "displayName": "agent",
  "role": "operator", "remoteIp": "10.200.0.1" }
```

`gateway-client` ∉ `ALLOWED_CLIENTS`, `backend` ∉ `ALLOWED_MODES`. Per the source comment,
*"Unknown clients are ignored, never approved."* So even a healthy watcher never approves the
client the product's own agent must use.

This is survivable only because approval is keyed by **deviceId**, and the CLI and the agent share
`/sandbox/.openclaw/identity/device.json` — approving a `cli`-mode request grants the scope to the
device, which the agent then inherits. That is an accident, not a mechanism.

## Why loopback cannot be the answer (correction)

An earlier draft of this report suggested pointing `OPENCLAW_GATEWAY_URL` at loopback so OpenClaw's
shared-secret loopback waiver (`isSharedSecretLoopbackLocalEquivalent`) would apply. **That is
wrong, and the bridge address is deliberate.** `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`:

> The L7 proxy intercepts traffic from the enforced process tree even on the sandbox's own
> interfaces, and **loopback destinations are always-blocked regardless of policy** — so the dial
> must target the sandbox's eth0 address (the gateway listens on 0.0.0.0; nemoclaw-start.sh derives
> the URL host accordingly).

So for the enforced process tree the loopback waiver can *never* apply, and **device pairing is
mandatory by design in this architecture**. That makes the auto-approval path the only way a
sandbox's own device can ever be approved — which is precisely what is broken.

Observed consequence: a raw TCP connect to `127.0.0.1:18789` succeeds (the gateway binds 0.0.0.0),
but the WebSocket is blocked by the L7 proxy, surfacing as `Direct scope access failed` before the
CLI drops to its local fallback.

## Issue 5 — on a cold sandbox the deadlock is total: the repair tool consumes the thing it repairs

`nemoclaw <s> exec` is itself a Gateway client. On an unpaired sandbox **every exec call mints a new
pending device request and replaces the previous one**, so any "read the pending id, then approve
it" sequence approves an id the gateway has already superseded:

```
approving 8225637d…  → pairing required … (requestId: 446b7afb…)
approving 446b7afb…  → pairing required … (requestId: 64cbca26…)
approving 64cbca26…  → pairing required … (requestId: 1aa8a022…)
```

Six consecutive attempts, never converging; `devices/paired.json` was never created. Confirmed on a
cold sandbox (s3) while an already-half-paired sandbox (s2) completed fine — the difference is
whether the device was paired during the startup watcher's window.

Practical consequence: **once the in-sandbox auto-pair watcher's window has expired, a sandbox that
was never paired cannot be repaired from the CLI at all.** Not by `doctor --fix` (issue 1), not by
`devices approve` (this issue), and not by loopback (above). On our box that is 25-day-old
sandboxes with no `paired.json`, so every gateway-backed agent tool has been dead since creation.

## The only remaining repair for a cold sandbox: seed both halves of the token pair

Established by reading `dist/device-pairing-3ziNdlg5.js` on the box (OpenClaw 2026.5.27).
A paired device is authenticated by **plain token comparison** — there is no signature path:

```js
const entry = device.tokens?.[role];
if (!entry)                                       return { ok:false, reason:"token-missing" };
if (entry.revokedAtMs)                            return { ok:false, reason:"token-revoked" };
if (!verifyPairingToken(params.token, entry.token)) return { ok:false, reason:"token-mismatch" };
```

`verifyPairingToken` is `safeEqualSecret(provided, expected)`. The stored `publicKey` is
**never** used to verify a connection — it is identity metadata only (its one functional use is
`existing.publicKey !== incoming.publicKey` when deciding whether a pending request can be
refreshed in place).

The same secret therefore lives in two plain files, and a genuine approval writes **both**:

| side | file | field |
|---|---|---|
| server (gateway) | `devices/paired.json` | `<deviceId>.tokens.operator.token` |
| client (CLI/agent) | `identity/device-auth.json` | `tokens.operator.token` |

Verified byte-identical on s2, the one sandbox that pairs correctly.

**Consequence:** a cold sandbox can be repaired by hand, but only by writing *both* files with the
same freshly generated token (`randomBytes(32).toString("base64url")`, 43 chars). Seeding
`paired.json` alone — the obvious move — fails closed with `token-mismatch`, because the client
has no way to learn a token it never received.

Constraints the seeded entry must satisfy, all confirmed against the source:

- `getPairedDeviceFromState` keys off `normalizeDeviceId` = `trim()` only — so `deviceId` must
  match `identity/device.json` exactly.
- `scopesWithinApprovedDeviceBaseline` requires the token's scopes to sit inside
  `approvedScopes ?? scopes`; `operator.admin` in the baseline satisfies everything via
  `operatorScopeSatisfied`'s universal allow.
- The `legacy-browser-token` rejection only fires for `isBrowserRelatedPairedDevice` —
  `clientMode === "webchat"` or `clientId ∈ {openclaw-control-ui, webchat-ui}`. A `cli`/`cli`
  device with no `issuer` is accepted, which is why s2 works with `issuer: undefined`.

This is a workaround, not a fix — it hand-writes state that only the approval flow should
produce. It is recorded here because issues 1, 2 and 5 leave no supported alternative.

**No gateway restart is required.** `verifyDeviceAuth` calls `loadState(params.baseDir)` on every
authentication attempt, so a seeded `paired.json` takes effect on the next connection. Confirmed on
s3: seeded and `cron add` succeeded with no restart — which makes this a zero-downtime repair for
sandboxes with live users.

Two operational notes:

- **Clear `devices/pending.json` to `{}` after seeding.** A leftover pending request keeps
  `doctor` reporting `[fail] Tool-call device scope` even though the device authenticates fine.
  The stale entry is inert — the gateway answered `unknown requestId` when asked to approve it,
  and its `ts` stopped advancing — but it makes the health check lie.
- Applied 2026-07-31 to s3, s5, s6, s8 (s2 was already paired the supported way; **s7 deliberately
  skipped** — in use for testing). All five now report
  `[ok] Tool-call device scope: no pending tool-scope approvals`, and `cron add` (operator.admin)
  succeeds on each. **s7 was seeded 2026-09-16** — see the addendum below.

## Reproduction

1. Provision a sandbox with nemoclaw v0.0.73; let the startup auto-pair watcher's window expire.
2. In the sandbox: `openclaw cron status` → `pairing required: device is not approved yet`.
3. `nemoclaw <s> doctor` → `[fail] Tool-call device scope: 1 pending allowlisted tool-scope upgrade(s)`.
4. `nemoclaw <s> doctor --fix` → exits clean, **no change**; `devices/paired.json` still absent.

## What actually fixed it (per sandbox)

1. Set `openclaw.json` `gateway.port` to the real port (18789) and match
   `controlUi.allowedOrigins`; resync `.config-hash`; restart the gateway.
   (Out-of-band edits trip `GATEWAY_UNSAFE_CONFIG_PATH` — use the gateway-mediated
   download → edit → upload → hash → restart path, never `openclaw config patch`.)
2. Trigger a request, then approve it through the wrapper, twice — once for read, once for the
   cron-mutation scope:
   ```sh
   nemoclaw <s> exec --no-tty -- bash -lc "openclaw cron status"          # mints the request
   nemoclaw <s> exec --no-tty -- bash -lc "openclaw devices approve <id>" # → "using local fallback"
   ```
   Must run via `nemoclaw exec` (inside the gateway's network namespace); `docker exec` lands in a
   different netns where loopback does not reach the gateway.
3. Verify: `doctor` flips to `[ok] Tool-call device scope: no pending tool-scope approvals`.

Confirmed end-to-end on s2 — a live Telegram turn produced a clean `cron` call with no
`gatewayUrl` argument, and the job persisted with its session binding intact:

```
CALL cron {"action":"add", ...}
  -> ok {"id":"47685d5c-…","name":"Freeze check reminder",
         "sessionKey":"agent:main:telegram:default:direct:…","deleteAfterRun":true}
```

## Side effect worth fixing separately

Because the built-in `cron` tool exposes `gatewayUrl`/`gatewayToken` as parameters, the model
tries to repair these failures itself — hallucinating a gateway URL and even inventing a token —
and burns turns on `gatewayUrl override rejected`. Consider dropping those params from the
agent-facing schema; the tool resolves both from config/env anyway.

## Addendum 2026-09-16 — s7 seeded; three dead ends that cost a session

**OpenClaw 2026.6.34 (5c38f99)** — the findings below were re-read against this build, not 2026.5.27.

s7 was the last seat still holding the deadlock. It surfaced from the other end: after one-bot
phase 2 moved schedule pushes off `BOARD_BOT_TOKEN`, nothing arrived on `@yu_nemoclaw_bot`. The
cause was not phase 2. **s7's device held only `operator.pairing`**, and `message send` requires
`operator.write`, so every send on that seat had failed since creation — a nudge would have failed
identically. Two `person_pushes` rows sat frozen at `attempts=3` with `detail='message send
failed'`.

**The seed was narrower than the 2026-07-31 one.** s7 already held a *matched* token pair — the
same 43-char secret in `devices/paired.json` and `identity/device-auth.json` — so the token was
left untouched and no new secret was generated. Only the scope lists changed, byte-matching s6:

| file | field | before | after |
|---|---|---|---|
| `devices/paired.json` | `approvedScopes` (and `scopes`) | `[operator.pairing]` | `[operator.pairing, operator.read, operator.admin]` |
| `devices/paired.json` | `tokens.operator.scopes` | `[operator.pairing]` | `[operator.admin, operator.pairing, operator.read, operator.write]` |
| `identity/device-auth.json` | `tokens.operator.scopes` | `[operator.pairing]` | same four |
| `devices/pending.json` | — | one stale request | `{}` |

No gateway restart (`loadState` per auth attempt, as established above). Verified: `cron status`
clean, two `message send` probes `ok:true`, both frozen rows delivered on the next 1-minute tick
after an operator reset `attempts` to 0.

### Three dead ends, none discoverable from the error text

1. **`--url` silently disables the local pairing fallback.** In `devices-cli.runtime-*.js`:

   ```js
   function resolveLocalPairingFallback(opts, error) {
     const details = readConnectPairingRequiredMessage(...);
     if (!details) return null;
     if (typeof opts.url === "string" && opts.url.trim().length > 0) return null;   // <-- here
     ...
   }
   ```

   Every `openclaw devices approve … --url ws://127.0.0.1:18789` attempt is therefore
   *structurally* incapable of falling back. It is not a port, timing, or netns problem, and the
   error says nothing about the flag. **Never pass `--url` when the point is the fallback.**

2. **The Control UI has no device-pairing screen.** Settings → Security → *Configure* is provider
   auth profiles and backoff cooldowns. `controlUi.dangerouslyDisableDeviceAuth` only exempts
   `CONTROL_UI`/`TUI` clients **at connect time** —
   `isOperatorUiClient(client)` is `clientId === CONTROL_UI || clientId === TUI`, and the bypass is
   `params.isControlUi && controlUiConfig?.dangerouslyDisableDeviceAuth === true`. It does not
   create an approval surface. Do not route an operator to the browser to approve a device.

3. **Cold-sandbox non-convergence reconfirmed** (issue 5): each approve minted a fresh superseding
   request, `8d6dc48a…` → `12876412…`.

**Worth knowing, though it does not help here:** server-side, `device.pair.approve` *does* allow a
non-admin caller to approve **its own** device's operator-role request —
`if (!authz.isAdminCaller)` only rejects on `pending.deviceId !== authz.callerDeviceId`
(`device-ownership-mismatch`) or `requestsNonOperatorDeviceRole`. Self-approval is permitted by
design. The CLI still never reaches the method, because the bootstrap connect requesting
`operator.write` is refused before any RPC is issued. That is the whole deadlock in one sentence.

### Issue 3 (`gateway.port` drift) has a second, unnoticed consequence

s7's `openclaw.json` still carried `gateway.port: 18793` / `allowedOrigins:
["http://127.0.0.1:18793"]` against a gateway listening on **18789** — the drift this doc records,
never corrected on the held-back seat. Sends are unaffected: `nemoclaw exec` sets
`OPENCLAW_GATEWAY_URL` to the bridge address (`10.200.0.2:18789`) and never consults
`gateway.port`. But `doctor` reports `[info] Tool-call device scope: could not read OpenClaw device
list from the sandbox`, which reads like a permissions failure and is not one.

**The fleet-wide consequence:** `openshell forward start <PORT>` uses the same port on *both* ends,
but after the 2026-07-31 repair every gateway listens on 18789 while each seat's forward still
targets its old per-seat port. So **`nemoclaw <seat> dashboard-url` hands out URLs that cannot
connect, on every seat except s6** — whose assigned port happens to be 18789. `forward list`
reports all of them `running`; the listener is a live orphan whose far end is dead, so `curl`
returns exit 52 (empty reply) or an instant refusal rather than a timeout. Working invocation,
which takes separate local and target ports:

```sh
openshell forward service <seat> --target-port 18789 --local 127.0.0.1:<seat port>
```

It has no `-d`, so it runs in the foreground. Keep the *browser* on the seat's own port so
`controlUi.allowedOrigins` still matches — `ssh -L <seat port>:127.0.0.1:<box port>` satisfies it,
since the origin comes from the laptop side of the tunnel.
