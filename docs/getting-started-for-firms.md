# Getting started — a beginner's guide for your team

**Who this is for:** the owner, manager, or dispatcher at a trades firm using this assistant for the
first time, and the technicians who work for them. No technical background assumed. If a word needs
explaining, it gets explained.

**How to use it:** read Part 1 and Part 2 before your first day. Then work through Parts 3–6 one per
week — the system rewards learning it in that order, because each part depends on the one before.

---

## Part 1 — What this actually is (5 minutes)

You already have a system for remembering customers. It is: a whiteboard, a phone, a shared inbox,
three group chats, and the fact that Dave has been here eleven years and just *knows* the Hendersons
have a dog.

The problem is not that this doesn't work. It is that **it only works while everyone stays**, and it
leaks a little at every handoff:

```
customer calls  →  front desk  →  dispatcher  →  technician  →  back to the office
        "the gate code is 4321"        ↓              ↓                  ↓
                              re-typed        remembered        lost by Thursday
```

This assistant builds **one record per customer and job** that everybody writes into and everybody
reads from. Nobody re-types anything, and nothing depends on Dave.

**You talk to it in Telegram.** That's it — no new app to learn, no website to log into, no
passwords. Each person gets their own private chat with the assistant, exactly like texting a
colleague. There is one extra screen — the **dispatch board**, a drag-and-drop schedule that opens
*inside* Telegram — and the manager lives there.

```
   Manager's phone                        Technician's phone
   ┌──────────────┐                       ┌──────────────┐
   │ Telegram chat│  "book the Hendersons │ Telegram chat│  "just finished at
   │   with the   │   for Tuesday 9am"    │   with the   │   the Miller place,
   │  assistant   │                       │  assistant   │   compressor's shot"
   └──────┬───────┘                       └──────┬───────┘
          │                                      │
          └──────────────►  ONE RECORD  ◄────────┘
                        (customers, jobs, visits,
                         every note, every email,
                         every recorded call)
                                 │
                          ┌──────┴──────┐
                          │ the board   │  ← the schedule, dragged with your thumb
                          └─────────────┘
```

**Two roles, two different views.** A *manager* schedules the whole team and manages people. A
*technician* sees their own day, records what happened, and looks things up. Technicians cannot
change the schedule — that is on purpose, so the schedule has exactly one author.

---

## Part 2 — Four ground rules (read these before you type anything)

These four things surprise everyone. Understanding them up front saves a lot of confusion later.

### Rule 1 — Nothing you record can be deleted

Every note, email, and call transcript is kept permanently, exactly as it came in. When something is
wrong, you **retract** it: you say why, and it stops showing up anywhere — in briefings, in
summaries, in lists. But the original is still on file underneath.

*Why:* it means the record can always be re-checked against what was actually said. If the system
misunderstands a note today, we can re-read the original next year and fix it. That is only possible
if the original still exists.

*What this means for you:* say what you mean, and use "retract" when you get it wrong. Retracting is
normal and easy — it is not an admission of anything.

### Rule 2 — It asks permission for things it can't take back

Sending an email. Recording a note permanently. Booking or moving a visit you already promised a
customer. For these, the assistant shows you exactly what it is about to do and waits for you to say
yes.

For everything reversible — setting someone's hours, correcting a job title, looking something up —
it just does it and tells you what it did.

*Why:* if it asked about everything, you would start saying "yes" without reading, and then the one
that mattered would slip through. Constant confirmation is a safety problem, not a safety feature.

### Rule 3 — It tells you where every fact came from

When the assistant briefs you on a customer, each claim traces back to the actual note, email, or
call it came from. If it cannot find a basis for something in your records, it says so instead of
guessing.

*What this means for you:* if a briefing says something surprising, you can ask "where did that come
from?" and get a real answer.

### Rule 4 — It is not good at calendar math, so it looks dates up

If you say "next Tuesday," the assistant checks what date that actually is rather than working it
out. When "next Tuesday" is genuinely ambiguous — is that this coming Tuesday or the one after? — it
will ask you. That is not the assistant being dense; it is it refusing to guess about something that
would move a real appointment.

**Please answer the date question rather than saying "you know what I mean."** It genuinely doesn't.

---

## Part 3 — Week 1, Manager: setting up (about an hour)

Do these in order. Later steps depend on earlier ones.

### Step 1 — Add your team

