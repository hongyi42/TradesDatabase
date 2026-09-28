import type { E2bSandboxLike } from './sandbox.js';

// A job's batch checklist (step 2c, plan 2026-09-28-step-2c-batching): the
// manager seat's version of Claude Code's to-do list — pending → in_progress →
// done, one batch at a time — kept as a FILE in the manager's sandbox so it
// survives a Stop, /new and compaction, and a "carry on" resumes from it
// (Anthropic's long-running harness: get bearings from the progress file, one
// item at a time, never declare done early).
//
// The checklist is DATA; the judgment is the model's. It stores batches and
// their states, says what is next, and refuses only what is incoherent — a
// batch that does not exist, a second batch in progress, redoing a done one.
// Batch size and when to batch are never decided here.

export const BATCHES_DIR = '/home/user/files/.batches';

export type BatchStatus = 'pending' | 'in_progress' | 'done';
export interface Batch {
  n: number;
  label: string;
  status: BatchStatus;
  note?: string;
}
export interface BatchJob {
  job: string;
  title: string;
  /** The file the batches index. A resume reuses it — never a fresh export (new rows would shift the labels). */
  source: string;
  batches: Batch[];
  createdAt: string;
  updatedAt: string;
}

export type BatchAction =
  | { action: 'start'; job: string; title: string; source: string; batches: string[] }
  | { action: 'begin'; job: string; n: number }
  | { action: 'done'; job: string; n: number; note?: string }
  | { action: 'read'; job: string }
  | { action: 'clear'; job: string };

export interface Progress {
  done: number;
  total: number;
}

/** Cut by characters, never through a surrogate pair (an emoji). */
const cap = (s: string, n: number): string => Array.from(s).slice(0, n).join('');

/** A job name as a file name: letters, digits, dot, dash, underscore. */
export function jobName(job: string): string {
  return (job.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '') || 'job').slice(0, 60);
}

/** One line: where the job stands, and what to do next. */
export function describe(job: BatchJob): string {
  const done = job.batches.filter((b) => b.status === 'done').length;
  const current = job.batches.find((b) => b.status === 'in_progress');
  const next = current ?? job.batches.find((b) => b.status === 'pending');
  const head = `${job.title} (${job.job}): ${done} of ${job.batches.length} batches done; source ${job.source}.`;
  if (!next) return `${head} All ${job.batches.length} batches done — now combine the batch notes into the answer, then clear the job.`;
  return `${head} Next: batch ${next.n} (${next.label})${current ? ', already begun — carry on with it' : ''}.`;
}

export function progressOf(job: BatchJob): Progress {
  return { done: job.batches.filter((b) => b.status === 'done').length, total: job.batches.length };
}

/**
 * Apply one action to a job (null = no such job). Returns the job to store
 * (null = delete the file) and the words for the model. Pure.
 */
export function applyBatchAction(job: BatchJob | null, a: BatchAction, now: string): { job: BatchJob | null; say: string; changed: boolean } {
  const unchanged = (say: string) => ({ job, say, changed: false });
  if (a.action === 'start') {
    if (job) return unchanged(`A job named ${job.job} is already open. Carry on with it, or clear it first. ${describe(job)}`);
    const labels = a.batches.filter((l) => typeof l === 'string' && l.trim()).map((l) => cap(l.trim(), 120));
    if (!labels.length) return unchanged('Give at least one batch (a label each, like "rows 1–10 of emails.csv").');
    if (!a.source?.trim()) return unchanged('Give the source: the file the batches index (it is reused on a resume).');
    const next: BatchJob = {
      job: jobName(a.job),
      title: cap(a.title?.trim() || jobName(a.job), 120),
      source: a.source.trim(),
      batches: labels.map((label, i) => ({ n: i + 1, label, status: 'pending' })),
      createdAt: now,
      updatedAt: now,
    };
    return { job: next, say: `Started. ${describe(next)}`, changed: true };
  }
  if (!job) return unchanged(`There is no open job named ${jobName(a.job)}. List the open jobs with action "list", or start one.`);
  if (a.action === 'read') return unchanged(describe(job));
  if (a.action === 'clear') return { job: null, say: `Cleared ${job.job}.`, changed: true };

  const batch = job.batches.find((b) => b.n === a.n);
  if (!batch) return unchanged(`${job.job} has batches 1 to ${job.batches.length}; there is no batch ${a.n}. ${describe(job)}`);
  if (a.action === 'begin') {
    if (batch.status === 'done') return unchanged(`Batch ${a.n} is already done — never redo it. ${describe(job)}`);
    const other = job.batches.find((b) => b.status === 'in_progress' && b.n !== a.n);
    if (other) return unchanged(`Batch ${other.n} is in progress: finish it (action "done") before beginning another. ${describe(job)}`);
    // Beginning the batch already in progress is the resume after a Stop.
    const resumed = batch.status === 'in_progress';
    const next = { ...job, updatedAt: now, batches: job.batches.map((b) => (b.n === a.n ? { ...b, status: 'in_progress' as const } : b)) };
    return { job: next, say: `${resumed ? 'Resuming' : 'Began'} batch ${a.n} (${batch.label}). ${describe(next)}`, changed: true };
  }
  // done
  if (batch.status === 'done') return unchanged(`Batch ${a.n} was already done. ${describe(job)}`);
  const next = {
    ...job,
    updatedAt: now,
    batches: job.batches.map((b) => (b.n === a.n ? { ...b, status: 'done' as const, ...(a.note ? { note: cap(a.note, 300) } : {}) } : b)),
  };
  return { job: next, say: `Batch ${a.n} done. ${describe(next)}`, changed: true };
}

