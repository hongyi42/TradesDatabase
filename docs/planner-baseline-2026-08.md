# Planner baseline metrics — 2026-08-24T00:10:38.015Z

> CAVEAT: numbers from a testing/pilot database demonstrate the machinery and
> are NOT a benchmark — pilot gaps do not close realistically. Read as a real
> baseline only on a firm that has run the planner for weeks. Small n = noise.

## Outcomes (paired with cost below — neither reads alone)
- closed gaps: 11
- filled by an answer: 45% (5/11)  ·  closed by the technician: 18% (2/11)
- handed to the manager: 55% (6/11)
  - answered: n=3, avg working-hours open=0.1
  - answered (tech-answered): n=2, avg working-hours open=0.7
  - manager: n=6, avg working-hours open=17.4

## Escalation judgment (premature pairs with late — either alone is gameable)
- escalations: 6
- premature (fate within 12 working hours): 17% (1/6)
- late (past 2x the gap's own allowance): 33% (2/6)
- useful (resolved, not premature): 0% (0/6)
  - fate=resolved premature late by-sweep: n=1
  - fate=still_open by-sweep: n=2
  - fate=still_open by-planner: n=2
  - fate=still_open late by-sweep: n=1

## Whiplash (verb flips with no new evidence between)
- flip pairs: 1 (avg 24.0h apart)

## Extend effectiveness
- extends answered before their extended deadline: 0% (0/1)
- still pending (deadline in the future — not counted above): 1

