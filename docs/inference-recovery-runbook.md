# Inference recovery runbook — "every assistant is dead"

**For:** whoever is on the hook when the agents stop answering. You do not need to have
written any of this. Follow it top to bottom.

> ### READ THIS FIRST (2026-09-05): the spine and the fleet are both on OpenRouter — same key, different models.
>
> | | provider | model | second lane |
> |---|---|---|---|
> | **Seat agents** (the box) | **OpenRouter**, via the gateway | preset **`@preset/trades-seats`** → `google/gemini-3.8-flash` | `meta/muse-spark-1.3`, chained by **OpenRouter per request** — the medic never reroutes |
> | **Spine** (Render web + `lifecycle-heart` cron) | **OpenRouter**, direct | `z-ai/glm-5.3` | ~10 upstream providers, automatic |
>
> **One key pays for both.** So the failure that kills the fleet — credits, a revoked key, a
> spend cap — kills the planner in the same minute, and vice versa. The medic on the box watches
> that balance every 5 minutes for free (§1); Render has no such watch.
>
> **This runbook covers the FLEET.** Every command below drives the box gateway (`openshell`,
> `nemoclaw-inference-medic`, the `openrouter-prod` provider). **If the SPINE is what is broken** —
> the planner is silent, `lifecycle-heart` is red, briefs or classifications are failing — go to
> `docs/control-plane.md` (Render setup → inference vars); the rollback there is one variable,
> `MODEL_PROVIDER=anthropic` on both Render services. A shared-key problem shows up on BOTH
> sides at once: fix the key (§1, §3) and both recover.

