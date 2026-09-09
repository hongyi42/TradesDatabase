// The calendar itself: three layouts over one payload.
//
// WHAT EACH VIEW IS FOR, because that decides what the columns are:
//   day   — columns are PEOPLE. This is the dispatch view: who is free at 2pm,
//           and dropping a card in another column hands the work over.
//   week  — columns are DAYS. This is the planning view: where the week is
//           thin. People become colour and initials, not columns.
//   month — cells are DAYS, chips only. This is the horizon view: it answers
//           "how full is the 21st", and it is a drop target for a date change,
//           not for a time change.
//
// CREW DEDUPING is the one rule easy to get wrong. The server emits ONE STOP
// PER PERSON in the team read, all sharing a visitId, precisely so the day
// view's lanes need no client logic. Every OTHER view therefore has to fold
// them back — a two-person trip is one trip on a week column, not two.

import { clockLabel, minutesOf, dayLabel } from './api.js';
import { colorsFor, employeeColors, initials } from './palette.js';

export const SNAP_MINUTES = 15;

// The visible band. Wider than a working day on purpose: work starts before
// seven and runs past six often enough that clipping either end would hide
// real rows, and the grid scrolls anyway.
const DEFAULT_START_MIN = 6 * 60;
const DEFAULT_END_MIN = 21 * 60;
// VERTICAL SCALE, px per minute: 1 = an hour is 60px tall. A pinch on a
// touch grid (iPad, user 2026-09-08) changes it and the device remembers.
// The grid draws every y as calc(minutes * var(--pxm)) so a pinch is one CSS
// variable write on the .grid element — no repaint mid-gesture.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_KEY = 'console.pxPerMin';
let pxPerMin = readZoom();
function readZoom() {
  try {
    const v = Number(window.localStorage.getItem(ZOOM_KEY));
    return v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1;
  } catch {
    return 1;
  }
}
export function zoom() {
  return pxPerMin;
}
export function setZoom(v) {
  pxPerMin = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(v) || 1));
  return pxPerMin;
}
export function saveZoom() {
  try {
    window.localStorage.setItem(ZOOM_KEY, String(pxPerMin));
  } catch {
    /* private mode: the pinch lasts the session */
  }
}
// A vertical extent in band minutes, as CSS.
const y = (minutes) => 'calc(' + minutes + ' * var(--pxm))';

export function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// The band actually drawn: the default one, widened to contain anything that
// falls outside it. A visit at 05:30 must be visible and draggable, not cropped
// to the top edge where it would look like an 06:00 start.
export function bandFor(stops) {
  let lo = DEFAULT_START_MIN;
  let hi = DEFAULT_END_MIN;
  for (const s of stops) {
    lo = Math.min(lo, Math.floor(minutesOf(s.start) / 60) * 60);
    hi = Math.max(hi, Math.ceil(minutesOf(s.end) / 60) * 60);
  }
  return { lo: Math.max(0, lo), hi: Math.min(24 * 60, Math.max(hi, lo + 120)) };
}

// One entry per VISIT (the crew fold), keeping the whole crew for the card.
function foldCrew(stops) {
  const seen = new Map();
  for (const s of stops) if (!seen.has(s.visitId)) seen.set(s.visitId, s);
  return [...seen.values()];
}

function dayMap(data) {
  const m = new Map();
  for (const day of data.days || []) m.set(day.date, day.stops || []);
  return m;
}

// Side-by-side packing for stops that share time in one column. Greedy and
// deliberately simple: sort by start, put each stop in the first lane whose
// last stop has finished. Two overlapping visits render half-width each rather
// than one hiding the other — an invisible visit is a double-booking nobody
// sees.
function pack(stops) {
  const sorted = stops.slice().sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
  const lanes = [];
  const placed = [];
  for (const s of sorted) {
    const start = minutesOf(s.start);
    let lane = lanes.findIndex((end) => end <= start);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(0);
    }
    lanes[lane] = minutesOf(s.end);
    placed.push({ stop: s, lane: lane });
  }
  return { placed: placed, laneCount: Math.max(1, lanes.length) };
}

