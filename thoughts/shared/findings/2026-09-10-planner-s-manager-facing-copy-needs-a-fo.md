---
date: 2026-09-10
task: planner's manager-facing copy needs a formatting pass
status: complete
origin: 20260910-base-is-empty-when-origin-main-is-absent
files: src/teamLead/plannerPrompt.ts, src/teamLead/planner.ts, src/teamLead/planner.test.ts, Box_Setup_Stuff/bootstrap-box.sh
supersedes: nothing
---

## Files

- src/teamLead/plannerPrompt.ts
- src/teamLead/planner.ts
- src/teamLead/planner.test.ts
- Box_Setup_Stuff/bootstrap-box.sh

## Notes

USER, 2026-09-10 after the T1 rerun: the planner's Telegram copy is hard to read. Not
wrong -- the content was accurate and it named the reason it could not place the sender --
but the shape is a wall of prose, and a manager reading it on a phone has to work for it.

Specimen (message 6abfeee6, the real one sent at 19:05:16):

  New one for you - Delphine Warrick emailed less than an hour ago about her boiler making
  a loud banging noise when the heating kicks in, getting worse over the past week, and the
  upstairs radiators are barely warm now. She'd like someone to come take a look, afternoons
  are easiest for her. Nobody on file matches her email - should I set her up as a new
  customer and open a diagnostic job? Item 919516f4-cbc6-40a6-990e-ea9192cb24e6.

Two separable problems:

1. SHAPE. One long sentence carries the symptom, the history, the severity and the
   preference before the question arrives. On a phone the question is what the manager
   needs first.

2. THE RAW UUID, which is the concrete one and is now provably dead weight. The doctrine
   (plannerPrompt.ts:261-268) says the two legs both name the item "in `nudgeId`", the chat
   leg being "in your own words" and the ASSISTANT leg being the one "carrying the item's
   id". The uuid in the visible text is the model adding it unprompted. Evidence it is
   unnecessary: planner.ts:4822 binds `nudgeId: focus.observationId` in code, and the
   2026-09-10 19:09 run had the agent reply with `in_reply_to: 538c148f` citing item
   919516f4 -- an id it got from the quiet note, not from the text.

   IMPORTANT CAVEAT: it may have been load-bearing until 2026-09-10 18:51Z. The
   office-runner was never installed, so the chat leg was the ONLY leg delivered and the
   visible uuid was the agent's only possible route to the id. It is redundant only because
   the other leg now works. See the office-runner entry in docs/engineering-memory.md.

Proposed direction (not decided): an explicit doctrine line that the id goes in the NOTE and
never in the TEXT, plus copy guidance on the chat leg's shape -- question first, detail
after. Constraint that governs any rewrite: memory "seat-agent-texts-like-a-person" (plain
short question, never "the office") and "copy-style-no-em-dashes".

## Decisions

READ THIS BEFORE THE NOTES ABOVE, which propose "question first": that direction was tried and
reversed. What stands, as of 2026-09-14:

