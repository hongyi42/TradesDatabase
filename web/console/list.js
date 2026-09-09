// The SMALL tree: what the console draws when the viewport is a phone.
//
// One day at a time, as a list grouped by technician — the board's shape,
// because the board IS the phone UI and this is what lets the cutover delete
// it. No drag: HTML5 drag never fires on touch, so every move here goes
// through the "Move…" form in the long-press menu. Month is a 7-column grid
// of dots — enough to see load and jump to a day, not enough to read titles.
//
// Rows carry the SAME data attributes as the grid's cards (cardAttrs), so the
// menu, the detail sheet and the undo entries work on either tree unchanged.
import { esc, cardAttrs, crewChips, isDone, DONE_MARK } from './grid.js';
import { colorsFor, employeeColors, initials } from './palette.js';
import { minutesOf, clockLabel, weekdayIndex } from './api.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function renderList(ctx) {
  return ctx.view === 'month' ? monthDots(ctx) : dayList(ctx);
}

function dayList(ctx) {
  const date = ctx.anchor;
  const day = (ctx.data.days || []).find((d) => d.date === date);
  const stops = (day ? day.stops : []).filter(
    (s) => !(s.technicianRef && ctx.hiddenRefs.has(s.technicianRef)),
  );

  // Group by person, roster order first, strangers next, nobody last.
  const groups = new Map();
  for (const s of stops) {
    const k = s.technicianRef || '';
    if (!groups.has(k)) groups.set(k, { ref: k, name: s.technicianName || null, stops: [] });
    groups.get(k).stops.push(s);
  }
  const roster = ctx.data.roster || [];
  const order = roster.map((t) => t.ref).filter((r) => groups.has(r));
  for (const k of groups.keys()) if (k && !order.includes(k)) order.push(k);
  if (groups.has('')) order.push('');

  const canAdd = ctx.canWrite && date >= ctx.today;
  // TRIPS, not people: a two-person visit is listed under both names below,
  // but it is one visit, one drive, one customer waiting.
  const trips = new Set(stops.map((s) => s.visitId)).size;
  let html =
    '<div class="list-day" data-date="' + esc(date) + '">' +
    '<div class="list-head"><span class="list-count">' +
    (trips ? trips + (trips === 1 ? ' visit' : ' visits') : 'Nothing on the books') +
    '</span>' +
    (canAdd ? '<button type="button" class="btn btn-primary" data-new-job>+ New job</button>' : '') +
    '</div>';

  if (!stops.length) {
    html += '<p class="hint list-empty">Nothing scheduled for this day.</p>';
  }
  for (const k of order) {
    const g = groups.get(k);
    g.stops.sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    const who = k ? g.name || k : 'Unassigned';
    html +=
      '<section class="list-group">' +
      '<h3 class="list-who">' +
      '<span class="chip chip-head' + (k ? '' : ' chip-none') + '" style="background:' +
      (k ? employeeColors(k).solid : 'var(--unassigned)') + '">' + esc(k ? initials(who) : '–') + '</span>' +
      '<span>' + esc(who) + '</span><span class="count">' + g.stops.length + '</span>' +
      '</h3>';
    for (const s of g.stops) html += listRow(s, date, ctx);
    html += '</section>';
  }
  return html + '</div>';
}

function listRow(stop, date, ctx) {
  const c = colorsFor(ctx.colorBy, stop);
  const done = isDone(stop);
  const title = stop.customer || stop.jobTitle || 'Visit';
  return (
    '<div class="card list-card' + (done ? ' is-done' : '') + '"' +
    cardAttrs(stop, date) +
    ' style="background:' + c.tint + ';border-left-color:' + c.solid + '">' +
    '<div class="list-time">' + (done ? DONE_MARK : '') +
    esc(clockLabel(minutesOf(stop.start))) + '–' + esc(clockLabel(minutesOf(stop.end))) + '</div>' +
    '<div class="list-main"><div class="card-title">' + esc(title) + '</div>' +
    (stop.jobTitle && stop.customer ? '<div class="card-sub">' + esc(stop.jobTitle) + '</div>' : '') +
    (stop.address ? '<div class="card-sub">' + esc(stop.address) + '</div>' : '') +
    '</div>' +
    '<div class="card-crew">' + crewChips(stop) + '</div>' +
    '</div>'
  );
}

function monthDots(ctx) {
  const byDate = new Map();
  for (const d of ctx.data.days || []) byDate.set(d.date, d.stops);
  let html = '<div class="mini-month" data-month-list="1">';
  for (const d of DOW) html += '<div class="mini-dow">' + d + '</div>';
  for (const d of ctx.dates) {
    // One dot per TRIP (a two-person visit is one visit), first three, then a
    // count — a cell is a thumbnail, not a list.
    const seen = new Set();
    const trips = [];
    for (const s of byDate.get(d) || []) {
      if (s.technicianRef && ctx.hiddenRefs.has(s.technicianRef)) continue;
      if (seen.has(s.visitId)) continue;
      seen.add(s.visitId);
      trips.push(s);
    }
    const outside = d.slice(0, 7) !== ctx.anchor.slice(0, 7);
    html +=
      '<button type="button" class="mini-cell' +
      (outside ? ' is-outside' : '') + (d === ctx.today ? ' is-today' : '') +
      '" data-date="' + esc(d) + '" aria-label="' + esc(DOW[weekdayIndex(d)] + ' ' + d) + '">' +
      '<span class="mini-date">' + Number(d.slice(8, 10)) + '</span>' +
      '<span class="mini-dots">' +
      trips
        .slice(0, 3)
        .map((s) => '<span class="mini-dot" style="background:' + colorsFor(ctx.colorBy, s).solid + '"></span>')
        .join('') +
      (trips.length > 3 ? '<span class="mini-more">+' + (trips.length - 3) + '</span>' : '') +
      '</span></button>';
  }
  return html + '</div>';
}