**The situation this covers:** the fleet's route is one OpenRouter **preset**. Inside it,
OpenRouter tries Gemini 3.8 Flash and, if that errors, Muse Spark 1.3 — on every request,
independently, with no memory; the moment Google serves again the next turn is on Gemini. That
covers *one model being down*. It does **not** cover anything above the model: the key's
credits, a revoked or gated key, OpenRouter itself, the gateway's route being reset by a
rebuild, or a model that answers in prose instead of calling a tool (that is a `200 OK`, not an
error — only the medic's probe sees it). Recovery here means **fix the key or the route**, not
"switch providers": there is no third lane, by design.

---

## 0. The 30-second triage

Run these two. Everything below branches on what they say.

```bash
ssh tradesbox
journalctl -u nemoclaw-inference-medic.service -n 20 --no-pager
export PATH=$HOME/.local/bin:$PATH; openshell inference get -g nemoclaw
```

| What the medic's last lines say | What it means |
|---|---|
| `balance ok — N USD remaining (floor 2.00; key:… credits:…)` and `route OK on openrouter-prod / @preset/trades-seats — serving verified … served=google/gemini-3.8-flash` | **Inference is fine.** The problem is elsewhere — gateway, Telegram, doorman, the spine. Stop reading this runbook. |
| `… served=meta/muse-spark-1.3` + `PRIMARY NOT SERVING — … fallback active` | **Agents ARE answering**, on the Muse lane, at Muse's cost and behaviour (slower, thinks more, ~1.7× the price per question). Google/Gemini is erroring. Nothing to fix here; check Google/OpenRouter status and wait — it returns by itself. |
| `probe skipped (last pass Ns ago; interval 3600s)` | Normal. The paid tool-call probe is hourly; the free checks ran and passed. |
| `BALANCE … below the floor … AGENTS ARE DOWN` | **Go to §1.** |
| `KEY REJECTED (401)` | The key is revoked or wrong. **Go to §3.** |
| `NO BALANCE WATCH — …` | Not an outage: the balance check could not run (no key file on the box, or OpenRouter's account endpoints did not answer). Agents may be fine. Fix the watch (§3) so the next real balance-out is caught. |
| `IS NOT SERVING — route held (registration ok, completions failing)` | Balance and route are fine, yet neither lane completes a tool call. **Read the code in §1's table** (502 = both models down; 503 = the preset's provider preferences exclude every host → check the preset, §5), then §2 for what to expect. |
| `failed REGISTRATION` | The gateway rejected the route/provider. **Go to §3.** |
| `REGISTRATION ONLY, no container for the completion probe` | No sandbox container is running. Box problem, not a provider problem — `docker ps`, and see engineering-memory §5 on `ExpiredSignature`. |
| `FALLBACK … failed its tool-call probe — the chain has no verified second lane` | Gemini is serving but Muse would not if needed. Not an outage; investigate before you need it. |
| nothing recent at all | The timer is not running: `systemctl status nemoclaw-inference-medic.timer`. |

The medic runs **every 5 minutes**: the balance and route checks are free and run every tick;
the real streamed tool-call probe runs **hourly** and is stamped only when it passes, so a
red line is not a false alarm — it retries once, and a miss re-probes every tick until it passes.

---

## 1. Check the money FIRST, before anything technical

**This is the most likely cause and the cheapest to check.** Balance-outs have hit this project
repeatedly (DeepInfra; Fireworks `412` on 2026-08-15; Fireworks `402` on 2026-09-04) and present as a
total outage with healthy-looking infrastructure. **The fleet and the planner share this key.**

Go to **https://openrouter.ai/settings/credits** (balance) and **https://openrouter.ai/settings/keys**
(the key's own monthly limit — the pilot's key carries a cap; when the cap is hit, the account may
still have credit and the key still fails).

From the box, the same numbers the medic reads (key never on a command line):

```bash
sudo cat /etc/nemoclaw/openrouter.env >/dev/null && \
curl -s -K <(sudo sh -c '. /etc/nemoclaw/openrouter.env; printf "header = \"Authorization: Bearer %s\"\n" "$OPENROUTER_API_KEY"') \
  https://openrouter.ai/api/v1/key | python3 -m json.tool
```

### Reading the error code

Get the actual code from the medic's journal or by curling from inside a sandbox (§4). The
codes are **documented by the vendor** (https://openrouter.ai/docs/api-reference/errors,
verified 2026-09-05) — do not guess from the symptom:

| Code | Vendor's documented meaning | What you do |
|---|---|---|
| **402** Payment Required | *"Your account or API key has insufficient credits"* | **Top up, or raise the key's limit.** This is the balance-out shape — and it takes the planner down too. |
| **401** Unauthorized | *"Invalid credentials (… disabled/invalid API key)"* | The stored key is wrong or revoked → §3. |
| **403** Forbidden | *"Forbidden (insufficient permissions, guardrail block, or moderation flag)"* | Also the **model attestation gate**: Muse Spark needed an 18+ confirmation at https://openrouter.ai/settings/preferences on 2026-09-05. The preset falls through to Gemini on a 403, so agents keep answering — the medic says `PRIMARY NOT SERVING`. |
| **429** Too Many Requests | *"You are being rate limited"* (`Retry-After` header) | Wait it out; capacity, not outage. |
| **502** Bad Gateway | *"Your chosen model is down or we received an invalid response from it"* | One lane is down; the preset should already be on the other. If both: OpenRouter status page. |
| **503** Service Unavailable | *"There is no available model provider that meets your routing requirements"* | Both lanes unavailable, or the preset's provider preferences exclude every host. Check the preset (§5). |

---

## 2. What to expect while you wait

From the measured record before the switch (`ops_events`, 2026-08-13 → 08-19): **11 incidents,
average 57 minutes, worst 517 minutes (8.6 h). Every one of them self-healed.**

The medic **holds the route asserted even while the probe fails**, on purpose: the moment a lane
recovers, live turns pick it up immediately instead of waiting for a flip. With the preset, a
Gemini-only outage is not even an outage — Muse carries the turns until Google is back, and the
next request after that is on Gemini again (per-request chain, no memory). So you generally do not
need to do anything to "resume".

---

## 3. If it is the credential, not the balance

The key lives in **two places** on the box and must match in both:

1. **`/etc/nemoclaw/openrouter.env`** (what the medic's balance check and daily fallback probe use):
   `OPENROUTER_API_KEY=<key>` on one line, `0600 root:root`. Write it over ssh stdin from the
   repo's `.env`, never by pasting (a rebuilt box may not have the directory yet):
   ```bash
   ssh tradesbox 'sudo install -d -m 0755 /etc/nemoclaw'
   grep -m1 '^OPENROUTER_API_KEY=' .env | ssh tradesbox 'sudo sh -c "umask 077; cat > /etc/nemoclaw/openrouter.env"'
   ```
   `sudo ./bootstrap-box.sh verify` warns when this file is missing.
2. **The gateway's provider store** (what the seats' turns use). You cannot read it back; re-set it
   from the file you just wrote:
   ```bash
   export PATH=$HOME/.local/bin:$PATH
   export OPENAI_API_KEY="$(sudo cut -d= -f2- /etc/nemoclaw/openrouter.env)"
   openshell provider update openrouter-prod -g nemoclaw --credential OPENAI_API_KEY
   ```
   (`openshell provider update --help` on the box, 2026-09-05: `--credential <KEY[=VALUE]>` — the
   bare `KEY` form is an env lookup, same as `create`; the value never appears in argv or the
   journal. The older recipes' `KEY=value` form also works but puts the key in `ps`.)

Then force a check rather than waiting five minutes:

```bash
sudo systemctl start nemoclaw-inference-medic.service; journalctl -u nemoclaw-inference-medic.service -n 8 --no-pager
```

(`;` not `&&` — a failing oneshot must still show you its journal.) Never paste a key into
chat, a ticket, or a commit.

**Registration failing (`failed REGISTRATION`)** with a good key usually means the provider entry
itself: `openshell provider get openrouter-prod -g nemoclaw` should show `Type: openai`,
credential `OPENAI_API_KEY`, config `OPENAI_BASE_URL` (= `https://openrouter.ai/api/v1`). Re-create
it with the `provider create` line in `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` §4.

---

## 4. Confirming it is really fixed

**A reply is not proof. A tool call is proof.** Two checks:

```bash
# 1. The medic's own verdict — wait for a tick, or force one as above.
journalctl -u nemoclaw-inference-medic.service -n 8 --no-pager
#    want: "balance ok — …", then
#          "route OK on openrouter-prod / @preset/trades-seats — serving verified (tool call returned) served=google/gemini-3.8-flash"
#    (served=meta/muse-spark-1.3 is ALSO serving — just on the second lane)

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

> ⚠ **The trajectory does NOT tell you which lane served it.** It records the seat's declared
> model (`google/gemini-3.8-flash`) whether Gemini or Muse answered — and the CLI banner's
> "Provider: NVIDIA Endpoints" is the gateway's internal route label, not upstream attribution. **Lane truth comes only from
> the medic's `served=` line** (hourly) and OpenRouter's Activity page (every request, with
> cost). Provider/route truth comes from `openshell inference get`.

---

## 5. Do NOT do these

- **Do not `openclaw config patch`.** It skips the config-hash and takes the gateway down
  (`GATEWAY_UNSAFE_CONFIG_PATH`). `plugins install` trips the same wire.
- **Do not hand-run `openshell inference set` without stopping the medic timer first.** The
  medic re-asserts its own `WANT_*` every 5 minutes and will revert you before you finish
  reading the output. (`sudo systemctl stop nemoclaw-inference-medic.timer`, then check no tick
  is in flight: `systemctl is-active nemoclaw-inference-medic.service`.)
- **Do not judge a route change inside its first minute.** Each sandbox CACHES the inference
  route and refreshes it on its own clock — `docker logs <sandbox> | grep "Inference routes
  updated"` shows when (seen 2026-09-05: ~60 s after the flip). A probe or a real turn inside
  that window goes out on the OLD route. Medic v6's first tick after the OpenRouter flip said
  "IS NOT SERVING" for exactly this reason and was right for exactly one minute.
- **Do not health-check with `nemoclaw <n> agent` alone.** It is a turn, not a probe; it can
  pass while the fleet is broken and fail for reasons unrelated to inference.
- **Do not add a third lane, or make the medic reroute, in the middle of an incident.** The
  second lane lives in the preset because that is where it can be honest — per request, with
  the served model reported back. An unverified fallback is how a 4-minute blip became a
  multi-day hard outage in August 2026, while the log said "FAILOVER active — COMPLETION-VERIFIED".
- **Do not edit the preset to "fix" a 503 without reading it first.** `GET
  https://openrouter.ai/api/v1/presets/trades-seats` (same key) shows the live config (v2,
  2026-09-05, v3 that evening): models `["google/gemini-3.8-flash","meta/muse-spark-1.3"]` (v2 was Muse-first with the floating Gemini alias), `max_tokens 8192`,
  `provider.allow_fallbacks true`, `provider.data_collection deny` — and deliberately **no
  `reasoning`**: the seats send `reasoning_effort` themselves, and a preset-side `reasoning.effort`
  made OpenRouter reject every non-medium level with `400 "reasoning_effort" and "reasoning.effort"
  are both provided with conflicting values` (v1, found by the Phase 4 verifier). Every change is a
  new version; the slug stays.

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

**And one new one: `PRIMARY NOT SERVING` does not page.** Agents are answering, so the medic
exits 0 and no incident opens. Muse can carry the fleet for a week and only the journal (and the
bill) would say so. Paging that state is a deliberate follow-up, not an oversight.

---

## 7. Known follow-ups (not yet built)

- **Nothing pulls the OpenRouter bill into `/admin`.** The spine's own calls are itemised in
  `cost_events`; seat spend is the account total minus that. `GET /api/v1/key` has the numbers —
  feeding them into `upsertInfraCost` ([src/db/costs.ts](../src/db/costs.ts)) is a small job.
- **No per-seat attribution.** One gateway route means one identity at OpenRouter; seat requests
  arrive untitled (the gateway strips headers). Splitting the fleet onto its own key is the
  clean way to separate it from the planner's spend — and from the planner's outages.
- **The 15-minute execution envelope vs. the 30-minute cadence** confused this document's author
  once; the planner *runs* every 30 minutes and *may run for* 15.
