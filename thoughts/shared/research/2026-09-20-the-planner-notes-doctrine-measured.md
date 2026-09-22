---
date: 2026-09-20
branch: work/rung-10c-a-seat-s-inform-wakes-the-plann
commit: 8c4e4b6
topic: The planner's notes doctrine, measured — 29/30 standing instructions filed, 0/10 false positives, on the deployed model through the real tool loop. The evidence rung 10c has been blocked on since 2026-09-08.
supersedes: nothing (it ANSWERS the open question in docs/engineering-memory.md "ORDER: the planner's notes doctrine lands BEFORE 10c")
---

## Summary

**The coin flip is gone.** A seat's standing instruction — "route all job and visit messages to
Sam from now on" — is written into the planner's notes **29 times out of 30**, and ordinary
gap-answering traffic is filed **0 times out of 10**. Measured on `z-ai/glm-5.3` via OpenRouter,
the model `lifecycle-heart` actually runs, through the real tool loop with the real tool surface.

This is the evidence rung **10c** has been waiting for since 2026-09-08. The rung's own reasoning
was: pinging the planner faster only loses a standing instruction thirteen minutes sooner, so
waking it early is not worth building until the doctrine is known to work. It works.

**What is left is a rate, not a mechanism** — 1 instruction in 30 was still lost, and an office
message is seen ONCE. Whether 3% is acceptable is the operator's call; it is not a reason to keep
10c blocked, because that residual is identical whether the planner reads the message in ten
seconds or in thirty minutes.

## The question, and why it was open

```
2026-09-07 23:47Z   manager → seat: "route all future job/visit messages to Sam"
                    seat calls inform_team_lead        ✓
                    planner reads it at the 00:00 tick ✓
                    planner writes …                   ✗  NOTHING
                    message flips to `read` — instruction gone FOREVER

2026-09-08 22:21Z   the SAME instruction, the SAME seat
                    read at the 22:31 tick
                    planner writes MEMORY.md + firm/routing.md   ✓

                    byte-identical prompt. opposite outcomes. a COIN FLIP.
```

And the correction that made it worse (recorded 2026-09-11): **PR #212 — the prompt line that
tells the planner to write notes — was live for NEITHER measurement.** It reached the heartbeat on
2026-09-09, after both. So the coin flip was the baseline *without* the fix, and the fix itself
had never been measured at all. The line is in the deployed prompt today
(`src/teamLead/plannerPrompt.ts:121-126`):

> BUT SOME MESSAGES ARE NOT ABOUT A GAP AT ALL … WRITE IT IN YOUR NOTES, in the same breath as
> reading it. You see a message ONCE … A standing instruction you did not write down is one you
> were never given.

One more live look could not settle this. A 50% mechanism looks fixed on any good day, which is
why the rung asked for an N-run eval rather than another specimen.

## How it was measured

`scripts/planner-eval/notes-run.mjs` (`npm run planner-eval:notes`), with
`notes-analyze.mjs` as the grader. It is a **sibling** of the existing `planner-eval` copy harness,
not an extension of it, for two reasons that each independently rule that harness out:

| | `run.mjs` (the copy eval) | `notes-run.mjs` (this) |
|---|---|---|
| model | Anthropic, Opus by default | **production's default path** — `z-ai/glm-5.3` on OpenRouter, inherited from `forcedTool.ts`, never set |
| tools | ONE forced `submit_plan`, no loop | the real `runToolLoop` with `[...TEAM_LEAD_TOOL_SCHEMAS, SUBMIT_PLAN_TOOL]` |

`write_memory` is a *tool*. Under a forced-single-call harness the behaviour measured here is not
merely unobserved — it is **unreachable**. That is the whole reason this file exists.

**Real:** `PLANNER_SYSTEM`, the whole tool surface in the production order the prompt caches on,
`buildGapView`, `buildOfficeMessagesBlock`, `buildPlannerUserMessage`, `PLANNER_MAX_TOKENS` and
`PLANNER_REASONING` (imported, never copied), `runToolLoop` itself.

**Not real:** the executor. Reads answer thin-but-plausible, writes answer ok. So this measures
whether the note is WRITTEN, never what it is worth against a real record.

**The world has work in it, deliberately.** Two ordinary gaps with real evidence and a $500
payment, so the planner has its usual job in front of it — the instruction was lost in production
while it was busy, and a prompt holding nothing but the message would measure an easier question
than the one that failed.

**No database.** The script reads one key out of `.env` by name and never loads the rest, so
`SUPABASE_URL` is absent and `getClient()` throws rather than quietly writing to the pilot's live
database. `recordUsage` is stubbed for the same reason, and is also where the token totals come from.

## The result

```
routing-sam        10/10  100%   the literal 2026-09-07 specimen
away-until          9/10   90%   "out until the 3rd, send my jobs to Dani"
no-early-texts     10/10  100%   "stop texting me before 7am"
CONTROL            10/10  100%   an ordinary gap answer — correctly filed NOTHING

standing total     29/30   97%   ·  plan submitted in 40/40  ·  40 runs, ~$0.78
```