export interface BatchToolDeps {
  sandbox: { get(holdMs?: number): Promise<{ sbx: E2bSandboxLike; fresh: boolean }> };
  /** After every change: the job's progress, or null once it is cleared (the Working line). */
  onProgress?(p: Progress | null): void;
}

const fileOf = (job: string) => `${BATCHES_DIR}/${jobName(job)}.json`;

export function batchProgressTool(deps: BatchToolDeps) {
  // Calls for one job run in arrival order: the engine makes parallel tool
  // calls, and a read-modify-write race would lose a "done" (plan review).
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, f: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(f, f);
    queues.set(key, run.catch(() => {}));
    return run;
  };

  // null = no such job. ANY other failure (bad JSON, a sandbox hiccup) is
  // 'unreadable' and nothing may overwrite it: a start on top would silently
  // lose a half-done job's progress (review).
  const read = async (sbx: E2bSandboxLike, job: string): Promise<BatchJob | null | 'unreadable'> => {
    let text: string;
    try {
      text = await sbx.files.read(fileOf(job));
    } catch (err) {
      return (err as { name?: unknown } | null)?.name === 'FileNotFoundError' ? null : 'unreadable';
    }
    try {
      const job = JSON.parse(text) as BatchJob;
      return Array.isArray(job?.batches) ? job : 'unreadable';
    } catch {
      return 'unreadable';
    }
  };
  const UNREADABLE = (job: string) =>
    `The checklist for ${jobName(job)} could not be read just now; nothing was changed. Try again in a minute; ` +
    `if it keeps failing, tell the manager and clear it only with their go-ahead.`;

  return {
    name: 'batch_progress',
    description:
      'Your checklist for a job done in batches (load the batching skill first). Actions: ' +
      '"start" {job, title, source, batches: [labels]} — source is the file the batches index, reused on a resume; ' +
      '"begin" {job, n} before reading a batch; "done" {job, n, note} after its note is written; ' +
      '"read" {job}; "list" (the open jobs — check it first: a "carry on" continues one); "clear" {job} when the answer is sent. ' +
      'One batch in progress at a time; a done batch is never redone.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'begin', 'done', 'read', 'list', 'clear'] },
        job: { type: 'string', description: 'A short name for the job, e.g. "emails-2026-09-28".' },
        title: { type: 'string' },
        source: { type: 'string', description: 'start: the file the batches index, e.g. /home/user/files/emails.csv.' },
        batches: { type: 'array', items: { type: 'string' }, description: 'start: one label per batch, in order.' },
        n: { type: 'number', description: 'begin/done: the batch number (1-based).' },
        note: { type: 'string', description: 'done: one line on what the batch found.' },
      },
      required: ['action'],
    },
    handler: async (args: unknown): Promise<string> => {
      const a = (args ?? {}) as Record<string, unknown>;
      const action = a.action;
      let sbx: E2bSandboxLike;
      try {
        sbx = (await deps.sandbox.get()).sbx;
      } catch (err) {
        return `Error: your computer could not be opened (${err instanceof Error ? err.message : String(err)}). Try again in a minute.`;
      }
      if (action === 'list') {
        const r = await sbx.commands.run(`ls -1 ${BATCHES_DIR} 2>/dev/null || true`).catch(() => null);
        const names = (r?.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.json')).map((l) => l.slice(0, -5));
        if (!names.length) return 'No open batch jobs.';
        // Through each job's queue, so a list never reads a checklist mid-write.
        const lines = await Promise.all(names.map((n) => serial(n, async () => {
          const job = await read(sbx, n);
          return job && job !== 'unreadable' ? `- ${describe(job)}` : `- ${n}: could not be read`;
        })));
        return `Open batch jobs:\n${lines.join('\n')}`;
      }
      if (typeof a.job !== 'string' || !a.job.trim()) return 'Error: give the job name.';
      const job = a.job;
      if (!['start', 'begin', 'done', 'read', 'clear'].includes(String(action))) {
        return 'Error: action is one of start, begin, done, read, list, clear.';
      }
      return serial(jobName(job), async () => {
        const current = await read(sbx, job);
        // An unreadable checklist is never overwritten; only an explicit clear may remove it.
        if (current === 'unreadable' && action !== 'clear') return UNREADABLE(job);
        const out = applyBatchAction(current === 'unreadable' ? null : current, {
          action,
          job,
          title: typeof a.title === 'string' ? a.title : '',
          source: typeof a.source === 'string' ? a.source : '',
          batches: Array.isArray(a.batches) ? (a.batches as unknown[]).map(String) : [],
          n: Number(a.n),
          note: typeof a.note === 'string' ? a.note : undefined,
        } as BatchAction, new Date().toISOString());
        if (current === 'unreadable' && action === 'clear') {
          try {
            await sbx.commands.run(`rm -f ${fileOf(job)}`);
          } catch (err) {
            return `Error: the checklist could not be cleared (${err instanceof Error ? err.message : String(err)}); it is still there. Try again.`;
          }
          try {
            deps.onProgress?.(null);
          } catch {
            /* the Working line is a nicety */
          }
          return `Cleared ${jobName(job)} (its checklist could not be read).`;
        }
        if (out.changed) {
          try {
            if (out.job) {
              await sbx.commands.run(`mkdir -p ${BATCHES_DIR}`);
              await sbx.files.write(fileOf(job), JSON.stringify(out.job, null, 2));
            } else {
              await sbx.commands.run(`rm -f ${fileOf(job)}`);
            }
          } catch (err) {
            return `Error: the checklist could not be saved (${err instanceof Error ? err.message : String(err)}); nothing changed. Try again.`;
          }
          try {
            deps.onProgress?.(out.job ? progressOf(out.job) : null);
          } catch {
            /* the Working line is a nicety; the checklist is what matters */
          }
        }
        return out.say;
      });
    },
  };
}
