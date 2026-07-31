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

Suggested fix: run the `devices list` step through the same env-stripped local fallback the
approve step already uses (`unset OPENCLAW_GATEWAY_URL/PORT/TOKEN`), and surface a diagnostic
instead of `sys.exit(0)` when listing fails.

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
`gateway.port` to 18789 (and `controlUi.allowedOrigins` to match) made `devices approve` work
first try. OpenClaw's own tool-level validator already expects 18789 — it rejects overrides with
*"Allowed: ws(s) loopback on port 18789"* — so the config value is the outlier.

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

## Why loopback matters

OpenClaw waives device pairing only for shared-secret clients arriving on a **loopback** address
(`isSharedSecretLoopbackLocalEquivalent` in `dist/message-handler-*.js`). Because
`OPENCLAW_GATEWAY_URL` points at the bridge IP, the waiver never applies. Demonstrated in one
agent turn (s2, 2026-07-27), all three paths in sequence:

| call | result |
|---|---|
| default (env → `10.200.0.2`) | ❌ pairing required |
| explicit `ws://10.200.0.2:18789` | ❌ *"override rejected — Allowed: ws(s) loopback on port 18789"* |
| explicit `ws://127.0.0.1:18789` | ✅ job created |

Note the middle row: OpenClaw refuses the very address NemoClaw configures.

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