If the true rate were the 50% coin flip, 29-or-more out of 30 would happen with probability
**2.9 × 10⁻⁸**. The coin flip is ruled out.

**The control is half the result.** A planner that files a note about everything would have scored
100% on the three standing variants and been broken in a way the rate could not show — notes that
fill with traffic stop being notes. It filed nothing, 10 times out of 10, and did so in a median
of 2 turns: it is not agonising over the distinction, it simply does not treat a gap answer as
something to keep.

The notes are substantive, not token-passing. A representative one (`firm/pacing.md`):

> - Judy Alvarez (manager): NO texts before 7am her time — she does not see them and it wakes the
>   house. After 7am is fine. (told to me Sunday Sep 20, 2026)

It carries the instruction, the author and the date — the three things that make a standing fact
usable a week later. Across runs it filed to `firm/people.md`, `firm/pacing.md`,
`firm/routing.md` and `MEMORY.md`, choosing the path by the KIND of fact, with no prompting about
where anything goes.

## The one miss, and what it does not explain

`away-until` run 9: three turns, `spine_read → spine_read → read_memory → spine_read → spine_read
→ submit_plan`, no memory write. Its closing text discusses only the two gaps — the message about
being away is not mentioned at all. The planner did its ordinary job and the instruction fell
through.

The tempting explanation is that it rushed: three turns was the joint-shortest look of the run.
**It does not hold.** `away-until` run 10 was also three turns and filed the note, and across all
standing runs 8 of the 9 looks of four turns or fewer filed. With n=1 on misses there is no cause
to attribute — what can be said is the shape of the failure (absorbed in the gaps, message never
addressed), not its trigger.

## What this means for rung 10c

**The blocker is discharged.** The rung's stated condition was "one N-run eval, not one live look",
and its stated fear was a mechanism that works half the time. The mechanism works 97% of the time
and does not fire on traffic.

The residual does not argue for keeping 10c blocked, and it is worth being precise about why: the
3% is a property of *how the planner reads a message*, not of *when*. Waking it in ten seconds
instead of thirty minutes neither causes nor cures it. Holding 10c would trade a real thirty-minute
delay for no change in the loss rate at all.

## Decision for the operator

| | option | what it costs |
|---|---|---|
| **A** | **Unblock 10c and build it** (recommended) | Nothing extra. The 3% residual rides along unchanged, as it does today. |
| **B** | Chase the residual first | A second eval at higher N to characterise a 1-in-30 event — expensive, and it measures a rate we already know is small and is not made worse by 10c. |
| **C** | Make the message re-showable | The deepest fix — kill "seen ONCE" so a lost instruction returns. This is a *bigger* change than 10c and arguably belongs to it: 10c already has to add a claim column, and a claim that is never released is what makes a crash destroy a message. Worth the operator's decision, not a side effect of 10c. |

Recommendation: **A**, with **C** raised explicitly as a separate question when 10c's claim column
is designed, since that is the moment its cost is lowest.

## Traps this run leaves behind

- **A planner-eval harness MUST pass `[...TEAM_LEAD_TOOL_SCHEMAS, SUBMIT_PLAN_TOOL]`.** The first
  matrix here was voided at 26 runs because it passed only the schemas: `planner.ts:5152` appends
  the terminal tool, and a harness that omits it never OFFERS `submit_plan`. The model could not
  submit a plan — not "chose not to" — so every run ended with the planner's actual job undone,
  which is exactly the too-easy world that flatters a doctrine measurement. The void run is kept at
  `thoughts/shared/evals/VOID-no-submit_plan-offered-2026-09-20/`. Symptom to recognise: `NO PLAN`
  on 100% of runs.
- **An errored run is not a measurement.** The grader first scored a 429 as a control PASS, because
  the control's test is "wrote nothing" and a run that never reached the model writes nothing.
  Errors now score `null` and are excluded from the rate rather than flattering it.
- **The OpenRouter key's monthly CAP binds before its credit balance does.** The pilot's
  `INFERENCE_API_KEY` 429'd with "could not verify available credits" at $47.97 of a $50/month
  key limit while the account still held credits; topping up credits did not lift it, raising the
  key's limit did. This is the likely root cause of the open board finding
  `20260920-seats-hit-all-models-` (seats rate-limited), and it is worth knowing that the pilot's
  planner and extractor share that one key.

## Reproducing

```bash
npm run planner-eval:notes -- --yes --runs 10        # ~$0.80, ~13 min, spends money
npm run planner-eval:notes:report -- --dir thoughts/shared/evals/planner-notes-<stamp> --notes
```

Run data: `thoughts/shared/evals/planner-notes-2026-09-20T17-00-00-000Z/`.