1. TELLING GLM 5.3 TO FORMAT A TEXT DID NOT WORK; SHOWING IT DID. Three told-only versions each
   shipped and failed live, every text one block with no \n: "a line break is allowed" (#226),
   "question first, on its own line" (#236), "make it easy to read, short paragraphs" (#237).
   The first live \n\n (7738366b) came after #238 put two worked example texts in the prompt.
   Before blaming the model for a format rule it ignores, check the prompt SHOWS the format.
2. THE CHAT RAIL AND DELIVERY KEEP BREAKS. A missing break is the model's, not the pipe's:
   cleanPlannerText keepBreaks on both chat branches, base64 through the nudge pull, a staged
   file plus "$(cat)" on the box. Proven by reading stored office_messages.body.
3. USER: the goal is READABILITY, not question position. Do not bring back a question-first rule.
4. USER: no rail and no ask/detail schema split for layout; the voice block and examples are it.
5. THE ID STAYS OUT OF EVERY CHAT TEXT: planner side by doctrine ("THE ID GOES IN THE NOTE"),
   seat side by KEEP IDS OUT OF WHAT YOU TELL YOUR PERSON (#240, rolled to all six seats and the
   recycler's copy). The planner's quiet note still tells the seat to "mention that id" in its
   inform_team_lead note, which is correct.
6. A seat doctrine change of one block rolls out BLOCK-ONLY (strip-and-re-append that section),
   not a full `wire`, which re-applies egress/plugins, needs the ctx tier per seat and can
   restart a gateway.

## Handoff 2026-09-10T21:49:20.139Z

Doctrine pass on the planner's manager-facing copy, plus the one rail change the
shape half turned out to need. Both calls were the user's, from a decision brief.

DECIDED (user, 2026-09-10):
  1. THE UUID — doctrine only, no rail. The rejected alternative was a check in
     `cleanQuestionDraft` refusing any chat message carrying a uuid. So nothing
     enforces this: `plannerPrompt.ts`'s "THE ID GOES IN THE NOTE, NEVER IN THE
     TEXT" and test (15a) are the whole of what holds it, and a regression shows
     up only as an ugly message on a manager's phone, which nothing alarms on.
  2. THE SHAPE — doctrine PLUS line breaks on the chat leg. The wider option
     (breaks on every planner-written string) was rejected.

THE FINDING THAT MADE (2) MORE THAN A PROMPT EDIT. `cleanPlannerText` ran
`.replace(/\s+/g, ' ')` over every string the planner writes, so the planner
COULD NOT produce a line break at all. Doctrine alone would have been
unfalsifiable — we would have shipped "put the ask on its own line", the rail
would have flattened it silently, and the next reader would have concluded the
model was ignoring its instructions. `keepBreaks` is the opt-out and
`cleanQuestionDraft` is its only caller.

WHY IT IS SCOPED THAT TIGHTLY, and the thing to know before adding a second
caller: the flat collapse is what makes the footer delimiter
(`\n\nNote for the assistant:`) structurally unwritable by the model — a
two-newline string cannot survive it. The one function that now opts out is also
the only one carrying the footer-impersonation refusal, so the guarantee holds on
both paths, by construction on one and by phrase check on the other. A third
caller opting in without that guard reopens the seam.

ASSUMED: that the uuid is genuinely redundant now. It rests on the office-runner
having been installed at 18:51Z today — before that the quiet note had never been
delivered and the visible uuid was the agent's only route to the item id. If the
runner stops delivering, this doctrine removes the fallback with it.

STILL OPEN: no planner tick has run against the new doctrine. Gates pass and the
rail is pinned both ways in planner.test.ts, but what the model actually writes
under "LEAD WITH THE ASK" is unmeasured — the next live inbound item is the test.

## Handoff 2026-09-10T22:49:46.703Z

COMBINED 2026-09-10 (a second session, at the user's instruction) with the promised-visit
doctrine fix — one uncommitted change on the main checkout, 3 files, +211/-19, all four gates
green (typecheck/lint/build/test exit 0; 3026 passed). NOT committed: the user is reviewing both
together first.

REVIEW OF THIS TASK'S WORK — three defects, all in keepBreaks' blast radius, each proven by a
test that failed first and mutation-checked after the fix:
  1. Footer refusal used literal spaces (/note for the assistant/i). With breaks kept,
     "Note\nfor the assistant:" passed. Now \s+.
  2. Date rail: "this morning" / "this afternoon" used literal spaces, so "this\nafternoon"
     evaded the rail. Now \s+. And the label comparison matched the RAW text, so a date the
     model WAS given ("Aug\n18" vs label "Aug 18") was wrongly refused — now compared on
     single spaces. (TEMPORAL_RE's other patterns already used \s* and still caught splits.)
  3. Found by an independent /code-review, not by me: GAP-LESS chat sends still flattened.
     Only cleanQuestionDraft got keepBreaks; the gap-less branch of validateDecisions used the
     flat cleaner for both legs, and boundGapless binds a focused pass's forgotten-nudgeId ask
     to the item only AFTER the rail — i.e. the 19:05 manager-ask path this task was for.
     Fixed with keepBreaks: as === 'chat'.

STRUCTURAL CHANGE worth knowing: the footer-phrase refusal MOVED into cleanPlannerText and now
rides the keepBreaks option itself. The old guard lived in cleanQuestionDraft alone, held by a
"do not add a second caller without one" comment — and the gap-less chat send was that second
caller. Now no caller can take breaks without the check. cleanQuestionDraft's refusal text is
unchanged ("question tried to impersonate the assistant footer").

ALSO IN THIS CHANGE (from task 20260910-a-promised-visit-was-never-booked-and-th): two doctrine
lines under basis "evidence" — LOOK BEFORE YOU CLOSE ON A MESSAGE, and A MESSAGE SAYING THE WORK
IS STILL GOING IS NOT AN ANSWER (hold instead). Pinned by test (15b). User ruling: closing stays
the planner's judgment; per-tool citation wiring rejected.

STILL OPEN, unchanged from the earlier handoff: no live planner tick has run against either
doctrine. Both are measured only by the model's behaviour on the next real inbound item.

## Handoff 2026-09-10T22:53:02.551Z

SHIPPED FOR REVIEW 2026-09-10: PR #226 (https://github.com/hongyi42/TradesDatabase/pull/226), branch feat/planner-copy-and-close-doctrine, commit 6c5be45. The work is no longer uncommitted on the main checkout — main was returned clean. If this session resumes and finds its edits gone from main, they are on that branch. Done when #226 merges and is deployed (web + lifecycle-heart, manual); then promote or archive.

## REOPENED 2026-09-12 — NOT DONE (user). Moved out of the main checkout into its own worktree.

The "done when #226 merges and deploys" condition above is SUPERSEDED. #226 merged (6793555) and
deployed, and the user's e2e runs show the fix did not hold: planner messages to the manager still
did NOT read like a text, and the planner was NOT writing new lines. This is the STILL OPEN item
every handoff above carried ("no live planner tick has run against the new doctrine; the next live
inbound item is the test") resolving as a FAIL. Which e2e runs, and which message ids, are not yet
pinned.

NEW DONE CONDITION (user's standard): a real planner message, as it ARRIVES on the manager's phone,
leads with the ask, carries no raw id in the visible text, and has line breaks. Merged and deployed
is not evidence of that; the delivered message is.

FIRST STEP, BEFORE ANY CODE CHANGE. This task already recorded the trap (handoff 21:49): a rail that
silently flattens breaks makes the model LOOK like it is ignoring its instructions. So separate the
three places a break can die before touching doctrine:
  (a) the model never wrote a break         -> a doctrine problem
  (b) the rail flattened it                 -> a send path that still does not take keepBreaks. As
                                               of #226 only cleanQuestionDraft and the gap-less
                                               `as === 'chat'` branch opt in, and planner.ts has
                                               since taken #230, #231 and d31331a
  (c) delivery flattened it after the rail  -> somewhere between the stored row and Telegram
The evidence that separates them: capture a post-#226 SPECIMEN, meaning the STORED outgoing chat
text of one of the e2e messages. Breaks in the stored row but not on the phone means (c). No breaks
in the row means (a) or (b); then find which send path produced it and whether that path passes
keepBreaks.

LEAD, not a finding (unverified): "lead with the ask" is doctrine only, with no rail behind it (the
user's 2026-09-10 call). So the two symptoms may have two different causes: the SHAPE failing at (a)
even if the missing breaks turn out to be (b) or (c).

SPECIMEN 2026-09-12 — THE FIRST STEP, DONE. It is (a), for both symptoms.
Every planner-written outgoing row since #226 reached the web service (2026-09-10 22:56Z), read
from the pilot's office_messages: four via='chat' texts to manager-sam (4304b667 09-11 18:03,
57ffab7b 20:01, 5d97b33e 22:09, dbb04a83 09-12 15:01). nudges had no question queued in the
window. Result:
  * line break in the stored body: 0 of 4 (no literal backslash-n either). The rail keeps \n
    on both chat branches (planner.ts:2540, :2944 via cleanQuestionDraft) and delivery keeps it
    (nudgeQueue.ts:255 base64, nudge-runner.sh file + "$(cat)"), so the MODEL never wrote one.
  * ask first: 0 of 4. Every one opens "Sam — <background>", and the question is the LAST
    sentence or two (5d97b33e: 457 chars, question at the end).
  * raw uuid in the text: 0 of 4. THAT HALF HELD; the ids ride the via='assistant' quiet notes,
    as designed.
Not in the brief but visible: all four open "Sam —" with an em dash.
Doctrine at the time (plannerPrompt.ts:330-340) PERMITS a break ("A LINE BREAK IS ALLOWED ...
one is usually all you need") and never asks for one.

FIX SHIPPED FOR REVIEW 2026-09-12: PR #236, commit a1a19e5 (user ruling: doctrine only, a WHAT
line, no rail). A second cause surfaced in the prompt: the inbound-ask recipe listed "who got in
touch, what they want, and the question", IN THAT ORDER, and every specimen followed it. Both the
recipe and the general rule now put the question first; the rule asks for the line break instead of
allowing it. Test (15a) pins both, and pins the two old wordings absent. Gates green (3123 passed).
Where the prompt runs: lifecycle-heart (src/jobs/lifecycle.ts, MANUAL deploy) and Calls-worker
(src/calls/runWorker.ts -> observationPing -> runFocusedObservationPass, AUTO-deploys on main). The
web service does not load it. STILL OPEN: the live e2e, i.e. the done condition above.

DEPLOYED 2026-09-12 20:42Z: lifecycle-heart on 53cb6aa (manual, user-approved). Calls-worker
auto-deployed the same commit at 20:39Z. NOT THIS TASK'S, but surfaced here: 53cb6aa carries #235,
whose migration 20260912100000_customer_captures.sql is NOT on the pilot (to_regclass null), so
Calls-worker's recordFieldNote fails on a redelivered call (captureHasLinkedL2) and on a known
customer with an ambiguous job (insertCustomerCapture). #235's PR names the hand-apply as a
pre-deploy step. Reported to the user; not acted on.
  -> APPLIED at user instruction 2026-09-12 20:51Z via MCP apply_migration (+ notify pgrst reload),
     after a dependency audit (tenants/customers/raw_captures/job_captures, raise_append_only,
     spine_reader all present; table and view absent). Verified: table + view exist, 3 indexes,
     append-only trigger, RLS on, anon cannot select, spine_reader can read the view. LEDGER DRIFT:
     recorded as `20260912205122 customer_captures`, file is 20260912100000. #235's own task
     (a-new-promise-to-a-known-customer-is-fil worktree) does not know this yet.
  ROOT CAUSE WORTH KNOWING: Calls-worker still has autoDeploy ON (trigger: commit). The 2026-09-04
  outage turned auto-deploy off on web + lifecycle-heart only, so a merge to main can still ship
  code to Calls-worker ahead of its migration.

E2E WITHOUT A NEW IDENTITY. The agentic eval corpus cannot pose this: its one person is
seat-exempt, so B65-ASK-AGAIN-IS-A-MESSAGE and B65-GAP-LESS-MESSAGE both ended send-less (dismiss /
hold, reason "no phone or assistant") -- the planner was right and both scenarios are now broken.
Delphine Warrick (75c21b4a) cannot be deleted: 1 L1 capture is stamped with her id. Instead, at
user suggestion, her customers.email was changed 20:47:33Z from hongyi23360228@gmail.com to
delphine.warrick.retired@example.test, which frees that address as an UNKNOWN sender again (the
door's keys are body phone, customers.email, Gmail thread, body address). To undo: set it back.

SECOND LIVE MISS, 2026-09-12 20:55Z (956142a9, Calls-worker focused pass on 53cb6aa, GLM 5.3,
confirmed in Render logs; decision's message had no \n before any rail). Same one block with the
question-first rule in the prompt. Firm planner memory holds only Joy's routing note.

DIRECTION CHANGED BY THE USER, 2026-09-12. The done condition above is SUPERSEDED: question position
was never the problem and pinning it is "genuinely very constraining". The complaint is that the
text is hard for a human to read; it should be simpler and more pleasing to the eye, the way the
seat agents text. Seat voice, read off s2's workspace on tradesbox: OpenClaw's DEFAULT SOUL.md /
AGENTS.md (generic "concise, not a corporate drone") plus our clause 1a in bootstrap-box.sh ("SHORT
and plain", "TWO SHORT PARAGRAPHS ... BLANK LINE"). No dedicated humanizer prompt exists. Seats run
Gemini 3.8 Flash, the planner GLM 5.3, so the model may account for part of the difference.
PR #237 (1570e0d): rule is now MAKE IT EASY TO READ ON A PHONE (short sentences, everyday words,
a short paragraph per thought with a blank line between); "it is still a sentence or two" removed;
inbound recipe order reverted. Deployed 2026-09-12 23:22Z (lifecycle-heart manual, Calls-worker
auto). NEW DONE CONDITION: the user reads the next real text on Sam's phone and judges the tone
and layout readable.

THIRD LIVE MISS, 2026-09-12 23:28Z (f9ec5bea, on 1570e0d): one 445-char block again, no \n. The
test sender "Marcus Bell" happened to match a real on-file name, so that text also asked "same
person?". PR #238: HOW A TEXT SHOULD READ block (OpenClaw SOUL.md voice + AGENTS.md human rule +
clause 1a paragraphs, blank line named as two newline characters, no name-and-dash opener, no
dashes as punctuation) with two worked example texts about other work; the inbound recipe points
at it. Rendered prompt checked from dist. Next test name checked free on the pilot: Nolan Okafor.

#238 LIVE 2026-09-14 18:05Z (Calls-worker) / 18:07Z (lifecycle-heart). FIRST TEXT WITH A BREAK:
7738366b (Nolan Okafor test, 18:12Z) has a blank line between two paragraphs. Still opens "Sam —"
despite the block's no-name-and-dash line, and paragraph one is still dense. User has not yet
judged it on the phone.

SEAT ID LEAK, 2026-09-14 18:34Z: s2 confirmed Sam's reply with "I've passed that to the office to
close out item 411b4687-dda3-431f-8319-aa4ca8025421 ...". Its inform_team_lead note carrying the id
was correct. Rule 5 already banned ids but reads as a RELAY rule; this was a CONFIRMATION. User:
seat side only. PR #240 (9a87f1c): KEEP IDS OUT OF WHAT YOU TELL YOUR PERSON under SAY WHAT YOU DID.
doctrine.test.ts refuses a date not on the same line as its "live finding" label.
ROLLED OUT 2026-09-14 to all six seats (s2 first, then s3 s5 s6 s7 s8), block-only, NOT a full
`wire` (wire re-applies egress/plugins, needs per-seat ctx tier, can restart a gateway). The user
ran scratchpad refresh-office-block.sh (the classifier refused Claude's remote write). Each seat:
1 header, rule present, diff confined to the block, container healthy, backup at
AGENTS.md.prev-20260914. NOT DONE: the box's own script copies (~/Box_Setup_Stuff/,
/usr/local/sbin/bootstrap-box.sh, sudo) are still stale, so a RECYCLED seat comes up without the
rule. Not yet verified live: the next manager confirmation after a planner ask.
  -> BOX COPIES UPDATED 2026-09-14 (user ran scratchpad update-box-copies.sh): ~/Box_Setup_Stuff/
     (backup ~/Box_Setup_Stuff.prev-20260914, was d50c3afd) and /usr/local/sbin/bootstrap-box.sh
     (backup .pre-20260914.bak, was 432f3727) both md5 ac9d85f3 = main 9a87f1c; rule present,
     bash -n OK. plugins/ already matched main in both. Stale, untouched: ~/bootstrap-box.sh,
     ~/bss-repo, ~/stage-deepinfra-retire, ~/deploy-recycler (not used by anything live).
USER 2026-09-14: planner texts are "readable enough"; no live test of the seat id rule for now.
The copy work is DONE by the user's own judgment.

FILES CLEANUP 2026-09-12: `files:` previously also listed five `.claude/work/tasks/*.md` records.
They were never this task's work. The pre-edit hook appended them because another session edited
those task files from the main checkout while this task was claimed there. Removed so they stop
producing false overlaps.

## Handoff 2026-09-14T19:47:01.143Z

**What changed** — The planner's texts to a person now come out in short paragraphs with a blank line between them (first live specimen 7738366b, 2026-09-14 18:12Z), and carry no raw item id (held since #226). What did it: #238's HOW A TEXT SHOULD READ block in plannerPrompt.ts, which is OpenClaw's default SOUL.md voice, the seat AGENTS.md "would you send it in a real chat" rule, our clause-1a short paragraphs, and TWO EXAMPLE TEXTS about other work. Separately, all six seats (and the box's ~/Box_Setup_Stuff + /usr/local/sbin recycler copy) now carry KEEP IDS OUT OF WHAT YOU TELL YOUR PERSON (#240), after s2 confirmed Sam's answer with the full item uuid.

**Decisions** — (1) USER: the complaint is READABILITY, not where the question sits; pinning the question first is "genuinely very constraining". #236's question-first rule was reverted by #237. (2) USER: bring over the seat agents' voice and SHOW an example. On GLM 5.3, three TOLD-only versions failed live: "a line break is allowed" (#226, 4 of 4 one-block texts), "question first, on its own line" (#236, 956142a9), "make it easy to read, short paragraphs" (#237, f9ec5bea). The model wrote its first \n\n only once the prompt contained worked example texts (#238). Rejected alternatives: splitting `message` into ask/detail fields joined by code (guaranteed layout, a schema change), and a refuse-and-rewrite rail (#226's refusals had turned a 1-turn close into 38). (3) USER: the seat id leak is fixed seat side only; the planner's quiet note still says "mention that id". (4) Seat rollout was BLOCK-ONLY (strip-and-re-append of the office-messages section), not a full `wire`, because wire re-applies egress/plugins, needs each seat's ctx tier by hand, and can restart a gateway. (5) USER: "readable enough"; no live test of the seat id rule for now.

**Assumptions** — That the break came from the examples and not chance: one specimen (7738366b), not a measured rate. That it transfers to texts other than new-caller asks (only inbound_unmatched was tested live). That the four other box copies (~/bootstrap-box.sh, ~/bss-repo, ~/stage-deepinfra-retire, ~/deploy-recycler) are unused by anything live; the recycler's own script (/usr/local/sbin/recycle-sandbox.sh) was not readable without sudo, so "the recycler runs /usr/local/sbin/bootstrap-box.sh" rests on the 2026-09-04 memory.

**Open** — Nolan's text still opened "Sam —" despite the block's no-name-and-dash line, and its first paragraph was dense; the user judged it acceptable. The seat id rule is unverified live. The agentic eval corpus cannot pose a planner text at all (its one person is seat-exempt): B65-ASK-AGAIN-IS-A-MESSAGE and B65-GAP-LESS-MESSAGE now end send-less and can never pass. Calls-worker still auto-deploys on every merge to main (promoted as its own finding).

**Downstream** — The pilot: Delphine Warrick's (75c21b4a) email was changed to delphine.warrick.retired@example.test so hongyi23360228@gmail.com is an unknown sender for tests; do not let a manager answer create a customer with it. The pilot got #235's customer_captures migration hand-applied (ledger 20260912205122, file 20260912100000); #235's worktree (a-new-promise-to-a-known-customer-is-fil) was not told. Sibling a-new-promise... also edits planner.test.ts.
