// The team-lead identity class (plan 2026-08-15 feature B, Phase 3; direction
// constraint 2). A reserved-namespace ref — `slugify` mints human refs over
// [a-z0-9-], so the ':' namespace can never collide with a roster row (the
// 'connector:' precedent). It lives in its own module because BOTH the MCP
// dispatch gate and the compose turn need it, and compose must not have to
// import the whole server to learn a constant.
export const TEAM_LEAD_REF = 'spine:team-lead';

// The identity's ENTIRE tool surface, v1: read/ask only ("stage" verbs are a
// future, separate decision). The dispatch gate denies the whole `spine:`
// namespace anything NOT in this set — deny-by-default, so a forgotten entry
// fails closed (targetGuard doctrine). There is no human behind this identity
// to confirm anything, so nothing irreversible or externally visible may ever
// dispatch for it; enforcement is mechanism (the gate), never prompt text.
export const TEAM_LEAD_TOOL_NAMES: ReadonlySet<string> = new Set([
  'query_spine',
  'get_customer_context',
  'resolve_date',
]);