> **You:** Add Ben Shelton as a technician.
>
> **Assistant:** Nothing has been added yet. This will add Ben Shelton as `ben-shelton`, a technician,
> and use one of your 5 technician seats. Confirm?
>
> **You:** Yes.

Repeat for each person. Notes:

- You bought a certain number of **seats**. Each person with an assistant uses one.
- Someone you dispatch but who doesn't need an assistant — a subcontractor, say — can be added as
  **schedule-only**. They appear on the schedule and use no seat. Just say so: *"add Marco as
  schedule-only."*
- The name becomes a permanent id (`ben-shelton`) that never gets reused, even years later. Names are
  worth getting right the first time.

### Step 2 — Set everyone's working hours ⚠️ **the step people forget**

> **You:** Ben works Monday to Friday, 8 to 5.

**Until you do this, the scheduler will never book that person.** They will simply be invisible to it,
with no error message. If automatic scheduling ever seems to be ignoring someone, this is the first
thing to check.

Half-days, split shifts, and four-day weeks all work — just say them: *"Priya works Monday to
Thursday 7 to 4, and Friday mornings only."*

### Step 3 — Tell it how long jobs take

> **You:** Maintenance calls take an hour. Installs take a full day. Diagnostics, 90 minutes.

The scheduler **never assumes** a job length. A job with no length can't be placed automatically — it
will sit in the loose pile and the assistant will ask you how long it takes. Setting the common types
up front avoids that.

You can always override for a specific job: *"the Henderson install is going to take two days."*

### Step 4 — Skills (optional, and safe to skip)

> **You:** Ben does boilers and gas lines.

Leaving this blank means "can do anything" — it never excludes anyone. It only matters once you start
marking jobs as needing a specific skill.

### Step 5 — Connect each person's phone and email

For each person, two things:

- **Telegram:** they open `@userinfobot` in Telegram, which tells them a number. Send it to the
  manager, who says *"bind Ben's Telegram to 8991633730."* The assistant replies with the name of
  Ben's bot. **Ben has to open that bot and press Start himself** — Telegram doesn't let bots message
  first.
- **Email:** *"get me a connect link for Ben."* Forward the link to Ben; he signs into Google and
  approves. **The link expires in about 25 minutes**, so forward it right away. Once he approves, you
  get asked to confirm his mailbox address is the right one — check it carefully, since that mailbox
  will start flowing into your records.

### Step 6 — Say how far ahead technicians can see

> **You:** Technicians should see four weeks ahead.

Beyond that, their schedule says "not published yet" rather than showing an empty week. This stops
someone glancing at an unplanned week and telling a customer they're free.

**End of setup.** Ask *"who is on my team?"* and check it all reads back the way you expect.

---

## Part 4 — Week 1, Technician: the three things you actually do

If you're a technician, this is your entire manual. Everything happens in one Telegram chat.

### 1. "What's my day?"

> **You:** What's on today?
>
> **Assistant:** Three stops. 9:00 Henderson, 4412 Oak — annual service. 11:30 Miller, 88 Bay St —
> no heat, urgent. 2:00 Costa, 1200 Willow — quote.
> Each stop comes with a tap-to-open directions link.

The stops come in the order they're booked. The assistant will not re-order your day — if it needs
re-ordering, that's a conversation with your manager.

### 2. "Here's what happened"

**Send a voice note.** This is the whole point of the system, and it takes eight seconds:

> **You:** *(voice note)* "Just finished at the Miller place. Compressor's shot, it's a 2009 unit, not
> worth repairing. Quoted him roughly forty-two hundred for a replacement, he's talking to his wife.
> Dog in the back yard, friendly but loud. Gate code is 4321."
>
> **Assistant:** Recording this against Bill Miller, 88 Bay St: *(shows the note back to you)*.
> Confirm?
>
> **You:** Yes.

That one voice note becomes: the visit record, the diagnosis, the quote, and two permanent facts
about the property that every future technician will see before they arrive. You typed nothing.

**Say the customer name or address if you can** — it's how it knows whose record this goes on. If it
can't tell, it asks.

### 3. "What do I need to know?"

> **You:** Brief me on the Hendersons before I go.
>
> **Assistant:** Third visit this year. Dog on the property — friendly. Prefers afternoons. Last
> visit (March 12) replaced a capacitor; Dave noted the unit is 14 years old and "will need doing in
> the next couple of years." Gate code 4321.