function crewChips(stop) {
  if (!stop.technicianRefs || !stop.technicianRefs.length) {
    return '<span class="chip chip-none" title="nobody assigned">–</span>';
  }
  return stop.technicianRefs
    .map((ref, i) => {
      const name = (stop.technicianNames && stop.technicianNames[i]) || ref;
      return (
        '<span class="chip" style="background:' +
        employeeColors(ref).solid +
        '" title="' +
        esc(name) +
        '">' +
        esc(initials(name)) +
        '</span>'
      );
    })
    .join('');
}

// The card. `data-*` carries everything a drag needs to describe itself to the
// server without a second read: the visit, its job, its day, and the span it is
// currently holding (so a move can preserve the length the manager already set).
function cardAttrs(stop, date) {
  return (
    ' data-visit-id="' + esc(stop.visitId) + '"' +
    ' data-status="' + esc(stop.status || '') + '"' +
    ' data-job-id="' + esc(stop.jobId || '') + '"' +
    ' data-date="' + esc(date) + '"' +
    ' data-start="' + esc(stop.start.slice(11, 16)) + '"' +
    ' data-end="' + esc(stop.end.slice(11, 16)) + '"' +
    ' data-span="' + (minutesOf(stop.end) - minutesOf(stop.start)) + '"' +
    ' data-crew="' + esc((stop.technicianRefs || []).join(',')) + '"'
  );
}

// A completed trip is history: drawn so the week reads as what happened,
// greyed so it cannot be mistaken for work still to do, and never draggable —
// the server refuses to move or cancel it anyway ("cannot move a completed
// visit"), so offering the gesture would only end in a refusal toast.
function isDone(stop) {
  return stop.status === 'completed';
}
const DONE_MARK = '<span class="done-mark" title="completed">✓</span>';

function timedCard(stop, date, ctx, geom) {
  const c = colorsFor(ctx.colorBy, stop);
  const startMin = minutesOf(stop.start);
  const span = Math.max(SNAP_MINUTES, minutesOf(stop.end) - startMin);
  const top = y(startMin - geom.lo);
  const width = 100 / geom.laneCount;
  const title = stop.customer || stop.jobTitle || 'Visit';
  const done = isDone(stop);
  const drag = ctx.canDrag && !done;
  return (
    '<div class="card' + (drag ? ' draggable' : '') + (done ? ' is-done' : '') + '"' +
    (drag ? ' draggable="true"' : '') +
    cardAttrs(stop, date) +
    ' style="top:' + top + ';height:' + y(span) + ';' +
    'left:' + geom.lane * width + '%;width:calc(' + width + '% - 4px);' +
    'background:' + c.tint + ';border-left-color:' + c.solid + '">' +
    '<div class="card-time">' + (done ? DONE_MARK : '') + esc(clockLabel(startMin)) + '</div>' +
    '<div class="card-title">' + esc(title) + '</div>' +
    (stop.jobTitle && stop.customer
      ? '<div class="card-sub">' + esc(stop.jobTitle) + '</div>'
      : '') +
    (stop.address ? '<div class="card-sub">' + esc(stop.address) + '</div>' : '') +
    '<div class="card-crew">' + crewChips(stop) + '</div>' +
    '</div>'
  );
}

function hourGutter(band) {
  let html = '<div class="gutter">';
  for (let m = band.lo; m < band.hi; m += 60) {
    html +=
      '<div class="hour-label" style="top:' + y(m - band.lo) + '">' +
      esc(clockLabel(m)) + '</div>';
  }
  return html + '</div>';
}

function hourLines(band) {
  let html = '';
  for (let m = band.lo; m < band.hi; m += 60) {
    html += '<div class="hour-line" style="top:' + y(m - band.lo) + '"></div>';
  }
  return html;
}

