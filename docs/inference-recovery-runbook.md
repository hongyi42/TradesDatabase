# Inference recovery runbook — "every assistant is dead"

**For:** whoever is on the hook when the agents stop answering. You do not need to have
written any of this. Follow it top to bottom.

**The situation this covers:** the fleet runs on **one** inference provider (Fireworks) with
**no fallback**. That is a deliberate choice, not an oversight — an unverified fallback is
worse than none, because it fails exactly when you depend on it and reports success while
doing so. DeepInfra was retired 2026-08-19 and there is no lane to fail over to.
So recovery here means **fix Fireworks**, not "switch providers".

---

## 0. The 30-second triage

Run these two. Everything below branches on what they say.

```bash
ssh tradesbox
journalctl -u nemoclaw-inference-medic.service -n 20 --no-pager
export PATH=$HOME/.local/bin:$PATH; openshell inference get -g nemoclaw
```

| What the medic's last line says | What it means |
|---|---|
| `route OK on fireworks-prod / … — serving verified (tool call returned)` | **Inference is fine.** The problem is elsewhere — gateway, Telegram, doorman, the spine. Stop reading this runbook. |
| `IS NOT SERVING — route held (registration ok, completions failing)` | The provider accepts the key but will not complete turns. **Go to §1.** |
| `failed REGISTRATION as well` | The key or the account is rejected outright. **Go to §1.** |
| `REGISTRATION ONLY, no container for the completion probe` | No sandbox container is running. This is a box problem, not a provider problem — check `docker ps`. |
| nothing recent at all | The timer is not running: `systemctl status nemoclaw-inference-medic.timer`. |

The medic runs **every 5 minutes** and its probe is a real streamed tool call, so a green
line is strong evidence and a red line is not a false alarm — it retries once before
complaining.

---

## 1. Check the money FIRST, before anything technical

**This is the most likely cause and the cheapest to check.** Provider balance-outs have hit
this project repeatedly, and they present as a total outage with healthy-looking
infrastructure.

Go to **https://fireworks.ai/account/billing**.

Fireworks is pay-as-you-go here — there is no fixed monthly cap to raise, the limit rises
with use. As of 2026-08-18 the balance was **~$9.60**, which at fleet traffic is on the
order of **days**. Expect to top it up.

### Reading the error code

Get the actual code from the medic's journal or by curling from inside a sandbox (§4). The
codes are **documented by the vendor** — do not guess from the symptom:

| Code | Vendor's documented meaning | What you do |
|---|---|---|
| **402** Payment Required | *"Account is not on a paid plan or has exceeded usage limits."* | **Top up / fix the payment method.** This is the balance-out shape. |
| **412** Precondition Failed | *"Account is suspended or there's an issue with account status. This error also occurs when attempting to invoke a LoRA model that failed to load."* | Usually a suspension → billing page. **But note the second cause:** a 412 is *not* proof of a money problem. |
| **401** Unauthorized | *"Invalid API key or insufficient permissions."* | The stored credential is wrong or revoked → §3. |
| **403** Forbidden | *"Authentication issues."* | Same as 401 in practice → §3. |
| **429** Too Many Requests | Serverless: account exceeded its request/TPM limit. | Wait it out; it is a capacity signal, not an outage. |

Source, verified 2026-08-19: https://docs.fireworks.ai/guides/inference-error-codes

> **Correction to older notes.** Engineering memory recorded 2026-08-15's HTTP **412** as
> "the monthly spend cap". The vendor documents 412 as *account suspended / account status*,
> and documents **402** as the usage-limit-and-billing code. Treat 412 as "account-level
> problem, check billing first" rather than "definitely a spend cap", and remember it can
> also mean a model failed to load — our route is a **router**
> (`accounts/fireworks/routers/glm-5p2-fast`), so that path is not hypothetical.

---

## 2. What to expect while you wait

From the measured record (`ops_events`, 2026-08-13 → 2026-08-19): **11 incidents, average 57
minutes, worst 517 minutes (8.6 h)**. The 2026-08-15 Fireworks suspension ran **69 minutes**.
**Every one of them self-healed.**

