---
name: batching
description: How to do a job too big for one pass (many emails, every open job) — list the items first, keep a checklist, one batch at a time, and resume after a stop.
---

# Doing a big job in batches

The pattern is Claude Code's to-do list and Anthropic's long-running harness: list everything
first, keep a checklist, do ONE batch at a time, write down what each batch found, and never say
you are finished while a batch is still open.

## 1. Get your bearings

Call `batch_progress` with action `list` first. If an open job matches what the manager is asking
for — or they said "carry on", "keep going", "finish that" — continue it from its next batch
(section 4). Never start the same job twice.

## 2. List the items once, as a file

Put the items in a file on your computer ONCE, with `export_query`. For email:

    select id, captured_at, raw_text from v_captures
    where channel = 'email' order by captured_at desc limit 100

→ filename `emails` (it becomes `/home/user/files/emails.csv`). This file is the job's source:
**never export it again for the same job**, not even when you resume — new mail would shift the
rows under your batch labels.

## 3. Make the checklist

Count the rows, then `batch_progress start` with:
- `job`: a short name (e.g. `emails-2026-09-28`), `title`: what the manager asked, in their words
- `source`: the file (`/home/user/files/emails.csv`)
- `batches`: one label per batch, in order. Size them so one batch fits one read: about **10 emails**
  per batch (their bodies are long), about 25 short rows. Label them "rows 1–10 of emails.csv", …

## 4. Each batch, one at a time

1. `batch_progress begin` with its number.
2. Read ONLY that batch. Email bodies contain line breaks, so never slice the file by lines — use
   Python's `csv` module, and strip the From/Subject header lines from each body:

       python3 - <<'PY'
       import csv, sys
       csv.field_size_limit(sys.maxsize)
       rows = list(csv.DictReader(open('/home/user/files/emails.csv', newline='')))
       for r in rows[0:10]:                      # rows 1–10
           body = r['raw_text'].split('\n\n', 1)[-1]
           print('---', r['id'], r['captured_at']); print(body[:700])
       PY

   Keep a batch's output under about 9,000 characters (the tool shows only the last 9,000): if bodies
   are cut and one matters, read it whole with `get_capture` and its id.
3. Write what the batch found to `/home/user/files/batches/<job>/<n>.md` with `write_file`: every
   item that needs the manager (who, what, how urgent, any phone number or address), and one line
   for the rest ("8 routine: newsletters, receipts").
4. `batch_progress done` with its number and a one-line note.

Never read the next batch before this one is done. Never skip a batch.

## 5. Finish

When `batch_progress` says all batches are done, read ONLY the batch notes (not the emails again),
combine them into the answer, and send it — as a message, or as a file with `share_file` if it is
long. Then `batch_progress clear`. Never tell the manager the job is finished while any batch is
open.

## 6. Stopped, interrupted, or dropped

If you are stopped, the checklist stays. When the manager comes back, say where the job stands
("4 of 10 batches done") and carry on from the next batch — the one that was in progress is begun
again. If they drop the job, `clear` it.