// ── Day: columns are people ──────────────────────────────────────────────────
function renderDayView(ctx) {
  const date = ctx.anchor;
  const stops = dayMap(ctx.data).get(date) || [];
  const band = bandFor(stops);
  const height = y(band.hi - band.lo);

  // The Unassigned column comes FIRST and always exists: it is where a visit
  // with nobody on it is visible, and it is the drop target that takes a person
  // back off a trip. Hiding it when empty would remove the only place that
  // gesture can land.
  const columns = [{ ref: null, name: 'Unassigned' }].concat(
    (ctx.data.roster || []).filter((t) => ctx.visibleRefs.has(t.ref)),
  );
  // A stop whose person is not in the roster list still needs a column, or the
  // work is invisible on the one view that claims to show the whole day. Two
  // ways that happens: a TECHNICIAN opened the console (the server sends no
  // roster to them, only their own stops), and a visit still carrying somebody
  // who has since left the active roster. Named from the stop itself.
  const known = new Set(columns.map((c) => c.ref));
  for (const s of stops) {
    if (s.technicianRef && !known.has(s.technicianRef) && !ctx.hiddenRefs.has(s.technicianRef)) {
      known.add(s.technicianRef);
      columns.push({ ref: s.technicianRef, name: s.technicianName || s.technicianRef });
    }
  }

  let html =
    '<div class="grid grid-day" style="--pxm:' + pxPerMin + 'px;--band-height:' + height + '">' +
    '<div class="grid-head"><div class="gutter-head"></div>';
  for (const col of columns) {
    const c = employeeColors(col.ref);
    html +=
      '<div class="col-head">' +
      '<span class="chip chip-head" style="background:' + c.solid + '">' +
      esc(col.ref ? initials(col.name) : '–') +
      '</span><span class="col-name">' + esc(col.name) + '</span></div>';
  }
  html += '</div><div class="grid-body">' + hourGutter(band);

  for (const col of columns) {
    const mine = stops.filter((s) =>
      col.ref === null ? s.unassigned : s.technicianRef === col.ref,
    );
    const packed = pack(mine);
    html +=
      '<div class="col slot-target" data-date="' + esc(date) + '"' +
      ' data-tech-ref="' + esc(col.ref || '') + '"' +
      ' data-band-lo="' + band.lo + '" style="height:' + height + '">' +
      hourLines(band);
    for (const p of packed.placed) {
      html += timedCard(p.stop, date, ctx, {
        lo: band.lo,
        lane: p.lane,
        laneCount: packed.laneCount,
      });
    }
    html += '</div>';
  }
  return html + '</div></div>';
}

// ── Week: columns are days ───────────────────────────────────────────────────
function renderWeekView(ctx) {
  const byDate = dayMap(ctx.data);
  const dates = ctx.dates;
  const all = [];
  for (const d of dates) for (const s of visibleStops(byDate.get(d) || [], ctx)) all.push(s);
  const band = bandFor(all);
  const height = y(band.hi - band.lo);

  let html =
    '<div class="grid grid-week" style="--pxm:' + pxPerMin + 'px;--band-height:' + height + '">' +
    '<div class="grid-head"><div class="gutter-head"></div>';
  for (const d of dates) {
    html +=
      '<div class="col-head' + (d === ctx.today ? ' is-today' : '') + '">' +
      '<span class="col-name">' + esc(dayLabel(d, 'short')) + '</span></div>';
  }
  html += '</div><div class="grid-body">' + hourGutter(band);

  for (const d of dates) {
    // Crew fold: columns are days here, so one trip is one card no matter how
    // many people are on it.
    const mine = foldCrew(visibleStops(byDate.get(d) || [], ctx));
    const packed = pack(mine);
    html +=
      '<div class="col slot-target' + (d === ctx.today ? ' is-today' : '') + '"' +
      ' data-date="' + esc(d) + '" data-band-lo="' + band.lo + '"' +
      ' style="height:' + height + '">' +
      hourLines(band);
    for (const p of packed.placed) {
      html += timedCard(p.stop, d, ctx, { lo: band.lo, lane: p.lane, laneCount: packed.laneCount });
    }
    html += '</div>';
  }
  return html + '</div></div>';
}