The medic **holds the route asserted even while the probe fails**, on purpose: the moment the
provider recovers, live turns pick it up immediately instead of waiting for a flip. So you
generally do not need to do anything to "resume" — fix the money and it comes back.

---

## 3. If it is the credential, not the balance

The gateway stores the key; you cannot read it back. Re-set it:

```bash
openshell provider update fireworks-prod --credential OPENAI_API_KEY=<new-key>
```

Then force a check rather than waiting five minutes:

```bash
sudo systemctl start nemoclaw-inference-medic.service
journalctl -u nemoclaw-inference-medic.service -n 5 --no-pager
```

Never paste a key into chat, a ticket, or a commit.

---

## 4. Confirming it is really fixed

**A reply is not proof. A tool call is proof.** Two checks:

```bash
# 1. The medic's own verdict — wait for a tick, or force one as above.
journalctl -u nemoclaw-inference-medic.service -n 5 --no-pager
#    want: "route OK on fireworks-prod / … — serving verified (tool call returned)"

# 2. A real turn through a real seat.
SID="recovery-$(date -u +%Y%m%d-%H%M%S)"
B64=$(printf 'What date is this coming Friday?' | base64)
ssh tradesbox "export PATH=\$HOME/.local/bin:\$PATH; MSG=\$(echo '$B64' | base64 -d); \
  nemoclaw s2 agent --agent main --session-id $SID -m \"\$MSG\" </dev/null 2>&1"
```

Then read the **trajectory**, not the CLI output:

```bash
ssh tradesbox "docker exec \$(docker ps --format '{{.Names}}' | grep '^openshell-s2') \
  sh -c 'cat /sandbox/.openclaw/agents/main/sessions/$SID.jsonl'"
```

You want to see a `trades-spine__resolve_date` tool call in there. CLI stdout carries config
warnings and delivery errors that have been mistaken for the model's answer before.

> ⚠ **The trajectory does NOT tell you which provider served it.** It records
> `model: "z-ai/glm-5.2"` and the banner may say "NVIDIA Endpoints" — those are the gateway's
> internal route labels, not upstream attribution. Provider truth comes only from
> `openshell inference get` and the medic's probe.

---

## 5. Do NOT do these

- **Do not `openclaw config patch`.** It skips the config-hash and takes the gateway down
  (`GATEWAY_UNSAFE_CONFIG_PATH`). `plugins install` trips the same wire.
- **Do not hand-run `openshell inference set` without stopping the medic timer first.** The
  medic re-asserts its own `WANT_*` every 5 minutes and will revert you before you finish
  reading the output.
- **Do not health-check with `nemoclaw <n> agent` alone.** It is a turn, not a probe; it can
  pass while the fleet is broken and fail for reasons unrelated to inference.
- **Do not add a fallback provider in the middle of an incident.** An unverified fallback is
  how a 4-minute blip became a multi-day hard outage in August 2026, while the log said
  "FAILOVER active — COMPLETION-VERIFIED".

---

## 6. Two limits of the alarm you should know

**It is at-most-once, not guaranteed.** If the Telegram push fails transiently, that alert is
gone — it is logged and never retried, and every later medic tick returns `suppressed`, so
nothing re-fires. **A silent channel looks exactly like a healthy fleet.** When in doubt,
check directly:

```sql
select * from ops_events where closed_at is null;
```

**Alerting is off entirely if `OPS_ALERT_CHAT_ID` is unset** on the Render web service. The
incident still gets recorded; nobody is told. That is precisely the gap that let eleven
outages pass unnoticed before 2026-08-19.

---

## 7. Known follow-ups (not yet built)

- **No backup provider lane.** Deferred by decision to the move into production. Until then,
  an outage is an outage and this runbook is the whole plan.
- **No Fireworks invoice collector**, so the agent-inference line on `/admin` reads $0.
  `cost_rates` already carries Fireworks prices; only the bill is missing.
- **Ledger footnote:** August 2026's DeepInfra figure is frozen as an `estimate` ($22.59) —
  the collector was removed before the month settled. If the settled invoice ever matters,
  correct it via `upsertInfraCost` ([src/db/costs.ts](../src/db/costs.ts)); nothing else
  reads it.
