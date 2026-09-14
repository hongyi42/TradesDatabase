// The tool surface each badge tier is supposed to see, written down BY NAME.
//
// Why this file exists (2026-09-12). The surface used to be pinned with
// `expect(names).toHaveLength(17)` and `toHaveLength(43)` in four places in
// src/mcp/server.test.ts, plus `expect(names.length).toBe(43)` in
// src/eval/toolCases.test.ts. Every feature that added a tool had to move all
// five numbers, so two features each adding one tool both edited the same lines
// and "both pass alone and are wrong together" — the parallel-work verdict of
// 2026-07-04, still true on 2026-09-09 when the hub was measured
// (research 2026-09-09 code-graph-as-source-of-truth §6.1 fix 1).
//
// A name list is the fix. Adding a tool now means inserting one name into one
// sorted list, which two branches can do at different lines and git can merge;
// and the list says what a count only implied — WHICH doors a tier has.
//
// The must-NOT-see half matters as much, and is what the counts were really
// protecting: `toHaveLength(17)` failed when an admin tool leaked into the
// technician catalog, but it said "expected 18 to be 17" rather than naming the
// door that opened. These lists make a leak fail by name.
//
// Kept deliberately INDEPENDENT of the tool tables: this is the expectation, not
// a derivation from the thing under test. Comparing the server's output to the
// server's own array would pass no matter what either contained.

/** What every badge sees, manager or not (the hub's `TOOLS`). */
export const TECHNICIAN_TOOLS = [
  'answer_customer_question',
  'ask_team_lead', // the Q&A desk (build 5.5 Phase 2)
  'brief_customer',
  'find_customer',
  'get_customer_context',
  'get_job',
  'get_schedule', // the technician route view — hidden from managers, see below
  'inform_team_lead', // the planner's inbox, inbound half (build 5.5)
  'inform_teammate', // seat-to-seat informs (build 5.5 Phase 3)
  'list_recent_captures',
  'read_webpage',
  'record_field_note',
  'record_standing_fact',
  'resolve_date',
  'retract_capture',
  'send_email',
  'web_search',
] as const;

/** Manager-tier only (the hub's `ADMIN_TOOLS`): a technician badge must see none of these. */
export const MANAGER_ONLY_TOOLS = [
  'add_technician_seat',
  'add_time_off',
  'bind_telegram',
  'book_visit',
  'cancel_job', // the terminal verb (2026-07-25)
  'deactivate_technician_seat',
  'find_slots',
  'get_availability', // the read half of set_availability (2026-08-04)
  'get_connect_link',
  'get_team_schedule',
  'list_pending_reviews',
  'list_team',
  'move_visit',
  'open_job', // rung 10: open a job without also booking a visit
  'query_spine', // ad-hoc read fallback (2026-08-06)
  'reactivate_technician_seat',
  'record_money_event', // the money ledger (2026-08-15)
  'remove_time_off',
  'resolve_review',
  'set_availability',
  'set_firm_profile', // firm identity (2026-08-15)
  'set_job_duration',
  'set_technician_horizon',
  'set_technician_skills',
  'unschedule_visit',
  'update_job',
] as const;

/**
 * The planner's own tools, in the order it is handed them. Order is load-bearing
 * here and nowhere else on this page: TEAM_LEAD_TOOL_SCHEMAS goes into the
 * planner's prompt, and tool order is part of what that prompt caches on.
 */
export const TEAM_LEAD_TOOLS_EXPECTED = [
  'spine_read',
  'recall_decisions',
  'read_memory',
  'write_memory',
  'read_job_note',
  'write_job_note',
  'record_caller',
] as const;

/**
 * Team-lead doors an active MANAGER badge may also reach (rung 10b.2). A door the
 * manager's seat cannot see is a door it will not use, which is exactly how the
 * 2026-09-08 answer went through record_field_note and left a customer whose
 * address was her own name.
 */
export const SEAT_SHARED_TOOLS = ['record_caller'] as const;

/** Team-lead doors NO badge may see: refused to every non-`spine:` identity. */
export const TEAM_LEAD_ONLY_TOOLS = TEAM_LEAD_TOOLS_EXPECTED.filter(
  (n) => !(SEAT_SHARED_TOOLS as readonly string[]).includes(n),
);

/**
 * The manager catalog: the base surface MINUS get_schedule, PLUS the admin tools,
 * PLUS the shared team-lead doors (user decision 2026-07-19). get_schedule is the
 * technician driving-route view; hiding it leaves managers exactly one schedule
 * read — get_team_schedule, which includes visits they hold themselves — so the
 * misroute that reported "your week is completely clear" while an unassigned visit
 * existed (live, 2026-07-18) is structurally impossible.
 */
export const MANAGER_TOOLS_EXPECTED = [
  ...TECHNICIAN_TOOLS.filter((n) => n !== 'get_schedule'),
  ...MANAGER_ONLY_TOOLS,
  ...SEAT_SHARED_TOOLS,
];

/** Every badge-reachable name: what the eval's coverage gate must cover. */
export const BADGE_TOOLS = [...TECHNICIAN_TOOLS, ...MANAGER_ONLY_TOOLS];
