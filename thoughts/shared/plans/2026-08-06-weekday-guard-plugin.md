# Weekday guard — detect fabricated weekdays on the outbound message (2026-08-06)

## The problem, in one sentence

The agent keeps pairing a weekday with a date that isn't that weekday ("Monday the 4th" for a
Tuesday; "Thursday 2026-08-09" for a Sunday), every upstream fix has been "help the model get it
right," and after five such fixes in three days the failure has simply moved rather than stopped.

## The decision this plan implements

**Stop adding instructions. Add a check.** A deterministic detector on the *outbound message* —
the one choke point every reply passes through regardless of which tool the date came from — that
verifies every (weekday, date) pair the text states, and **logs** mismatches. Detect-only in this
phase: no rewrite, no cancel. Two weeks of logs turns "I found three by reading trajectories" into
a rate, and the rate decides whether to escalate (cancel-and-retry) or close the file.

Why not auto-correct: given "today, Thursday 2026-08-09" the wrong half is ambiguous — the agent
meant *today* (Thursday the 6th), so "fixing" the weekday to Sunday would assert today is Sunday.
Correction needs the model's intent; detection doesn't.

Costs nothing per turn: no tokens, no instructions, ~0.04 ms of CPU per message (measured).

## Where it runs

OpenClaw plugin, `message_sending` hook — vendor-documented (docs.openclaw.ai/plugins/hooks):
fires on outbound content before channel delivery; a handler that returns nothing changes nothing.
Install mechanics are proven by the (since-removed) trades-cron plugin, recovered from git history
(3bff655^): files → `/sandbox/.openclaw/extensions/<id>/`, chmod 660,
`openclaw plugins registry --refresh` (plugins load from a persisted registry, not a boot scan),
gateway restart. **No `openclaw.json` edit** — the config-patch trap never comes into play.

## Detection algorithm

Parser: `chrono-node` (wanasit/chrono, 5.3k★, zero deps, active). Searched GitHub first: the
Guardrails hub (40 validators), NeMo-Guardrails, and code search have **no temporal-consistency
validator** — nobody has built this; chrono is the primitive that makes it cheap.

The property that makes it sound: chrono distinguishes a component the text **stated**
(`isCertain('weekday')`) from one it inferred. We flag only when the text states BOTH a weekday
and a day and they disagree — a bare "Friday" or a bare "2026-08-09" states no pair, so no flag.

1. **Ordinal pre-pass.** chrono deliberately ignores month-less ordinals ("Monday the 4th"), which
   is exactly live failure #1. Regex expands `<Weekday> the Nth` → `<Weekday> <Month> N, <Year>`,
   choosing the month that puts N nearest the reference date (handles "the 2nd" said on the 30th).
   Skips `… the 4th of <Month>` (chrono handles those itself).
2. `chrono.parse(expanded, ref)` with ref = firm-local noon (tenant tz, default
   America/Los_Angeles; container clock is UTC — the known UTC-naming trap).
3. Per parsed component (range start AND end): require `isCertain('weekday') && isCertain('day')`.
   Year/month not certain → resolve to the candidate nearest the reference date (±1 unit) before
   computing the true weekday — kills the December "Monday January 4" false positive without
   missing same-month errors.
4. Stated weekday ≠ computed weekday → flag `{said, claimed, actually, date, context}`.

Verified against the real trajectory strings before this plan was written: both live failures
caught, eight innocent forms silent, 11/11.

## Shape

```
Box_Setup_Stuff/plugins/trades-weekday-guard/
  openclaw.plugin.json      manifest (id, onStartup, empty configSchema — same as trades-cron)
  package.json              openclaw.extensions → ./index.js
  index.js                  READABLE source: detector (exported pure fns) + register(api)
  chrono.bundle.mjs         chrono-node bundled ONCE via esbuild, committed; banner pins version
src/control/weekdayGuardPlugin.test.ts   fixtures load index.js by runtime path (trades-cron pattern)
```

index.js imports `./chrono.bundle.mjs`, so the tests exercise exactly what ships, and editing the
detector needs no rebuild — only a chrono upgrade rebuilds the bundle (command in its banner).

## Fail-open, always

The hook must never break delivery: everything in try/catch; any internal error → log to stderr,
return nothing. Log write failures are swallowed. If `api.on` is missing on this OpenClaw version,
log once and register nothing — the bot is unaffected.

## The log

`/sandbox/.openclaw/logs/weekday-guard.jsonl`, one line per scanned outbound message:
`{ts, v, channel, chars, flags:[{said, claimed, actually, date, context}]}` — `flags: []` on the
overwhelming majority. Rate = flagged/total. Context is ±40 chars around the match (the sandbox
already stores full transcripts; this adds no new exposure). Size guard: >5 MB rotates to `.1`.

## Testing (the "make sure it would work" part)

1. **Fixture suite** — the two live failures verbatim, the ordinal variant, and a bank of innocent
   forms: the resolve_date phrase, availability summaries ("Mon–Fri 08:00–17:00; Sat, Sun off"),
   bare weekdays, relative dates, ISO timestamps, numeric dates, next-month/next-year references,
   abbreviations ("Tue Aug 4"). Plus garbage: null/object/empty/huge/emoji content — assert
   no-throw and no-flag.
2. **Corpus replay** — extract every historical outbound message from the fleet's session
   transcripts and run the detector over them offline. Expect: known failures flagged, false-positive
   rate ~0 on everything else. This is the strongest pre-deploy evidence available — real traffic.
3. **Canary** — install on s6 (cold blank: real container + gateway, no live user). Verify: plugin
   in the registry, gateway restart clean, no config warnings, bot healthy.
4. **Live** — s2 next; the user fires a date-naming question; verify a `flags: []` line lands in
   the guard log (proves the hook actually fires on the telegram path). Then s5/s7/s8.

## Rollout & docs

- bootstrap-box.sh gains a refreshed wire step (upload 4 files, chmod, registry refresh) so fresh
  boxes get the guard; the /usr/local/sbin box copy is updated in the same change (standing rule).
- Box_Setup_Stuff sync rule: doorman-nemoclaw-setup-guide + docs/nemoclaw-tech-agent.md note the
  plugin; engineering-memory records the decision and the GitHub-search result.
- PR before merge (code rule). s3 skipped (out of use).

## Explicitly out of scope (phase 2, only if the rate says so)

Cancel-and-retry on flag; extending checks to bare dates ("state the weekday" enforcement);
consolidating the four date formats in context; per-tenant timezone config.