// ── Month: cells are days ────────────────────────────────────────────────────
function renderMonthView(ctx) {
  const byDate = dayMap(ctx.data);
  const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let html = '<div class="grid grid-month"><div class="month-head">';
  for (const h of heads) html += '<div class="month-dow">' + h + '</div>';
  html += '</div><div class="month-body">';

  for (const d of ctx.dates) {
    const stops = foldCrew(visibleStops(byDate.get(d) || [], ctx));
    stops.sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    const outside = d.slice(0, 7) !== ctx.anchor.slice(0, 7);
    html +=
      '<div class="month-cell slot-target' +
      (outside ? ' is-outside' : '') +
      (d === ctx.today ? ' is-today' : '') +
      '" data-date="' + esc(d) + '" data-month-cell="1">' +
      '<div class="month-date">' + Number(d.slice(8, 10)) + '</div>';
    // Four chips then a count: a cell that lists twelve visits stops being a
    // horizon view and becomes an unreadable list.
    for (const s of stops.slice(0, 4)) {
      const c = colorsFor(ctx.colorBy, s);
      const done = isDone(s);
      const drag = ctx.canDrag && !done;
      html +=
        '<div class="month-chip' + (drag ? ' draggable' : '') + (done ? ' is-done' : '') + '"' +
        (drag ? ' draggable="true"' : '') +
        cardAttrs(s, d) +
        ' style="background:' + c.tint + ';border-left-color:' + c.solid + '">' +
        '<span class="month-chip-time">' + (done ? DONE_MARK : '') +
        esc(clockLabel(minutesOf(s.start))) + '</span> '  +
        esc(s.customer || s.jobTitle || 'Visit') +
        '</div>';
    }
    if (stops.length > 4) {
      html += '<div class="month-more">+' + (stops.length - 4) + ' more</div>';
    }
    html += '</div>';
  }
  return html + '</div></div>';
}

// The employee filter, applied to STOPS rather than to columns, because week
// and month have no per-person column to hide.
//
// It hides on the EXPLICIT list, not on the visible one — "did the manager
// untick this person" rather than "is this person in the roster payload". The
// difference is not cosmetic: a technician's own console is sent no roster at
// all, and an is-it-in-the-roster test would hide every one of their own stops
// and show them an empty week. It also keeps a departed roster member's
// remaining trips on screen instead of quietly dropping them.
//
// An unassigned stop is never filtered: it belongs to nobody, so no checkbox
// owns it, and hiding it would hide exactly the work most in need of a
// decision.
function visibleStops(stops, ctx) {
  return stops.filter((s) => !s.technicianRef || !ctx.hiddenRefs.has(s.technicianRef));
}

export function renderCalendar(ctx) {
  if (ctx.view === 'day') return renderDayView(ctx);
  if (ctx.view === 'month') return renderMonthView(ctx);
  return renderWeekView(ctx);
}

// Where in the day a pointer landed, snapped. Reads the column's own band
// origin from the DOM so the caller never has to keep geometry in state that
// could drift from what is drawn.
export function minutesAtPointer(colEl, clientY) {
  const rect = colEl.getBoundingClientRect();
  const lo = Number(colEl.getAttribute('data-band-lo') || 0);
  const raw = lo + (clientY - rect.top) / pxPerMin;
  const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
  return Math.max(0, Math.min(24 * 60 - SNAP_MINUTES, snapped));
}

export { foldCrew, cardAttrs, crewChips, isDone, DONE_MARK };
