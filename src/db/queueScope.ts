// The scope of a host-queue read (step 3, plan 2026-09-23-step-3-office-reaches-glue-seats).
// Its own module so nudges.ts, officeMessages.ts and personPushes.ts share it
// without importing each other.

/**
 * Which of a host's people a queue read covers (step 3). A glue seat pulls ONE
 * person's rows (`onlyTechnicianId`, from its seat token); the box's bash
 * runners pull everyone on the host EXCEPT people whose glue is pulling right
 * now (`skipTechnicianIds`) — otherwise one row is served, and counted, twice.
 * Shared by the three host-queue tables (nudges, office_messages, person_pushes).
 */
export interface QueueScope {
  onlyTechnicianId?: string;
  skipTechnicianIds?: string[];
}

/**
 * Apply a QueueScope to a query on a table with a `technician_id` column. The
 * skip list comes from the seats table (uuids), never from a caller's text, so
 * splicing it into the `in` list is safe.
 */
export function scopeQueueQuery<
  Q extends {
    eq(column: string, value: string): Q;
    not(column: string, operator: string, value: string): Q;
  },
>(query: Q, scope: QueueScope): Q {
  let q = query;
  if (scope.onlyTechnicianId) q = q.eq('technician_id', scope.onlyTechnicianId);
  if (scope.skipTechnicianIds?.length) {
    q = q.not('technician_id', 'in', `(${scope.skipTechnicianIds.join(',')})`);
  }
  return q;
}
