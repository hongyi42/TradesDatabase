// The rails and the one rendered line for the planner's per-job notepads (plan
// 2026-08-30). The raw store is src/db/jobNotes.ts, which is an import leaf.
//
// HOW THIS DIFFERS FROM src/teamLead/memory.ts, because the two are easy to
// conflate. Memory is FIRM-scoped, found through an index the planner curates,
// and rides in every prompt — so it is bounded by attention and needs a path
// rail, an orphan footer and prompt-escaping. A notepad is JOB-scoped, found
// through the record (the job id arrives in the gap block), and is never
// rendered into the prompt body at all — only its EXISTENCE is announced, and
// the content comes back as a tool result. So there is no path to validate and
// no prompt structure to forge from here; what is left is a size rail and one
// line of copy.

/**
 * Half a memory file, and the halving is the point: a notepad is about ONE job.
 * A note that needs 4,000 characters is the wrong shape — the planner is
 * summarising a piece of work, not transcribing it — rather than a note that
 * needs more room.
 */
export const JOB_NOTE_MAX = 2000;

/**
 * The size and emptiness rail. REFUSED with an instructive error, never
 * truncated (the activateLesson precedent): a silently trimmed note is a note
 * whose last sentence is missing, and the planner would never learn it.
 *
 * EMPTY IS REFUSED RATHER THAN TREATED AS A DELETE — a deliberate divergence
 * from `write_memory`, where empty content deletes. There is no index here to
 * keep tidy, so a delete verb buys nothing, and refusing keeps this write
 * strictly NON-DESTRUCTIVE. That is the cleanest possible answer to the
 * team-lead dispatch gate's rule that nothing irreversible may dispatch for
 * this identity: the worst a bad write can do is replace prose that is still
 * recoverable from job_note_versions.
 */
export function validateJobNoteContent(
  content: unknown,
): { content: string } | { refused: string } {
  if (typeof content !== 'string') {
    return { refused: 'the note must be text — send the whole note as a string' };
  }
  if (content.trim().length === 0) {
    return {
      refused:
        'an empty note is refused — a job note cannot be deleted, only replaced. ' +
        'Write what you would want to read next time you look at this job.',
    };
  }
  if (content.length > JOB_NOTE_MAX) {
    return {
      refused:
        `that is ${content.length} characters and the limit for a job note is ${JOB_NOTE_MAX} — ` +
        'it is about one piece of work, so keep it to what you would want to know before ' +
        'deciding about this job again',
    };
  }
  return { content };
}

/**
 * The gap block's one-line announcement, or null when this job has no note.
 *
 * NULL WHEN THERE IS NONE, exactly like `historyLine` — and for the same reason
 * that function's header gives: "push the keys and the existence; pull the
 * content". Announcing an ABSENCE on every gap would be a standing nudge to
 * write one, which is the churn hazard the memory build already had to bound.
 * The prompt teaches the verb; this line only says there is something to open.
 */
export function noteLine(writtenAt: string | null | undefined, nowMs: number): string | null {
  if (!writtenAt) return null;
  const ms = nowMs - Date.parse(writtenAt);
  // Negative is possible and must not print as "-3h ago": the eval drives a
  // simulated clock backwards between scenarios, so a note stamped by a later
  // scenario would otherwise read as the future. Same guard as lastRunLines.
  const ago = Number.isFinite(ms) && ms >= 0 ? `${Math.max(1, Math.round(ms / 3_600_000))}h` : null;
  return (
    `  you have a note on this job${ago ? `, last written ${ago} ago` : ''}. ` +
    'Use read_job_note for it.'
  );
}
