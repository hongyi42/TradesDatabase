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