You can also just ask questions: *"has anyone been out to the Costa place before?"*, *"what did we
quote the Millers?"*

**One more thing you can do:** ask it to look something up on the web — a part number, an error code,
a supplier's hours. And it can draft and send an email from your own work mailbox, showing you the
draft first. Everything sent that way is kept on the record — including anything personal, so keep
personal mail out of the work assistant.

---

## Part 5 — Week 2, Manager: running the schedule

### The daily rhythm

The board is where you live. Open it from any schedule answer by tapping **See it on the board**. It's
a day-by-day grid: each technician is a column, each visit a block. Drag a block to move it. A tray
at the side holds work that exists but isn't scheduled yet — the **loose pile**.

Everything you can do by dragging, you can also do by typing. They are the same underlying actions,
so they can never disagree:

> **You:** Book the Hendersons for Tuesday morning with Ben, annual service, an hour.
>
> **You:** Move the Costa quote to Thursday.
>
> **You:** What still needs assigning?
>
> **You:** Cancel the Miller job — he went with someone else.

### Promises: the most important idea in the schedule

The system tracks **what you told the customer**, separately from what's on the calendar. There are
four levels:

| What you told them | What can still move |
|---|---|
| Nothing yet | Everything — day and time |
| "Sometime Tuesday" | The time, but it stays on Tuesday |
| "Sometime in the morning" | The day, but it stays a morning |
| "Tuesday at 9" | Nothing. It's locked to the customer. |

Say it naturally and it records the right level: *"I told her Tuesday, no time"*, *"promised him 9am
Tuesday"*, *"nothing promised yet."*

**Why this matters:** when the assistant re-plans your week, it will freely shuffle unpromised work
and will never break a promise you made. That is the difference between an optimizer you can trust
with real customers and one you can't.

If you got a promise wrong, fix it: *"actually I only promised the Millers a day, not a time."*

### Pinning

> **You:** Pin the Henderson visit — Ben specifically asked for it.

Pinned means automatic scheduling will never touch it, for any reason. **Only a human ever pins
anything** — the assistant never pins on its own. Use it for the things you know that the system
doesn't.

---

## Part 6 — Week 3, Manager: the weekly freeze

This is where the system starts saving you your Sunday evening.

During the week, work accumulates in the loose pile — jobs with no visit yet, visits with nobody
attached, visits that have a day but no time. Once a week (most firms do it Friday afternoon), you
run **the freeze**:

> **You:** Run the freeze for next week.
>
> **Assistant:** Proposed plan: 23 placed, 4 skipped, 2 pinned untouched. The two that matter: the
> Costa install needs a full day and nothing has one free before the 19th; Priya's Wednesday is over
> capacity by 90 minutes. Nothing is booked yet — the full plan is on the board.
>
> *(You open the board, look it over, drag two things around.)*
>
> **You:** Yes, go ahead.

What just happened: it worked out real driving routes and placed the loose pile across your team's
week — respecting hours, time off, job lengths, promises, and pinned work. It **booked nothing** until
you said yes.

Three things worth knowing:

- **A proposal expires after 12 hours**, and dies immediately if the schedule changes underneath it.
  Re-run for a fresh one — this is deliberate, so you never commit a stale plan.
- **When reality breaks the plan** — someone calls in sick, an emergency lands — you can re-plan the
  whole week rather than hand-patching it: *"re-solve the rest of the week."* Same deal: proposal
  first, your yes second. It prefers small same-day shuffles over throwing everything around.
- **If you regret it:** *"undo that."* It puts everything back where it was — but only for the most
  recent run, and **only within 15 minutes**. It is a fresh-mistake tool, not a time machine.

---

## Part 7 — Week 4: the channels that fill the record for you

Everything so far was people typing and talking. These two fill the record by themselves.

### Email

Once a person's work mailbox is connected, work email flows into the customer record automatically —
attached to the right customer, without anyone forwarding anything.

Personal email is filtered out **before** it is ever stored, not after. (Given Rule 1, "after" would
be too late.)

### Phone calls

Customers call your number. They hear a short, unskippable announcement that the call is recorded,
then the call forwards to your normal line and rings exactly as it does today. Nobody's habits change.

Afterwards, the call is transcribed and lands on the customer's record. If the caller's number matches
an existing customer, it attaches automatically. If it's a new number, the transcript is still saved
and flagged for you to link.

