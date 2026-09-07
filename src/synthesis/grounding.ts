import {
  CORRESPONDENCE_KEY,
  correspondenceEntries,
  factSourceIds,
  isFactBundle,
  participantsOf,
  type CustomerContext,
  type Json,
} from '../db/index.js';

// A single grounded claim: a statement the synthesizer made, paired with the L1
// capture id it is sourced from. captureId must reference a real capture in the
// CustomerContext — validateCitations enforces that deterministically (overview
// §5: synthesis is the model's job, verifying provenance is code's).
export interface Citation {
  claim: string;
  captureId: string;
}

// Render a CustomerContext into a labeled text block the model can read. Every
// capture is tagged with its id so the model can cite it; each visit carries its
// source_capture so the model can connect a structured fact to the capture that
// backs it. raw_text is nullable (e.g. a technician_photo/blob-only capture), so
// a placeholder keeps the capture id citeable rather than printing `null`.
export function serializeContextForPrompt(context: CustomerContext): string {
  const { customer, jobs, upcomingVisits, recentVisits, recentCaptures } = context;

  const attrs = (value: unknown): string => JSON.stringify(value ?? {});

  // Customer/job attributes can be wrapped standing facts ({value,
  // sourceCaptureId, recordedAt}): render the plain value WITH its capture id
  // so the model reads clean facts and can cite the evidence. Plain values
  // print as-is (visit attributes never come through here).
  const attrsWithEvidence = (value: Json): string => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return attrs(value);
    }
    const parts = Object.entries(value).map(([key, raw]) => {
      const v = raw ?? null;
      // BOUNDED (rung 10). `correspondence` is a job's running list of what
      // customers said — one entry per inbound capture — so on a long-running
      // job the whole array would crowd every other fact out of the brief. The
      // newest three are what a reply needs; the rest are one spine_read away,
      // and the count says they exist rather than hiding them.
      if (key === CORRESPONDENCE_KEY && Array.isArray(v)) {
        const entries = correspondenceEntries(value);
        const shown = entries.slice(-3);
        const earlier = entries.length - shown.length;
        // LABELLED, not just rendered (decision C): every other key on this
        // line is something the FIRM recorded, and these are the customer's own
        // words. Unlabelled, a model reads "followUp: bring a washer" as the
        // firm's plan rather than what the caller asked for.
        return (
          `${key} (what the customer said on their calls and emails)=` +
          `${JSON.stringify(shown)}${earlier > 0 ? ` (${earlier} earlier)` : ''}`
        );
      }
      return isFactBundle(v)
        ? `${key}=${JSON.stringify(v.value)} (capture ${v.sourceCaptureId})`
        : `${key}=${JSON.stringify(v)}`;
    });
    return `{${parts.join(', ')}}`;
  };

  const customerLine = customer
    ? `CUSTOMER: ${customer.name} | phone=${customer.phone ?? '—'} | ` +
      `address=${customer.address_line1 ?? '—'}` +
      `${customer.city ? `, ${customer.city}` : ''}` +
      `${customer.state ? `, ${customer.state}` : ''}` +
      ` | attributes=${attrsWithEvidence(customer.attributes)}`
    : 'CUSTOMER: (not found)';

  const jobLines = jobs.length
    ? jobs
        .map(
          (j) =>
            `- [job ${j.id}] ${j.title ?? '(untitled)'} (${j.job_type ?? '—'}) ` +
            `status=${j.status} attributes=${attrsWithEvidence(j.attributes)}`,
        )
        .join('\n')
    : '- (none)';

  // The schedule ahead — the half "next visit" questions are answered from
  // (2026-08-13: briefs previously saw only past visits and answered "nothing
  // scheduled" over four confirmed bookings). Untimed rows say so explicitly:
  // the model must relay that no time is set, never invent one.
  const upcomingLines = (upcomingVisits ?? []).length
    ? (upcomingVisits ?? [])
        .map(
          (u) =>
            `- [upcoming ${u.visitId}] ${u.jobTitle ?? '(untitled)'} ` +
            (u.untimed
              ? 'booked, but NO time set yet — say exactly that'
              : `${u.phrase} ${u.startTime ?? ''}${u.endTime ? `–${u.endTime}` : ''}`) +
            ` tech=${u.technicianRef ?? (u.unassigned ? 'UNASSIGNED' : '—')}`,
        )
        .join('\n')
    : '- (none booked)';

  const visitLines = recentVisits.length
    ? recentVisits
        .map(
          (v) =>
            `- [visit ${v.id}] tech=${participantsOf(v).map((p) => p.displayName).join(' + ') || '—'} ` +
            `labor=${v.labor_hours ?? '—'} source_capture=${v.source_capture_id ?? '—'} ` +
            `attributes=${attrs(v.attributes)}`,
        )
        .join('\n')
    : '- (none)';

  const captureLines = recentCaptures.length
    ? recentCaptures
        .map(
          (c) =>
            `- [capture ${c.id}] channel=${c.channel} at=${c.captured_at}: ` +
            `${c.raw_text ?? '(no text — blob/photo)'}`,
        )
        .join('\n')
    : '- (none)';

  return [
    customerLine,
    '',
    'JOBS:',
    jobLines,
    '',
    'UPCOMING VISITS (the schedule ahead):',
    upcomingLines,
    '',
    'PAST VISITS (newest first):',
    visitLines,
    '',
    'CAPTURES (evidence — cite these ids):',
    captureLines,
  ].join('\n');
}

// Keep only citations that point at a capture actually present in the context
// (drops a hallucinated id), and collapse duplicate (claim, captureId) pairs.
// Guards an absent array — the model may omit citations entirely.
export function validateCitations(
  citations: Citation[] | undefined,
  context: CustomerContext,
): Citation[] {
  const realIds = new Set(context.recentCaptures.map((c) => c.id));
  // Standing-fact evidence ids are offered as citeable in the serialized
  // prompt ("(capture <id>)"), so accept them here too. Today they are also
  // in recentCaptures (facts stamp customer_id), but that is incidental — a
  // future writer citing a capture outside that list must not have its
  // citations silently dropped as hallucinated (review finding).
  for (const id of factSourceIds(context.customer?.attributes ?? null)) realIds.add(id);
  for (const j of context.jobs) for (const id of factSourceIds(j.attributes)) realIds.add(id);
  // CORRESPONDENCE ids too (rung 10), and here it is NOT incidental: an inbound
  // capture on an existing job is never stamped with a customer_id (identity
  // resolves after L1, which is immutable), so it is in NEITHER set above. The
  // job line shows the model those ids; without this, a model citing exactly
  // what it was just shown has the citation dropped silently, which is the
  // ungrounded-brief failure this function exists to prevent.
  for (const j of context.jobs) {
    for (const entry of correspondenceEntries(j.attributes)) realIds.add(entry.captureId);
  }
  const seen = new Set<string>();
  const valid: Citation[] = [];
  // Guard a non-array too, not just absent — the model could emit citations as a
  // non-array despite the schema, which would make `for...of` throw.
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (!citation || !realIds.has(citation.captureId)) continue;
    const key = `${citation.claim} ${citation.captureId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(citation);
  }
  return valid;
}
