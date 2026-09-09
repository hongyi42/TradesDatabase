// Colour-by, the console's one piece of pure presentation.
//
// Employee colours are DERIVED from the roster ref, not stored: a colour column
// would be a migration, a settings screen and a per-tenant conflict story for
// something the manager only needs in order to tell one column from another at
// a glance. Derivation buys stability for free — the same person is the same
// colour on every device, in every view, forever, with nothing to keep in sync.
//
// The cost is honest: two refs can land near each other on the wheel. The hue
// wheel is quantised into 16 well-separated stops rather than left continuous,
// so a near-collision is either the SAME stop (visibly identical, and the name
// on the card disambiguates) or a full step away — never the "are those two
// different?" middle ground that continuous hashing produces.

const HUE_STOPS = 16;

function hashString(s) {
  // FNV-1a, 32-bit. Chosen for being short, stable and well-spread on the tiny
  // inputs we have (roster refs are a handful of characters).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function hueFor(ref) {
  return Math.round((hashString(ref) % HUE_STOPS) * (360 / HUE_STOPS));
}

// One person, one colour, three roles: the solid chip, the tinted card body,
// and the text that has to stay legible on the tint.
export function employeeColors(ref) {
  if (!ref) {
    return { solid: 'var(--unassigned)', tint: 'var(--unassigned-tint)', ink: 'var(--ink)' };
  }
  const h = hueFor(ref);
  return {
    solid: 'hsl(' + h + ' 62% 42%)',
    tint: 'hsl(' + h + ' 62% 42% / 0.16)',
    ink: 'var(--ink)',
  };
}

// The other two modes reuse meanings the spine already has, so the legend does
// not need explaining: priority is the dispatcher's triage tier, status is the
// job state machine.
const PRIORITY_HUE = { emergency: 0, urgent: 28, routine: 210, maintenance: 150 };
const STATUS_HUE = {
  scheduled: 210,
  confirmed: 210,
  en_route: 260,
  in_progress: 42,
  completed: 145,
  cancelled: 0,
};

function fromHue(h) {
  return {
    solid: 'hsl(' + h + ' 62% 42%)',
    tint: 'hsl(' + h + ' 62% 42% / 0.16)',
    ink: 'var(--ink)',
  };
}

export function colorsFor(mode, stop) {
  if (mode === 'priority') {
    const h = PRIORITY_HUE[stop.priority];
    return h === undefined ? employeeColors(null) : fromHue(h);
  }
  if (mode === 'status') {
    const h = STATUS_HUE[stop.status];
    return h === undefined ? employeeColors(null) : fromHue(h);
  }
  return employeeColors(stop.technicianRef);
}

export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  const first = parts[0] ? parts[0][0] : '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}
