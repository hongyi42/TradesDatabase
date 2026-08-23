// The date-eval's anchored clock (2026-08-23). EVAL_FAKE_NOW=<tenantId>:<ISO
// instant> pins the spine's notion of "now" for EXACTLY ONE tenant — the eval
// world — so the adversarial clock regime (the box's UTC day disagreeing with
// the firm's local day) can be manufactured at ANY wall-clock hour instead of
// waiting for a US evening. The box's own clock is deliberately left real: its
// disagreement with the anchored rider IS the condition under test.
//
// Scope is the entire safety story, so it fails closed three ways: the flag
// names one tenant id and must match the requesting tenant exactly; every
// other tenant gets the real clock; and any parse failure gets the real clock.
// Split on the FIRST ':' — a uuid contains none, an ISO instant several.
// Never set in normal operation.
export function spineNowIso(tenantId: string): string {
  const raw = process.env.EVAL_FAKE_NOW;
  if (!raw) return new Date().toISOString();
  const cut = raw.indexOf(':');
  if (cut <= 0 || raw.slice(0, cut) !== tenantId) return new Date().toISOString();
  const t = Date.parse(raw.slice(cut + 1));
  if (Number.isNaN(t)) return new Date().toISOString();
  return new Date(t).toISOString();
}
