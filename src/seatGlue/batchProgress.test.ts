import { describe, expect, it } from 'vitest';
import { applyBatchAction, jobName, type BatchJob } from './batchProgress.js';

const T = '2026-09-28T00:00:00Z';
const start = () =>
  applyBatchAction(null, { action: 'start', job: 'emails', title: 'Last 30 emails', source: '/home/user/files/emails.csv', batches: ['rows 1–10', 'rows 11–20', 'rows 21–30'] }, T).job as BatchJob;
const act = (job: BatchJob | null, a: Parameters<typeof applyBatchAction>[1]) => applyBatchAction(job, a, T);

describe('applyBatchAction — the checklist is data, the judgment the model\'s', () => {
  it('start → begin 1 → done 1 → next is batch 2; the source is kept for a resume', () => {
    let job = start();
    expect(job.batches.map((b) => b.status)).toEqual(['pending', 'pending', 'pending']);
    expect(job.source).toBe('/home/user/files/emails.csv');
    job = act(job, { action: 'begin', job: 'emails', n: 1 }).job!;
    const done = act(job, { action: 'done', job: 'emails', n: 1, note: 'nothing urgent' });
    expect(done.say).toMatch(/1 of 3 batches done.*Next: batch 2 \(rows 11–20\)/);
    expect(done.job!.batches[0]).toMatchObject({ status: 'done', note: 'nothing urgent' });
  });

  it('one batch at a time; the one in progress may be begun again (the resume after a Stop); a done one never', () => {
    let job = act(start(), { action: 'begin', job: 'emails', n: 1 }).job!;
    const other = act(job, { action: 'begin', job: 'emails', n: 2 });
    expect(other.changed).toBe(false);
    expect(other.say).toMatch(/Batch 1 is in progress/);
    const resumed = act(job, { action: 'begin', job: 'emails', n: 1 });
    expect(resumed.changed).toBe(true);
    expect(resumed.say).toMatch(/^Resuming batch 1/);
    job = act(job, { action: 'done', job: 'emails', n: 1 }).job!;
    expect(act(job, { action: 'begin', job: 'emails', n: 1 }).say).toMatch(/already done — never redo it/);
  });

  it('nonsense is answered in words: no such batch, no such job, a job already open, no batches, no source', () => {
    const job = start();
    expect(act(job, { action: 'begin', job: 'emails', n: 9 }).say).toMatch(/no batch 9/);
    expect(act(null, { action: 'read', job: 'x' }).say).toMatch(/no open job named x/);
    expect(act(job, { action: 'start', job: 'emails', title: 't', source: 's', batches: ['a'] }).say).toMatch(/already open/);
    expect(act(null, { action: 'start', job: 'j', title: 't', source: 's', batches: [] }).changed).toBe(false);
    expect(act(null, { action: 'start', job: 'j', title: 't', source: ' ', batches: ['a'] }).say).toMatch(/Give the source/);
  });

  it('all done says to combine the notes; clear deletes the job', () => {
    let job = start();
    for (const n of [1, 2, 3]) job = act(act(job, { action: 'begin', job: 'emails', n }).job, { action: 'done', job: 'emails', n }).job!;
    expect(act(job, { action: 'read', job: 'emails' }).say).toMatch(/All 3 batches done — now combine the batch notes/);
    expect(act(job, { action: 'clear', job: 'emails' })).toMatchObject({ job: null, changed: true });
  });

  it('job names become safe file names', () => {
    expect(jobName('../emails 2026/09')).toBe('emails202609');
    expect(jobName('...')).toBe('job');
  });
});
