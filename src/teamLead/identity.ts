// The team-lead identity class (plan 2026-08-15 feature B, Phase 3; direction
// constraint 2). A reserved-namespace ref — `slugify` mints human refs over
// [a-z0-9-], so the ':' namespace can never collide with a roster row (the
// 'connector:' precedent). It lives in its own module because BOTH the MCP
// dispatch gate and the compose turn need it, and compose must not have to
// import the whole server to learn a constant.
export const TEAM_LEAD_REF = 'spine:team-lead';

// The identity's ENTIRE tool surface. The dispatch gate denies the whole
// `spine:` namespace anything NOT in this set — deny-by-default, so a forgotten
// entry fails closed (targetGuard doctrine).
//
// THE RULE THIS HEADER USED TO STATE — "nothing irreversible or externally
// visible may ever dispatch for it" — was a v1 POSTURE, and rung 10b retires it
// (user ruling, 2026-09-07: the planner writes L2). It was never a design: it
// described a planner that could only read and ask, at a moment when nobody had
// decided whether it should write the record at all. It has been decided.
//
// What replaces it is narrower and actually load-bearing:
//   * EVERY WRITE CITES A CAPTURE. `record_caller` re-runs the one door for a
//     specific L1 row, so the customer, the job and the trip it creates all
//     carry `source_capture_id` — "where did this come from" is answerable for
//     every row the planner has ever caused.
//   * ASK-FIRST IS DOCTRINE, NOT MECHANISM, and deliberately so. Linking a
//     caller we already know needs nobody's permission; creating a customer,
//     opening a job and booking a trip are put to a manager first. Code sets the
//     CEILING (what the tool can reach at all); the planner decides the call.
//   * NOTHING HERE REACHES A PERSON. `send` is still not a tool for this
//     identity — the planner PROPOSES it and code performs it after the loop,
//     through applyDecision, where the rails live.
// Enforcement of the ceiling is still mechanism (this gate), never prompt text.
//
// v1 was READ/ASK ONLY. Build 3 (plan 2026-08-30) adds the FIRST WRITE VERB —
// `write_memory` — and it is worth writing down why it passes the rule rather
// than bending it:
//   * not irreversible: every overwrite and every delete archives the previous
//     content (planner_memory_versions, ten deep per path). The state it
//     mutates is the planner's OWN notes, nothing the ladder acts on.
//   * not externally visible: no person receives anything. Contrast `send`,
//     which is still not a tool for this identity — the planner PROPOSES it and
//     code performs it after the loop, through applyDecision.
// What IS novel, and has no precedent here: this is the first model call that
// mutates durable state from INSIDE the tool loop, with no post-loop validation
// stage between the model's words and the row. `applyDecision` re-checks every
// rail after runLoop returns; a memory write has only the rails in
// src/teamLead/memory.ts and the table's own CHECK.
//
// `query_spine` was REMOVED 2026-08-19 rather than kept: it sat here from the
// start but was provably unreachable — `spine:team-lead` has no roster row, so
// the manager-tier gate that follows this one refused it every time. A name on
// an allowlist that cannot dispatch is a lie about what this identity can do.
// `spine_read` (src/mcp/server.ts, TEAM_LEAD_TOOLS) is the reachable
// replacement: the same read, under a name that is not an admin tool.
export const TEAM_LEAD_TOOL_NAMES: ReadonlySet<string> = new Set([
  'spine_read',
  // The planner's own decision history (Phase 4). Deny-by-default means a
  // tool absent from this set cannot dispatch no matter what schema the loop
  // was handed — so the two lists must be added to together.
  'recall_decisions',
  // The planner's own notes (build 3). BOTH LISTS, together: the research for
  // that build found get_customer_context and resolve_date sitting on this one
  // with no schema in TEAM_LEAD_TOOLS, which is the half-added state a name on
  // an allowlist can silently rot into. A test now pins the pairing.
  'read_memory',
  'write_memory',
  // Per-job notepads (plan 2026-08-30). The SECOND write verb, admitted on the
  // same grounds as the first and one stronger: `write_job_note` cannot delete
  // at all — an empty note is refused rather than treated as a clear — so the
  // worst a bad call can do is replace prose that job_note_versions still holds.
  'read_job_note',
  'write_job_note',
  'get_customer_context',
  'resolve_date',
  // RUNG 10B — the FIRST verb that writes the customer record itself. Admitted
  // on the terms above: it can only touch the capture an open `inbound_unmatched`
  // item names, everything it writes cites that capture, and it is idempotent by
  // reading what already cites it (L1-pinned rows can never be deleted, so a
  // retry that minted twins would be permanent). BOTH LISTS, together.
  'record_caller',
]);