Card numbers, security codes, and social security numbers are stripped out of the transcript before
it's stored. Recordings are deleted automatically after the retention window you chose; the
transcript is kept.

**Your legal obligations, plainly:** the announcement is what makes the recording lawful, so never
ask us to remove it. You are the one responsible for telling your customers you record calls in your
own privacy notice — we provide the announcement and the deletion tooling, you own the customer
relationship.

---

## Part 8 — Cheat sheet

**Technicians**

| To do this | Say |
|---|---|
| See your day | "What's on today?" / "What's my week?" |
| Record what happened | *Send a voice note.* Include the customer name. |
| Prepare for a visit | "Brief me on the Hendersons" |
| Look something up | "What did we quote the Millers?" |
| Remember something permanent | "Gate code at the Costas is 4321" |
| Fix a mistake | "Retract that last note — wrong customer" |

**Managers** (everything above, plus)

| To do this | Say |
|---|---|
| See the team's day | "What's the team on today?" → then tap the board |
| Book | "Book the Hendersons Tuesday 9am with Ben, service, one hour" |
| Move | "Move the Costa quote to Thursday" |
| Find room | "When can we fit a 2-hour job this week?" |
| See what's unplanned | "What still needs assigning?" |
| Plan the week | "Run the freeze" |
| Re-plan after chaos | "Re-solve the rest of the week" |
| Undo (within 15 min) | "Undo that" |
| Protect a visit | "Pin the Henderson visit" |
| Add someone | "Add Ben Shelton as a technician" |
| Set hours | "Ben works Monday to Friday 8 to 5" |
| Time off | "Priya is off the 14th through the 18th" |
| Check what needs you | "What's pending?" |

---

## Part 9 — When something seems wrong

| What you see | What's happening | What to do |
|---|---|---|
| "The scheduler ignores Ben" | Ben has no working hours set | "Ben works Monday to Friday 8 to 5" |
| "It won't schedule this job" | The job has no length, and its type has none either | Tell it how long: "the Costa install takes 6 hours" |
| A technician sees an empty week | It's past their visible horizon | Normal. Raise it if you want: "technicians should see 6 weeks" |
| It keeps asking which Tuesday | "Next Tuesday" is genuinely ambiguous | Answer with the date. This is it protecting a real appointment. |
| "Board link doesn't work" | They haven't pressed Start on the board bot | Open the board bot in Telegram and press Start |
| A brand-new person can't do anything | Their Telegram isn't bound, or they haven't pressed Start | Manager: "bind Ben's Telegram to <number>" — then Ben presses Start |
| It sounds confidently wrong about a fact | Ask where it came from | "Where did that come from?" — then retract the bad note |
| The assistant is slow or acting dumb | Something on our side | Tell us. Don't work around it. |

**A general rule:** if the assistant tells you something about the schedule and the board shows
something different, **believe the board** and tell us. They read the same data, so a disagreement is
a bug worth knowing about.

---

## Part 10 — What it doesn't do

Worth knowing before you build a habit around something that isn't there:

- **No invoicing, payments, or accounting.** You can mark a job "invoiced"; no money moves through
  this system.
- **Customers never talk to it.** It is a tool for your staff, not a chatbot for your callers. It does
  not answer the phone, take bookings on its own, or call anyone.
- **It doesn't replace your dispatcher.** It removes the typing and remembers everything. A human
  still decides.
- **No separate app or website.** Telegram and the board inside it are the whole product.

---

## Part 11 — Your first month, honestly

- **Week 1:** get everyone recording voice notes after every job. That single habit is 80% of the
  value, and it is the only one that needs real behavior change. Nothing else works well until the
  record has something in it.
- **Week 2:** move scheduling onto the board. Keep the whiteboard as a backup — you'll stop looking
  at it on your own.
- **Week 3:** start each morning by asking for a briefing on your first two customers. This is where
  technicians usually get convinced.
- **Week 4:** run the freeze for real, and let the phone and email channels fill the record while you
  do.

The compounding is the point. A record with three months of notes in it is a different product from an
empty one — briefings get sharper, repeat customers stop needing to re-explain their history, and the
things one technician knew become things everyone knows.

**Tell us what's clumsy.** Nearly every guardrail in this system exists because someone hit a real
problem and said so.
