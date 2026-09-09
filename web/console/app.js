// The dispatch console's shell: state, toolbar, the left rail, drag-and-drop,
// and the right-click menu. The grid itself is grid.js; the forms are
// jobModal.js; nothing here talks to the network except through api.js.
//
// WHAT MAKES A WRITE LEGAL, in one place (`actionable`), because the answer is
// not "is the user a manager":
//   manager tier  — the server enforces it too; this only keeps the gestures
//                   off surfaces that would always 403.
//   not the past  — the server has the same floor. A live drop target on
//                   yesterday is a one-mis-drag rewrite of history, and the
//                   deliberate correction stays a chat job.
// Every drag handle and every menu item is gated on it, never on tier alone.

import {
  addDays,
  addMonths,
  api,
  ApiError,
  dayLabel,
  hhmm,
  mondayOf,
  monthGrid,
  monthName,
  ymdToUTC,
} from './api.js';
import { minutesAtPointer, renderCalendar, esc, zoom, setZoom, saveZoom, SNAP_MINUTES } from './grid.js';
import { renderList } from './list.js';
import { employeeColors, initials } from './palette.js';
import { openEditJob, openMoveVisit, openNewJob, retireHost } from './jobModal.js';

const tg = window.Telegram && window.Telegram.WebApp;
const root = document.getElementById('app');
// The shell can take focus (no tab stop) so keyboard shortcuts land in THIS
// document after a Telegram popup: the client draws showConfirm in the parent
// window, and when it closes, focus stays there — the next Ctrl+Z went to
// Telegram, not to the console, until the manager clicked the grid
// (2026-09-07 report: "the second shortcut has no effect"). refocus() is
// called after every popup answer and every undo.
root.tabIndex = -1;
function refocus() {
  try {
    window.focus();
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected || a === root) root.focus({ preventScroll: true });
  } catch {
    /* a client that refuses programmatic focus loses nothing but the shortcut */
  }
}

const state = {
  view: 'day',
  colorBy: 'employee',
  anchor: null, // YYYY-MM-DD, the day/week/month the pager is on
  today: null, // firm-local, from the server — never from the browser clock
  tier: null,
  data: null,
  visibleRefs: new Set(),
  hiddenRefs: new Set(), // the unticked ones; survives a roster refresh
  rosterFilter: '',
  // The tray's own search — separate from the technician filter below it.
  trayFilter: '',
  // Fold state per section, and whether "show N more" has been pressed.
  traySections: { parked: true, jobs: true },
  trayShowAll: { parked: false, jobs: false },
  loading: false,
  // The tray drawer. null = FOLLOW THE WIDTH at every paint (open where a rail
  // fits beside the grid, closed on a phone where they would fight for height);
  // true/false = the manager toggled it, and that sticks. Decided per render,
  // not at boot: Telegram Desktop opens the popup small and the manager then
  // drags it wide or goes fullscreen — a boot-time answer left the rail hidden
  // on a 1900px window (2026-09-07 preview finding).
  railOpen: null,
  // The range `data` was fetched for. Any mismatch with what render() is about
  // to draw means the load for THIS page failed — say so instead of drawing an
  // empty day.
  dataRange: null,
  // The undo stack: one entry per write this tab made, newest last. Each entry
  // knows how to reverse ITS write and what the visit should look like now if
  // nobody else has touched it since. Lives in memory only — a reload forgets
  // it, which is the honest scope: "I just did that by mistake".
  undo: [],
};
const UNDO_DEPTH = 20;
// What the last paint showed — the canvas scroll is restored only when the
// next paint is the same page (a tick in the roster, a write's refresh), not
// when the manager has paged to another day or view.
let lastPaint = null;

const RAIL_MIN_WIDTH = 600;
// WHICH TREE. Decided at every paint, never once at boot: the Mini App
// measures its own iframe, and Telegram Web opens that at ~420px inside a
// 1900px window (the rail learned this the hard way, 2026-09-07). Width
// decides; two signals can only VETO towards "big": the desktop apps, and a
// real mouse — a laptop in Telegram Web's small popup is still a laptop.
// A touch iPad is big without a mouse: it gets the grid, minus drag (the
// Move… form is the floor on every tree).
function layout() {
  const platform = tg && tg.platform;
  const desktopApp = platform === 'tdesktop' || platform === 'macos';
  return desktopApp || finePointer() || window.innerWidth >= 768 ? 'grid' : 'list';
}

// A fine pointer (mouse, trackpad) is what HTML5 drag is for. Touch never
// gets `draggable`: on Android a long press on a draggable row starts a
// native drag whose `dragend` may never come (2026-09-08 report: a tray row
// went grey after a long press and stayed grey), and on an iPad the lift
// would race the long-press menu. The Move… form is the touch route.
function finePointer() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );
}
// The class + attribute pair a draggable element carries, or nothing.
function dragBits() {
  return finePointer() ? { cls: ' draggable', attr: ' draggable="true"' } : { cls: '', attr: '' };
}

function railVisible() {
  // The tray is a manager's surface: the toggle and the scrim that close it are
  // both manager-only, so a technician showing one at exactly 600px would get a
  // bottom sheet with no way out (review finding 2026-09-09).
  if (!isManager()) return false;
  return state.railOpen === null ? window.innerWidth >= RAIL_MIN_WIDTH : state.railOpen;
}
// Where the CSS makes the rail a bottom sheet: @media (max-width: 600px).
const SHEET_MAX_WIDTH = 600;
function sheetShown() {
  return isManager() && railVisible() && window.innerWidth <= SHEET_MAX_WIDTH;
}
function motionOk() {
  return !(
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// The default length for a job whose duration was never stated. Used ONLY to
// size a drag preview when the tray row says nothing — the server records the
// span the drop actually produced, so this is a UI default, not an invented
// fact stored anywhere.
const FALLBACK_SPAN = 60;

function isManager() {
  return state.tier === 'manager';
}

function actionable(date) {
  return isManager() && date >= state.today;
}

// ── Range for the current view ───────────────────────────────────────────────
function range() {
  if (state.view === 'day') return { from: state.anchor, to: state.anchor };
  if (state.view === 'month') return monthGrid(state.anchor);
  const mon = mondayOf(state.anchor);
  return { from: mon, to: addDays(mon, 6) };
}

function datesOf(r) {
  const out = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

function title() {
  if (state.view === 'day') return dayLabel(state.anchor, 'long');
  if (state.view === 'month') return monthName(state.anchor) + ' ' + state.anchor.slice(0, 4);
  const r = range();
  return dayLabel(r.from, 'short') + ' – ' + dayLabel(r.to, 'short') + ', ' + r.to.slice(0, 4);
}

function step(dir) {
  if (state.view === 'day') state.anchor = addDays(state.anchor, dir);
  else if (state.view === 'week') state.anchor = addDays(mondayOf(state.anchor), dir * 7);
  else state.anchor = addMonths(state.anchor, dir);
  load();
}

// ── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, kind, action) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast' + (kind === 'error' ? ' toast-error' : '');
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.hidden = true;
      action.fn();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  window.clearTimeout(toastTimer);
  // Errors stay longer: a refusal is something to read, not something to catch
  // out of the corner of an eye. A toast with an Undo on it stays longer
  // still — it is the moment the mistake is cheapest to take back.
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 7000 : action ? 8000 : 3200);
}

// ── Undo ─────────────────────────────────────────────────────────────────
//
// Every write on this surface is reversible by another write the server
// already accepts — a park is a move with the old crew, a move is a move
// back, a booking is a cancel, a cancel is a re-book on the same job, an edit
// is an edit with the old values. So undo is CLIENT-SIDE: the gesture that
// made the change also records how to reverse it (user ask 2026-09-07: a
// two-person visit parked by mistake had no way back but memory).
//
// Two honesty rules:
//   * an entry checks the visit still looks like what its write produced
//     before reversing it — if a colleague moved it since, undo refuses
//     rather than clobbering their change;
//   * an undo goes through the same preview/confirm path as any write, so a
//     reversal that is customer-visible (re-cancelling a booking) still asks.
function pushUndo(entry) {
  state.undo.push(entry);
  if (state.undo.length > UNDO_DEPTH) state.undo.shift();
  syncUndoButton();
}

function syncUndoButton() {
  const btn = root.querySelector('[data-undo]');
  if (!btn) return;
  const top = state.undo[state.undo.length - 1];
  btn.disabled = !top;
  btn.title = top ? top.label + ' (Ctrl+Z)' : 'Nothing to undo';
  btn.setAttribute('aria-label', btn.title);
  const n = btn.querySelector('.count');
  if (n) n.textContent = state.undo.length ? String(state.undo.length) : '';
}

const crewKey = (refs) => (refs || []).slice().sort().join(',');

// "Is the visit still the way my write left it?" — null when yes, a sentence
// when not. Compares the minute and the crew, the two things a write changes.
async function expectVisit(visitId, expect) {
  let d;
  try {
    d = await api.visit(visitId);
  } catch (err) {
    // COULD NOT CHECK is not the same fact as "somebody changed it", and the
    // difference decides whether the undo survives: a dropped packet used to
    // eat the entry, so the manager's natural second press reached for an
    // OLDER write on a different visit (review finding 2026-09-09).
    return { retry: true, why: 'Could not check the visit — ' + err.message };
  }
  if (expect.status && d.status !== expect.status) {
    return 'Cannot undo — the visit is now ' + d.status;
  }
  if (expect.start !== undefined) {
    const now = d.start ? d.start.slice(0, 16) : null;
    if (now !== expect.start) {
      return 'Cannot undo — the visit has been moved since (now ' + (now || 'no time') + ')';
    }
  }
  if (expect.crew !== undefined && crewKey(d.technicianRefs) !== crewKey(expect.crew)) {
    return 'Cannot undo — the crew has been changed since';
  }
  return null;
}

// ONE undo at a time. Two in flight collide on the confirm: Telegram allows a
// single popup, so the second showConfirm throws, falls back to a browser
// confirm the webview answers "no" to, and the entry comes back with "Left as
// it is" — for a question nobody was asked (2026-09-07 report: the message
// appearing on a shortcut, then the shortcut dead until the first popup was
// answered). A press while one is running is remembered ONCE and runs after,
// so "Ctrl+Z, Ctrl+Z" still means two undos; key repeat is dropped at the
// keydown handler.
let undoBusy = false;
let undoQueued = false;
async function undoLast() {
  if (undoBusy) {
    undoQueued = true;
    return;
  }
  undoBusy = true;
  try {
    const entry = state.undo.pop();
    syncUndoButton();
    if (!entry) return;
    if (entry.guard) {
      const why = await entry.guard();
      if (why && why.retry) {
        // Put it back: nothing was applied and nothing was learned.
        state.undo.push(entry);
        syncUndoButton();
        toast(why.why, 'error', { label: 'Undo', fn: undoLast });
        undoQueued = false;
        return;
      }
      if (why) {
        toast(why, 'error');
        return;
      }
    }
    // Saying "no" at the confirm is not using the undo up — it stays on the
    // stack (2026-09-07 finding: one dismissed popup and the undo was gone).
    // A refusal or failure DOES consume it: the error is on the toast, and a
    // stuck entry would block every older undo behind it.
    const outcome = await entry.apply();
    if (outcome === 'declined') {
      state.undo.push(entry);
      syncUndoButton();
      toast('Left as it is — Undo is still available', null, { label: 'Undo', fn: undoLast });
      undoQueued = false; // a "no" answers the queued press too
    }
  } finally {
    undoBusy = false;
    refocus();
    if (undoQueued) {
      undoQueued = false;
      undoLast();
    }
  }
}

// The crew a move leaves behind, from the crew patch the gesture sent.
function crewAfter(before, patch) {
  if (patch.unassign) return [];
  if (patch.technicianRefs) return patch.technicianRefs.slice();
  if (patch.technicianRef) return [patch.technicianRef];
  return before ? before.slice() : [];
}

// Reverse a move/park: put the visit back on its old day, time and crew.
// `crew` null means the gesture did not know the old crew — no honest undo.
function undoMoveEntry(label, visitId, before, after) {
  if (!before.date || !before.start || before.crew === null) return null;
  const body = Object.assign(
    {
      visitId: visitId,
      date: before.date,
      startTime: before.start,
      reason: 'undo on the dispatch console',
    },
    before.end ? { endTime: before.end } : {},
    before.crew.length ? { technicianRefs: before.crew.slice() } : { unassign: true },
  );
  return {
    label: label,
    guard: () => expectVisit(visitId, { status: 'confirmed', start: after.start, crew: after.crew }),
    apply: () =>
      write(() => api.previewMove(body), () => api.move(body), 'Undone — back on ' + before.date + ' ' + before.start),
  };
}

// Reverse PLACING a parked visit: take the time off again (console-only
// verb), then put the old crew back if the drop changed it. Two writes,
// because "untime" keeps the crew on purpose — an untimed visit with people
// on it is a legal tray row — and the crew step is not customer-visible, so
// it needs no second confirm.
function undoUntimeEntry(visitId, beforeCrew, after) {
  if (beforeCrew === null) return null;
  const body = { visitId: visitId, reason: 'undo on the dispatch console' };
  return {
    label: 'Undo placing it (back to no time set)',
    guard: () => expectVisit(visitId, { status: 'confirmed', start: after.start, crew: after.crew }),
    apply: async () => {
      const ok = await write(
        () => api.previewUntime(body),
        () => api.untime(body),
        'Undone — back in the tray, no time set',
        (p) =>
          'Undo placing it? The ' + p.day + ' visit for ' + (p.customerName || 'this customer') +
          ' goes back to no time set.',
      );
      if (ok !== true || crewKey(beforeCrew) === crewKey(after.crew)) return ok;
      try {
        await api.move(
          Object.assign(
            { visitId: visitId, attachUnplaced: true, reason: 'undo on the dispatch console' },
            beforeCrew.length ? { technicianRefs: beforeCrew.slice() } : { unassign: true },
          ),
        );
      } catch (err) {
        toast('Time removed, but the crew could not be restored — ' + err.message, 'error');
      } finally {
        load();
      }
      return true;
    },
  };
}

// Reverse a booking: cancel the visit it created. Goes through the cancel
// preview, so a placed visit still asks — the customer may already have been
// told.
function undoBookEntry(booked, what) {
  if (!booked || !booked.visitId) return null;
  const body = { visitId: booked.visitId, reason: 'undo on the dispatch console — booked by mistake' };
  return {
    label: 'Undo booking',
    guard: () => expectVisit(booked.visitId, { status: 'confirmed' }),
    apply: () =>
      write(
        () => api.previewCancel(body),
        () => api.cancel(body),
        'Booking undone',
        () => 'Undo the booking? This cancels the visit just created' + (what ? ' for ' + what : '') + '.',
      ),
  };
}

// Reverse a cancel: book the same job again with the same day, time and crew.
// A cancelled row is terminal, so this is a NEW visit on the old job — same
// appointment as far as the customer is concerned.
function undoCancelEntry(prior) {
  if (!prior || !prior.jobId) return null;
  const body = Object.assign(
    { jobId: prior.jobId },
    prior.start
      ? { date: prior.start.slice(0, 10), startTime: prior.start.slice(11, 16) }
      : {},
    prior.start && prior.end ? { endTime: prior.end.slice(11, 16) } : {},
    prior.technicianRefs && prior.technicianRefs.length
      ? { technicianRefs: prior.technicianRefs.slice() }
      : {},
  );
  return {
    label: 'Undo cancel (book it again)',
    // Same rule as the other entries: if the visit we cancelled is no longer
    // cancelled, somebody else has dealt with this job and booking again would
    // make a SECOND appointment for one customer (review finding 2026-09-09).
    guard: prior.visitId ? () => expectVisit(prior.visitId, { status: 'cancelled' }) : undefined,
    apply: () => write(() => api.previewBook(body), () => api.book(body), 'Booked again'),
  };
}

// Reverse a job edit: write the old values of exactly the fields that changed.
function undoEditEntry(ctx) {
  if (!ctx || !ctx.patch || !ctx.previous) return null;
  const revert = { jobId: ctx.patch.jobId };
  if ('title' in ctx.patch && ctx.previous.title) revert.title = ctx.previous.title;
  if ('priority' in ctx.patch) revert.priority = ctx.previous.priority;
  if ('durationMinutes' in ctx.patch) revert.durationMinutes = ctx.previous.durationMinutes;
  if (Object.keys(revert).length === 1) return null;
  return {
    label: 'Undo job edit',
    // Only checkable when the job is on the calendar — a tray job has no visit
    // to read. Where it IS checkable, it stops an undo from silently reverting
    // a colleague's later edit as well as ours (review finding 2026-09-09).
    guard: ctx.visitId
      ? async () => {
          let d;
          try {
            d = await api.visit(ctx.visitId);
          } catch (err) {
            return { retry: true, why: 'Could not check the job — ' + err.message };
          }
          const changed =
            ('title' in ctx.patch && (d.jobTitle ?? null) !== (ctx.patch.title ?? null)) ||
            ('priority' in ctx.patch && d.priority !== ctx.patch.priority);
          return changed ? 'Cannot undo — the job has been edited since' : null;
        }
      : undefined,
    apply: async () => {
      try {
        await api.editJob(revert);
        toast('Job edit undone');
        return true;
      } catch (err) {
        toast(err instanceof ApiError ? err.message : String(err), 'error');
        return false;
      } finally {
        load();
      }
    },
  };
}

function afterEdit(msg, ctx) {
  const entry = undoEditEntry(ctx);
  if (entry) pushUndo(entry);
  toast(msg, null, entry ? { label: 'Undo', fn: undoLast } : null);
  load();
}

// The confirm is the console's OWN dialog, not Telegram's popup. Telegram
// draws its popup in the parent window: a second click meant for the Undo
// button landed on that popup's backdrop and dismissed it ("no"), the next
// keystroke went to the parent, and a popup requested while the last was
// still closing was refused — three ways a quick repeat produced "Left as it
// is" for a question nobody answered (2026-09-08). In-page, none of that
// applies: the backdrop does NOT dismiss (only the two buttons, Enter and
// Escape answer), Ctrl+Z is ignored while it is open (the keydown guard
// sees .modal-host), and focus never leaves this document.
function confirmAsk(text) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-host confirm-host';
    host.innerHTML =
      '<div class="modal-backdrop"></div>' +
      '<div class="modal confirm" role="alertdialog" aria-modal="true">' +
      '<div class="modal-body"><p class="confirm-text">' + esc(text) + '</p></div>' +
      '<div class="modal-foot">' +
      '<button type="button" class="btn" data-no>Keep it as it is</button>' +
      '<button type="button" class="btn btn-primary" data-yes>Go ahead</button>' +
      '</div></div>';
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      retireHost(host);
      resolve(ok);
      refocus();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    host.querySelector('[data-no]').addEventListener('click', () => done(false));
    host.querySelector('[data-yes]').addEventListener('click', () => done(true));
    document.body.appendChild(host);
    host.querySelector('[data-yes]').focus();
  });
}

// ── Load ─────────────────────────────────────────────────────────────────────
// SEQUENCED, because an empty calendar and a calendar we could not load look
// identical on screen and mean opposite things (review finding 2026-09-09).
// Two ways the old code drew a lie: a slow reply for Tuesday landing after a
// fast one for Wednesday overwrote Wednesday's data, and any failed load left
// the previous day's payload under the new day's heading. Both showed the
// manager an empty day for a day that had work on it.
//
// So: only the NEWEST load may touch state, and what is on screen carries the
// range it was fetched for. render() compares that range with the one being
// drawn and refuses to paint a mismatch.
let loadSeq = 0;
async function load() {
  const r = range();
  const seq = ++loadSeq;
  state.loading = true;
  render();
  try {
    const data = await api.calendar(r.from, r.to);
    if (seq !== loadSeq) return; // a newer load owns the screen now
    state.dataRange = r;
    state.data = data;
    state.today = data.today;
    state.tier = data.tier;
    // Roster visibility: everything on, minus whatever the manager has unticked
    // this session. Recomputed from the fresh roster so a new hire appears
    // ticked rather than silently invisible.
    state.visibleRefs = new Set(
      (data.roster || []).map((t) => t.ref).filter((ref) => !state.hiddenRefs.has(ref)),
    );
  } catch (err) {
    if (seq !== loadSeq) return;
    toast(err.message, 'error');
  } finally {
    if (seq === loadSeq) {
      state.loading = false;
      render();
    }
  }
}

// ── Left rail ────────────────────────────────────────────────────────────────
// The tray at scale (user decision 2026-09-07, option A): two sections that
// stay distinct, each foldable with a count, sorted so the thing that needs a
// decision is at the top, five rows then "show N more", compact one-line rows,
// and a filter box. The distinction between the sections is a recorded safety
// rule, not a layout choice: placing a parked VISIT replaces whatever crew is
// already on it; an unscheduled JOB has no visit at all.
const PRIORITY_RANK = { emergency: 0, urgent: 1, routine: 2, maintenance: 3 };
const PRIORITY_GLYPH = { emergency: '!', urgent: '^', maintenance: '·' };
// Rows shown per section before "show N more". Five is a glance; past that it
// is a list, and a list is what the filter box is for.
const TRAY_PAGE = 5;

function trayFilterHit(parts) {
  const q = state.trayFilter.trim().toLowerCase();
  if (!q) return true;
  return parts.some((p) => p && String(p).toLowerCase().indexOf(q) >= 0);
}

// Whole days since an ISO instant. This one IS a real timestamp (created_at),
// so Date arithmetic on it is legitimate — unlike stored days and times, which
// print verbatim.
function ageDays(iso) {
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400000)) : 0;
}

// Whole days a stored day sits behind firm-local today. UTC calendar
// arithmetic on two YYYY-MM-DD strings, never a timezone conversion.
function daysSince(ymd) {
  return Math.max(0, Math.round((ymdToUTC(state.today) - ymdToUTC(ymd)) / 86400000));
}

function fmtMinutes(m) {
  if (!m) return '—';
  return m % 60 === 0 ? m / 60 + 'h' : m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// Parked visits: a day that already slipped is the most forgettable row of all
// and goes first; then dated rows soonest-first; then the undated ones.
function sortParked(rows) {
  return rows.slice().sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (!!a.date !== !!b.date) return a.date ? -1 : 1;
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.customer || '').localeCompare(b.customer || '');
  });
}

// Jobs: triage tier, then OLDEST first inside a tier — a routine job that has
// sat for three weeks outranks one from this morning. ISO timestamps compare
// as strings in chronological order.
function sortJobs(rows) {
  return rows.slice().sort((a, b) => {
    const ra = PRIORITY_RANK[a.priority] ?? 9;
    const rb = PRIORITY_RANK[b.priority] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
}

function parkedRow(p) {
  const crew = (p.technicianRefs || [])
    .map((ref, i) => {
      const name = (p.technicianNames && p.technicianNames[i]) || ref;
      return (
        '<span class="chip chip-xs" style="background:' + employeeColors(ref).solid +
        '" title="' + esc(name) + '">' + esc(initials(name)) + '</span>'
      );
    })
    .join('');
  // A dated row is a PLACED visit with nobody on it — it has a time, and the
  // time is shown: it is what the manager keeps when they park and un-park
  // it, and what a drag onto the grid would replace.
  const when = p.startTime ? ' ' + esc(p.startTime) : '';
  const fact =
    p.overdue && p.date
      ? '<span class="fact fact-late">' + daysSince(p.date) + 'd late</span>' +
        '<span class="fact">' + esc(p.date.slice(5)) + when + '</span>'
      : p.date
        ? '<span class="fact">' + esc(p.date.slice(5)) + when + '</span>'
        : '<span class="fact">no date</span>';
  // The visit's own length when it has one, so a drop keeps it.
  const hm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const span =
    p.startTime && p.endTime ? Math.max(SNAP_MINUTES, hm(p.endTime) - hm(p.startTime)) : FALLBACK_SPAN;
  const tip =
    (p.customer || 'Unknown') + (p.jobTitle ? ' — ' + p.jobTitle : '') +
    (p.technicianNames && p.technicianNames.length
      ? ' · ' + p.technicianNames.join(', ') + ' assigned (placing it replaces them)'
      : ' · nobody assigned');
  return (
    '<div class="tray-item tray-visit' + dragBits().cls + '"' + dragBits().attr +
    ' data-kind="parked" data-visit-id="' + esc(p.visitId) + '"' +
    ' data-span="' + span + '"' +
    (p.startTime ? ' data-start="' + esc(p.startTime) + '"' : '') +
    (p.endTime ? ' data-end="' + esc(p.endTime) + '"' : '') +
    (p.date ? ' data-date="' + esc(p.date) + '"' : '') +
    ' data-crew="' + esc((p.technicianRefs || []).join(',')) + '"' +
    ' title="' + esc(tip) + '">' +
    '<span class="tray-glyph' + (p.overdue ? ' glyph-late' : '') + '">' + (p.overdue ? '●' : '') + '</span>' +
    '<span class="tray-main"><span class="tray-who">' + esc(p.customer || 'Unknown') + '</span>' +
    (p.jobTitle ? '<span class="tray-what">' + esc(p.jobTitle) + '</span>' : '') + '</span>' +
    '<span class="tray-side">' + crew + fact + '</span>' +
    '</div>'
  );
}

function jobRow(j) {
  const age = j.createdAt ? ageDays(j.createdAt) : 0;
  const tip = (j.customer || 'Unknown') + (j.title ? ' — ' + j.title : '') + ' · ' + j.priority +
    (age ? ', waiting ' + age + 'd' : '');
  return (
    '<div class="tray-item tray-job' + dragBits().cls + ' prio-' + esc(j.priority) + '"' + dragBits().attr +
    ' data-kind="job" data-job-id="' + esc(j.jobId) + '"' +
    ' data-span="' + (j.durationMinutes || FALLBACK_SPAN) + '"' +
    ' data-title="' + esc(j.title || '') + '"' +
    ' data-priority="' + esc(j.priority) + '"' +
    ' data-duration="' + (j.durationMinutes == null ? '' : j.durationMinutes) + '"' +
    ' title="' + esc(tip) + '">' +
    '<span class="tray-glyph">' + esc(PRIORITY_GLYPH[j.priority] || '') + '</span>' +
    '<span class="tray-main"><span class="tray-who">' + esc(j.customer || 'Unknown') + '</span>' +
    (j.title ? '<span class="tray-what">' + esc(j.title) + '</span>' : '') + '</span>' +
    '<span class="tray-side"><span class="fact">' + esc(fmtMinutes(j.durationMinutes)) + '</span></span>' +
    '</div>'
  );
}

function traySection(key, label, rows, rowHtml) {
  const open = state.traySections[key];
  const filtering = state.trayFilter.trim() !== '';
  // A filter means "I am looking for something" — no paging in the way.
  const shown = !open ? [] : filtering || state.trayShowAll[key] ? rows : rows.slice(0, TRAY_PAGE);
  const hidden = open ? rows.length - shown.length : 0;
  return (
    '<h3 class="rail-sub rail-fold" data-fold="' + key + '" role="button" tabindex="0"' +
    ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
    '<span class="fold-arrow">' + (open ? '▾' : '▸') + '</span>' + label +
    '<span class="count">' + rows.length + '</span></h3>' +
    shown.map(rowHtml).join('') +
    (hidden > 0
      ? '<button type="button" class="link-btn show-more" data-more="' + key + '">show ' +
        hidden + ' more</button>'
      : '') +
    (open && !rows.length ? '<p class="empty">' + (filtering ? 'No match.' : 'None.') + '</p>' : '')
  );
}

function railHtml() {
  if (!isManager()) {
    return '<aside class="rail"><p class="hint">Your own schedule. Drag-and-drop is a manager tool.</p></aside>';
  }
  const bucket = (state.data && state.data.bucket) || { parkedVisits: [], unscheduledJobs: [] };
  const roster = (state.data && state.data.roster) || [];
  const filter = state.rosterFilter.toLowerCase();

  const parked = sortParked(
    (bucket.parkedVisits || []).filter((p) => trayFilterHit([p.customer, p.jobTitle])),
  );
  const jobs = sortJobs(
    (bucket.unscheduledJobs || []).filter((j) => trayFilterHit([j.customer, j.title])),
  );

  return (
    '<aside class="rail">' +
    '<div class="rail-section">' +
    '<h2>Unscheduled work</h2>' +
    '<input type="search" id="tray-filter" class="tray-filter" placeholder="Find a customer or job"' +
    ' value="' + esc(state.trayFilter) + '" autocomplete="off">' +
    traySection('parked', 'No time set', parked, parkedRow) +
    traySection('jobs', 'Not on the calendar', jobs, jobRow) +
    '</div>' +

    '<div class="rail-section">' +
    '<h2>Technicians</h2>' +
    '<input type="search" id="roster-filter" placeholder="Filter by name" value="' +
    esc(state.rosterFilter) + '" autocomplete="off">' +
    '<div class="roster">' +
    roster
      .filter((t) => !filter || t.name.toLowerCase().indexOf(filter) >= 0)
      .map(
        (t) =>
          '<label class="roster-row"><input type="checkbox" data-ref="' + esc(t.ref) + '"' +
          (state.visibleRefs.has(t.ref) ? ' checked' : '') + '>' +
          '<span class="chip" style="background:' + employeeColors(t.ref).solid + '">' +
          esc(initials(t.name)) + '</span><span>' + esc(t.name) + '</span></label>',
      )
      .join('') +
    '</div></div></aside>'
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────────
function toolbarHtml() {
  const views = layout() === 'list' ? ['day', 'month'] : ['day', 'week', 'month'];
  const colors = ['employee', 'priority', 'status'];
  const bucket = state.data && state.data.bucket;
  const trayCount = bucket
    ? (bucket.unscheduledJobs || []).length + (bucket.parkedVisits || []).length
    : 0;
  // Red when any parked visit's day has already passed — the one tray state
  // that is not merely "waiting" but "missed".
  const trayAlert = !!bucket && (bucket.parkedVisits || []).some((p) => p.overdue);
  return (
    '<header class="toolbar">' +
    // Narrow widths only (CSS hides it otherwise): the rail and the grid cannot
    // both have the height a phone gives, so the tray becomes a drawer.
    (isManager()
      ? '<button type="button" class="icon-btn rail-toggle' + (railVisible() ? ' active' : '') +
        '" data-rail aria-expanded="' + (railVisible() ? 'true' : 'false') +
        '" aria-label="Show or hide the unscheduled work panel" title="Unscheduled work">' +
        '<span class="bars" aria-hidden="true"></span>' +
        (trayCount
          ? '<span class="count' + (trayAlert ? ' count-alert' : '') + '">' + trayCount + '</span>'
          : '') + '</button>'
      : '') +
    '<button type="button" class="btn" data-today>Today</button>' +
    '<button type="button" class="icon-btn" data-step="-1" aria-label="Previous">‹</button>' +
    '<button type="button" class="icon-btn" data-step="1" aria-label="Next">›</button>' +
    '<h1 class="range-title">' + esc(title()) + '</h1>' +
    // Always in the row, hidden when idle: a spinner that appears only while
    // loading changes the toolbar's width, wraps it on a phone, and shoves
    // the calendar down for the length of the fetch (user, 2026-09-08).
    '<span class="spinner' + (state.loading ? '' : ' is-idle') + '" aria-label="Loading"' +
    (state.loading ? '' : ' aria-hidden="true"') + '></span>' +
    (isManager()
      ? '<button type="button" class="icon-btn undo-btn" data-undo' +
        (state.undo.length ? '' : ' disabled') + '>' +
        '<span aria-hidden="true">↶</span>' +
        '<span class="count">' + (state.undo.length ? state.undo.length : '') + '</span>' +
        '</button>'
      : '') +
    '<div class="toolbar-right">' +
    '<label class="lbl-inline">Color by</label>' +
    '<select data-colorby>' +
    colors
      .map(
        (c) =>
          '<option value="' + c + '"' + (c === state.colorBy ? ' selected' : '') + '>' + c + '</option>',
      )
      .join('') +
    '</select>' +
    '<div class="segmented">' +
    views
      .map(
        (v) =>
          '<button type="button" class="seg' + (v === state.view ? ' active' : '') +
          '" data-view="' + v + '">' + v + '</button>',
      )
      .join('') +
    '</div>' +
    // Phone only (display:none elsewhere): takes the room Day and Month gave
    // up when they were halved, so nothing else on the line moves.
    '<span class="toolbar-fill" aria-hidden="true"></span>' +
    (canFullscreen()
      ? '<button type="button" class="icon-btn" data-fullscreen aria-label="Toggle fullscreen" title="' +
        (tg.isFullscreen ? 'Back to the window' : 'Fill the whole tab') + '">' +
        (tg.isFullscreen ? '⤡' : '⤢') + '</button>'
      : '') +
    '</div></header>'
  );
}

function render() {
  if (!state.data) {
    root.className = 'booting';
    // A dead end otherwise: no toolbar, no Today, and pull-to-refresh needs a
    // canvas that does not exist — the only way back was to close the Mini App
    // (review finding 2026-09-09).
    root.innerHTML = state.loading
      ? 'Loading…'
      : '<p>Could not load the schedule.</p>' +
        '<button type="button" class="btn btn-primary" data-retry>Try again</button>';
    const retry = root.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', () => load());
    return;
  }
  // The data on hand is for another page: the load for this one failed. Drawing
  // it would say "nothing scheduled" about a day we simply have not read.
  const want = range();
  const have = state.dataRange;
  if (!state.loading && have && (have.from !== want.from || have.to !== want.to)) {
    root.className = 'shell layout-' + layout();
    root.innerHTML =
      toolbarHtml() +
      '<div class="body"><main class="canvas"><p class="hint">' +
      esc('Could not load ' + title() + '.') +
      ' <button type="button" class="btn" data-retry>Try again</button></p></main></div>';
    wire();
    const retry = root.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', () => load());
    return;
  }
  const mode = layout();
  // The small tree has no week: a phone shows a day or a month of dots.
  if (mode === 'list' && state.view === 'week') state.view = 'day';
  root.className = 'shell layout-' + mode + (railVisible() ? '' : ' rail-hidden');
  const r = range();
  const ctx = {
    layout: mode,
    view: state.view,
    colorBy: state.colorBy,
    anchor: state.anchor,
    today: state.today,
    data: state.data,
    dates: datesOf(r),
    visibleRefs: state.visibleRefs,
    // The UNTICKED refs travel too: the day view synthesises a column for any
    // person it finds on a stop but not in the roster, and that rescue must not
    // resurrect somebody the manager has deliberately hidden.
    hiddenRefs: state.hiddenRefs,
    // Whole-view write gate. Day and week are gated per-day inside the drop
    // handler as well (a week contains past days); this only decides whether
    // cards get drag handles at all.
    canWrite: isManager(),
    canDrag: isManager() && finePointer(),
  };
  // A repaint must not throw the manager back to the top of the tray or the
  // grid (2026-09-08: unticking a technician reset the tray's scroll). Read
  // the scroll positions before the DOM is replaced, restore after.
  const keep = {};
  for (const sel of ['.rail', '.canvas']) {
    const el = root.querySelector(sel);
    if (el) keep[sel] = { top: el.scrollTop, left: el.scrollLeft };
  }
  // ...and the focused field with its caret: a repaint that lands while the
  // manager is typing in a filter must not close the phone's keyboard
  // (2026-09-08: the keyboard opened, the viewport shrank, the repaint
  // replaced the input, focus died, keyboard gone).
  const active = document.activeElement;
  const focusKeep =
    active && active.id && root.contains(active)
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : null;
  const samePage =
    lastPaint && lastPaint.view === state.view && lastPaint.anchor === state.anchor && lastPaint.layout === mode;
  // The phone's sheet slides (user, 2026-09-08): up on the paint that opens
  // it, and down on the paint that closes it — as a clone of the outgoing
  // rail, since this paint replaces the DOM before any transition could run.
  const sheetNow = sheetShown();
  const wasSheet = !!(lastPaint && lastPaint.sheet);
  const leaving =
    wasSheet && !sheetNow && !railVisible() && motionOk()
      ? { rail: root.querySelector('.rail'), scrim: root.querySelector('.rail-scrim'), scrollTop: (keep['.rail'] || {}).top || 0 }
      : null;
  root.innerHTML =
    toolbarHtml() +
    '<div class="body">' +
    // The scrim exists only where the rail is a bottom sheet (phone CSS);
    // everywhere else it is display:none.
    (railVisible() && isManager() ? '<div class="rail-scrim" data-rail-close></div>' : '') +
    railHtml() +
    '<main class="canvas' + (state.view === 'month' && mode === 'grid' ? ' canvas-month' : '') +
    (mode === 'list' ? ' canvas-list' : '') + '">' +
    (mode === 'list' ? renderList(ctx) : renderCalendar(ctx)) +
    (state.data.horizonNote
      ? '<p class="hint horizon">' + esc(state.data.horizonNote) + '</p>'
      : '') +
    '</main></div>';
  wire();
  // A swipe's page turn: the new page slides in from the side the finger was
  // heading, on the paint that follows the step — and a paint that lands
  // while that slide is still running (the fetched data arriving) picks the
  // slide up from where it is instead of cutting it short (user, 2026-09-09:
  // "give it the sliding effect" — the data paint was replacing the DOM
  // mid-slide, so the motion barely showed).
  {
    const canvas = root.querySelector('.canvas');
    const page = canvas && canvas.firstElementChild;
    const now = Date.now();
    if (page && motionOk()) {
      if (slideDir) {
        slideFrom = slideDir;
        slideEnd = now + SLIDE_MS;
        startSlide(page, slideFrom * canvas.clientWidth, SLIDE_MS);
      } else if (slideEnd > now && samePage) {
        const left = slideEnd - now;
        startSlide(page, (slideFrom * canvas.clientWidth * left) / SLIDE_MS, left);
      }
    }
    slideDir = 0;
  }
  if (sheetNow && !wasSheet && lastPaint && motionOk()) {
    const rail = root.querySelector('.rail');
    if (rail) rail.classList.add('sheet-enter');
    const scrim = root.querySelector('.rail-scrim');
    if (scrim) scrim.classList.add('scrim-enter');
  }
  if (leaving && leaving.rail) ghostSheet(leaving);
  for (const sel of Object.keys(keep)) {
    if (sel === '.canvas' && !samePage) continue;
    const el = root.querySelector(sel);
    if (el) {
      el.scrollTop = keep[sel].top;
      el.scrollLeft = keep[sel].left;
    }
  }
  if (focusKeep) {
    const el = document.getElementById(focusKeep.id);
    if (el) {
      el.focus({ preventScroll: true });
      try {
        if (focusKeep.start != null) el.setSelectionRange(focusKeep.start, focusKeep.end);
      } catch {
        /* not a text field */
      }
    }
  }
  lastPaint = { view: state.view, anchor: state.anchor, layout: mode, width: window.innerWidth, sheet: sheetNow };
}

// The closing sheet: an inert clone of the rail that was just replaced, with
// no ids (the live DOM owns those) and no handlers, appended to the body so
// the shell's rail-hidden rule cannot hide it, gone when its slide ends — or
// after 400ms if the browser never says so.
function ghostSheet(old) {
  const rail = old.rail.cloneNode(true);
  rail.removeAttribute('id');
  rail.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  rail.classList.add('sheet-leave');
  const scrim = old.scrim ? old.scrim.cloneNode(false) : null;
  if (scrim) {
    scrim.removeAttribute('data-rail-close');
    scrim.classList.add('scrim-leave');
    document.body.appendChild(scrim);
  }
  document.body.appendChild(rail);
  rail.scrollTop = old.scrollTop;
  const gone = () => {
    rail.remove();
    if (scrim) scrim.remove();
  };
  rail.addEventListener('animationend', gone, { once: true });
  window.setTimeout(gone, 400);
}

// A viewport change repaints only when it changes a DECISION: the width (rail
// beside or below, list or grid). A height-only change — the phone keyboard
// opening, the Telegram header collapsing — redraws nothing; the CSS already
// sizes the shell off --tg-viewport-stable-height.
function repaintIfShapeChanged() {
  if (!state.data) return;
  if (lastPaint && lastPaint.width === window.innerWidth && lastPaint.layout === layout()) return;
  render();
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function wire() {
  const railBtn = root.querySelector('[data-rail]');
  if (railBtn) {
    railBtn.addEventListener('click', () => {
      state.railOpen = !railVisible();
      render();
    });
  }
  const scrim = root.querySelector('[data-rail-close]');
  if (scrim) {
    scrim.addEventListener('click', () => {
      state.railOpen = false;
      render();
    });
  }
  const undoBtn = root.querySelector('[data-undo]');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => undoLast());
    syncUndoButton();
  }
  const fsBtn = root.querySelector('[data-fullscreen]');
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      try {
        if (tg.isFullscreen) tg.exitFullscreen();
        else tg.requestFullscreen();
      } catch {
        /* unsupported on this client; the button is cosmetic then */
      }
    });
  }
  root.querySelector('[data-today]').addEventListener('click', () => {
    state.anchor = state.today;
    load();
  });
  root.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => turnPage(Number(b.getAttribute('data-step')))),
  );
  root.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      const view = b.getAttribute('data-view');
      if (view === state.view) return; // already there: nothing to fetch, nothing to redraw
      state.view = view;
      load();
    }),
  );
  const colorSel = root.querySelector('[data-colorby]');
  if (colorSel) {
    colorSel.addEventListener('change', () => {
      state.colorBy = colorSel.value;
      render(); // pure presentation — no reload
    });
  }

  const filter = root.querySelector('#roster-filter');
  if (filter) {
    filter.addEventListener('input', () => {
      state.rosterFilter = filter.value;
      render();
      const again = root.querySelector('#roster-filter');
      again.focus();
    });
  }
  root.querySelectorAll('.roster-row input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const ref = cb.getAttribute('data-ref');
      if (cb.checked) {
        state.visibleRefs.add(ref);
        state.hiddenRefs.delete(ref);
      } else {
        state.visibleRefs.delete(ref);
        state.hiddenRefs.add(ref);
      }
      render();
    }),
  );

  const trayFilter = root.querySelector('#tray-filter');
  if (trayFilter) {
    trayFilter.addEventListener('input', () => {
      state.trayFilter = trayFilter.value;
      render();
      const again = root.querySelector('#tray-filter');
      again.focus();
    });
  }
  root.querySelectorAll('[data-fold]').forEach((h) => {
    const toggle = () => {
      const key = h.getAttribute('data-fold');
      state.traySections[key] = !state.traySections[key];
      render();
    };
    h.addEventListener('click', toggle);
    h.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  });
  root.querySelectorAll('[data-more]').forEach((b) =>
    b.addEventListener('click', () => {
      state.trayShowAll[b.getAttribute('data-more')] = true;
      render();
    }),
  );

  // A plain click opens the visit. Kept separate from the drag handler on
  // purpose: a drag ends with `dragend`, not `click`, so the two gestures do
  // not fight — and a card must be readable by people who never discover the
  // right-click menu.
  root.querySelectorAll('.card, .month-chip').forEach((card) =>
    card.addEventListener('click', async () => {
      // Impatient taps on a slow link used to stack sheets, each needing its own
      // dismissal (review finding 2026-09-09).
      if (detailBusy || document.querySelector('.modal-host:not(.is-closing)')) return;
      detailBusy = true;
      try {
        showDetail(await api.visit(card.getAttribute('data-visit-id')));
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        detailBusy = false;
      }
    }),
  );

  wireDragAndDrop();
  wireContextMenu();
}

// Edit a job that has no visit yet — the tray row carries everything the
// editor needs, so no read.
function editJobRow(row) {
  openEditJob({
    jobId: row.getAttribute('data-job-id'),
    title: row.getAttribute('data-title'),
    priority: row.getAttribute('data-priority'),
    durationMinutes:
      row.getAttribute('data-duration') === '' ? null : Number(row.getAttribute('data-duration')),
    onDone: afterEdit,
  });
}

// Edit the JOB behind a visit: read the visit detail first, because a card or
// tray row knows the visit, and the job's stored title/priority/length live one
// hop away. Pre-filling from the row would turn the VISIT's span into the JOB's
// length on the next save — a different claim.
async function editJobOfVisit(visitId) {
  try {
    const detail = await api.visit(visitId);
    if (!detail.jobId) {
      toast('This visit’s job is not editable from here', 'error');
      return;
    }
    openEditJob({
      jobId: detail.jobId,
      title: detail.jobTitle,
      priority: detail.jobPriority || 'routine',
      durationMinutes: detail.jobDurationMinutes,
      onDone: (msg, ctx) => afterEdit(msg, { ...ctx, visitId: visitId }),
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Drag and drop ────────────────────────────────────────────────────────────
// One payload shape for all three sources, because the drop handler's job is to
// decide WHERE, not to care where the thing came from:
//   kind 'visit'  — a card on the grid (has a time already)
//   kind 'parked' — a tray row that is a visit with no time
//   kind 'job'    — a tray row with no visit at all
let dragging = null;
let detailBusy = false; // one visit sheet in flight at a time

function payloadFrom(el) {
  const kind = el.getAttribute('data-kind') || 'visit';
  const crewAttr = el.getAttribute('data-crew');
  return {
    kind: kind,
    visitId: el.getAttribute('data-visit-id') || null,
    jobId: el.getAttribute('data-job-id') || null,
    span: Number(el.getAttribute('data-span')) || FALLBACK_SPAN,
    fromDate: el.getAttribute('data-date') || null,
    fromStart: el.getAttribute('data-start') || null,
    fromEnd: el.getAttribute('data-end') || null,
    // null = the element did not say (no undo can be offered); [] = nobody.
    fromCrew: crewAttr === null ? null : crewAttr ? crewAttr.split(',') : [],
    // A tray job's title — only used to word the undo-booking confirm.
    label: el.getAttribute('data-title') || null,
  };
}

const beforeOf = (p) => ({ date: p.fromDate, start: p.fromStart, end: p.fromEnd, crew: p.fromCrew });

function wireDragAndDrop() {
  root.querySelectorAll('.draggable').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      dragging = payloadFrom(el);
      el.classList.add('is-dragging');
      // Some data must be set or Firefox refuses the drag; the real payload
      // stays in `dragging` because dataTransfer is unreadable during dragover,
      // which is exactly when the drop target needs to know the span.
      e.dataTransfer.setData('text/plain', dragging.visitId || dragging.jobId || '');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('is-dragging');
      dragging = null;
      root.querySelectorAll('.drop-hint').forEach((n) => n.remove());
      root.querySelectorAll('.is-over').forEach((n) => n.classList.remove('is-over'));
    });
    // A laptop with a touch screen has both: a touch that ends must never
    // leave the row dimmed, whatever the drag machinery did with it.
    el.addEventListener('touchend', () => el.classList.remove('is-dragging'), { passive: true });
  });

  root.querySelectorAll('.slot-target').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      if (!dragging) return;
      const date = col.getAttribute('data-date');
      if (!actionable(date)) return; // no preventDefault → the drop is refused
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('is-over');
      if (col.hasAttribute('data-month-cell')) return;
      showDropHint(col, e.clientY);
    });
    col.addEventListener('dragleave', (e) => {
      if (e.target === col) {
        col.classList.remove('is-over');
        const hint = col.querySelector('.drop-hint');
        if (hint) hint.remove();
      }
    });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('is-over');
      const hint = col.querySelector('.drop-hint');
      if (hint) hint.remove();
      if (dragging) dropOnto(col, e.clientY, dragging);
    });
  });

  // The rail is the PARK target: dropping a card here takes the people off the
  // trip and leaves it in the tray. It is the reverse of the gesture that
  // placed it, which is what makes drag-and-drop safe to try.
  const rail = root.querySelector('.rail');
  if (rail) {
    rail.addEventListener('dragover', (e) => {
      if (!dragging || dragging.kind !== 'visit') return;
      if (!actionable(dragging.fromDate)) return;
      e.preventDefault();
      rail.classList.add('is-over');
    });
    rail.addEventListener('dragleave', () => rail.classList.remove('is-over'));
    rail.addEventListener('drop', async (e) => {
      e.preventDefault();
      rail.classList.remove('is-over');
      if (!dragging || dragging.kind !== 'visit') return;
      const d = dragging;
      const body = { visitId: d.visitId, date: d.fromDate, startTime: d.fromStart, unassign: true, reason: 'parked from the dispatch console' };
      await write(
        () => api.previewMove(body),
        () => api.move(body),
        'Parked — nobody is on it now',
        null,
        () =>
          d.fromCrew && d.fromCrew.length
            ? undoMoveEntry('Undo park', d.visitId, beforeOf(d), {
                start: d.fromDate + 'T' + d.fromStart,
                crew: [],
              })
            : null,
      );
    });
  }
}

function showDropHint(col, clientY) {
  let hint = col.querySelector('.drop-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'drop-hint';
    col.appendChild(hint);
  }
  const lo = Number(col.getAttribute('data-band-lo') || 0);
  const minutes = minutesAtPointer(col, clientY);
  const span = dragging ? dragging.span : FALLBACK_SPAN;
  hint.style.top = (minutes - lo) * zoom() + 'px';
  hint.style.height = span * zoom() + 'px';
  hint.textContent = hhmm(minutes) + ' – ' + hhmm(minutes + span);
}

// Clamp so the span cannot run past midnight: a booking that ends "tomorrow"
// is a different shape of record than this UI can describe.
function clampStart(minutes, span) {
  return Math.max(0, Math.min(minutes, 24 * 60 - Math.max(SNAP_MINUTES, span)));
}

async function dropOnto(col, clientY, payload) {
  const date = col.getAttribute('data-date');
  if (!actionable(date)) return;
  const techRef = col.getAttribute('data-tech-ref'); // day view only; '' = unassigned column
  const isMonthCell = col.hasAttribute('data-month-cell');

  // A month cell has no clock. Keep the time the card already has — a drag
  // across the month grid is a statement about the DAY, and inventing a start
  // time would silently move an 8am job to noon.
  const startMin = isMonthCell
    ? payload.fromStart
      ? Number(payload.fromStart.slice(0, 2)) * 60 + Number(payload.fromStart.slice(3, 5))
      : 9 * 60
    : minutesAtPointer(col, clientY);

  const span = payload.span || FALLBACK_SPAN;
  const start = clampStart(startMin, span);
  const startTime = hhmm(start);
  const endTime = hhmm(start + span);

  // technicianRef: present on a day-view drop (that IS the hand-over gesture),
  // absent everywhere else so the existing crew is left alone. The empty string
  // is the Unassigned column, which means "take them off", not "keep them".
  const crewPatch =
    techRef === null
      ? {}
      : techRef === ''
        ? { unassign: true }
        : { technicianRef: techRef };

  if (payload.kind === 'job') {
    const body = Object.assign(
      { jobId: payload.jobId, date: date, startTime: startTime, endTime: endTime },
      techRef ? { technicianRef: techRef } : {},
    );
    await write(
      () => api.previewBook(body),
      () => api.book(body),
      'Booked ' + date + ' ' + startTime,
      null,
      (r) => undoBookEntry(r, payload.label),
    );
    return;
  }

  const body = Object.assign(
    {
      visitId: payload.visitId,
      date: date,
      startTime: startTime,
      endTime: endTime,
      reason: 'moved on the dispatch console',
    },
    crewPatch,
  );
  // A parked UNTIMED visit being placed has no old time to go back to, so its
  // inverse is the console's own untime verb rather than a move back.
  const after = { start: date + 'T' + startTime, crew: crewAfter(payload.fromCrew, crewPatch) };
  await write(
    () => api.previewMove(body),
    () => api.move(body),
    'Moved to ' + date + ' ' + startTime,
    null,
    () =>
      payload.fromStart
        ? undoMoveEntry('Undo move', payload.visitId, beforeOf(payload), after)
        : undoUntimeEntry(payload.visitId, payload.fromCrew, after),
  );
}

// The confirmation doctrine, client half: preview, one-shot when the server
// says the change is reversible, ONE in-UI confirm when it is not. Never ask
// twice, and never confirm something the manager just did on purpose.
// `undoOf(result)` → an undo entry (or null) for the write just made; it is
// pushed and offered on the toast. Undo's own writes pass nothing here.
// Returns true (committed), 'declined' (the manager said no at the confirm),
// or false (refused or failed — already toasted).
// ONE WRITE AT A TIME. Two in flight can stack two confirm dialogs, and a
// single Enter answers both — the manager reads one sentence and commits two
// changes (review finding 2026-09-09).
let writeBusy = false;
async function write(preview, commit, okMessage, confirmText, undoOf) {
  if (writeBusy) {
    toast('One change at a time — wait for the last one to finish', 'error');
    return false;
  }
  writeBusy = true;
  try {
    const p = await preview();
    // The preview carries a VERDICT (`requiresConfirmation`), not a sentence.
    // The sentence is composed here because only the caller knows which
    // gesture produced it — and a preview that says false must never be
    // confirmed, or the doctrine's "never ask twice" is gone.
    if (p && p.requiresConfirmation) {
      const ok = await confirmAsk(
        confirmText ? confirmText(p) : 'This is visible to the customer. Go ahead?',
      );
      if (!ok) return 'declined';
    }
    const result = await commit();
    const entry = undoOf ? undoOf(result) : null;
    if (entry) pushUndo(entry);
    toast(
      okMessage + (result && result.warning ? ' — ' + result.warning : ''),
      null,
      entry ? { label: 'Undo', fn: undoLast } : null,
    );
    return true;
  } catch (err) {
    toast(err instanceof ApiError ? err.message : String(err), 'error');
    return false;
  } finally {
    writeBusy = false;
    load();
  }
}

// ── Right-click ──────────────────────────────────────────────────────────────
// A right-click on empty calendar is "new job, here". On a card it is the card
// menu. Long-press covers the same ground on a touch screen, because a Telegram
// webview on a phone has no right button.
function wireContextMenu() {
  root.querySelectorAll('.slot-target').forEach((col) => {
    col.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.card, .month-chip');
      e.preventDefault();
      if (card) cardMenu(card, e.clientX, e.clientY);
      else newJobHere(col, e.clientY);
    });
    longPress(col, (touch) => {
      const under = document.elementFromPoint(touch.clientX, touch.clientY);
      const onCard = under && under.closest('.card, .month-chip');
      if (onCard) cardMenu(onCard, touch.clientX, touch.clientY);
      else newJobHere(col, touch.clientY);
    });
  });
  // The list tree: rows take the card menu by right-click or long-press (the
  // click → detail sheet is wired above with every .card); the day gets a
  // "+ New job" button because a touch screen has no right-click on empty
  // space; a month cell is a jump to that day.
  root.querySelectorAll('.list-card').forEach((card) => {
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cardMenu(card, e.clientX, e.clientY);
    });
    longPress(card, (touch) => cardMenu(card, touch.clientX, touch.clientY));
  });
  const newJobBtn = root.querySelector('[data-new-job]');
  if (newJobBtn) newJobBtn.addEventListener('click', () => newJobAt(state.anchor, 9 * 60, null));
  root.querySelectorAll('.mini-cell').forEach((cell) =>
    cell.addEventListener('click', () => {
      state.anchor = cell.getAttribute('data-date');
      state.view = 'day';
      load();
    }),
  );
  // Tray rows: the same two gestures open the row menu (Edit lives there now,
  // so the row itself stays one line of text).
  root.querySelectorAll('.tray-item').forEach((row) => {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      trayMenu(row, e.clientX, e.clientY);
    });
    longPress(row, (touch) => trayMenu(row, touch.clientX, touch.clientY));
  });
}

// ── Touch: swipe to page, pinch to zoom ──────────────────────────────────────
// One finger sideways turns the page — the next day, week or month, whatever
// the pager is on (user, 2026-09-08: "swipe between days"). Two fingers on a
// time grid change the hour height (the touch iPad, which has no scroll wheel
// and no density toggle). Both are touch-only by construction: a mouse has
// the arrows, and a trackpad's pinch arrives as ctrl+wheel, which the browser
// owns. Wired ONCE, on the document: the canvas is replaced by every paint,
// and a gesture must survive that — and a touch that begins on the outgoing
// page's clone (`.page-ghost`, alive for 300ms after a turn) must still
// drive the live canvas, or a quick second swipe is lost (headless finding
// 2026-09-09: the hit-test handed the touch to the clone's card).
let slideDir = 0; // a committed swipe's direction, consumed by the next paint
let slideFrom = 0; // ...and remembered for a paint that lands mid-slide
let slideEnd = 0; // when the running slide-in ends (ms since epoch), 0 = none
const SLIDE_MS = 240;

function startSlide(page, fromPx, ms) {
  page.style.transition = 'none';
  page.style.transform = 'translateX(' + fromPx + 'px)';
  page.getBoundingClientRect(); // commit the start frame before the transition
  page.style.transition = 'transform ' + ms + 'ms ease-out';
  page.style.transform = '';
  page.addEventListener('transitionend', () => (page.style.transition = ''), { once: true });
}

// The OLD page leaving: the paint that follows the step replaces the DOM at
// once, so what slides out is a clone, fixed over the canvas, carried from
// where the finger let go to just off the edge, then removed. Old and new
// move with the same timing, so they read as one strip sliding.
function ghostPage(canvas, page, fromDx, dir) {
  if (!page || !motionOk()) return;
  const r = canvas.getBoundingClientRect();
  const wrap = document.createElement('div');
  wrap.className = 'page-ghost';
  wrap.style.cssText =
    'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height +
    'px;overflow:hidden;pointer-events:none;z-index:5;';
  const clone = page.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  const y = -canvas.scrollTop;
  clone.style.transition = 'none';
  clone.style.transform = 'translate(' + fromDx + 'px,' + y + 'px)';
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  clone.getBoundingClientRect();
  clone.style.transition = 'transform ' + SLIDE_MS + 'ms ease-out';
  clone.style.transform = 'translate(' + -dir * r.width + 'px,' + y + 'px)';
  window.setTimeout(() => wrap.remove(), SLIDE_MS + 60);
}

function wireTouchNav() {
  let canvas = null; // the live canvas the current gesture belongs to
  const page = () => canvas && canvas.firstElementChild;
  let swipe = null; // { x0, y0, t0, dx, locked: null | 'swipe' | 'scroll' | 'pull' }
  let pinch = null;
  // Where a touch belongs: the canvas it started in, or the live canvas when
  // it started on a page clone; anywhere else is not ours.
  const canvasOf = (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return null;
    if (t.closest('.page-ghost')) return root.querySelector('.canvas');
    return t.closest('.canvas');
  };

  // Dropping a gesture without finishing it must leave nothing behind: a page
  // still translated sideways, or a half-drawn refresh ring, would sit there
  // until the next paint (review finding 2026-09-09) — and a pinch does not
  // repaint, so on an iPad that is "until something else happens".
  const abandonSwipe = () => {
    if (swipe && swipe.locked === 'pull') pullRelease(false);
    if (swipe && swipe.locked === 'swipe') {
      const p = page();
      if (p) {
        p.style.transition = 'transform 160ms ease-out';
        p.style.transform = '';
      }
    }
    swipe = null;
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      const c = canvasOf(e);
      if (!c) {
        abandonSwipe();
        pinch = null;
        return;
      }
      canvas = c;
      if (e.touches.length === 1) {
        const t = e.touches[0];
        swipe = { x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, locked: null, atTop: canvas.scrollTop <= 0 };
        pinch = null;
      } else if (e.touches.length === 2) {
        abandonSwipe();
        pinch = startPinch(canvas, e.touches);
      }
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!canvas) return;
      if (pinch && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        movePinch(canvas, pinch, e.touches);
        return;
      }
      if (!swipe || e.touches.length !== 1 || dragging) {
        abandonSwipe();
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - swipe.x0;
      const dy = t.clientY - swipe.y0;
      if (!swipe.locked) {
        // Decide once, early: mostly vertical is the list scrolling; mostly
        // horizontal is a page turn — unless the grid itself can still scroll
        // that way (a day with many columns), in which case it scrolls and
        // the page turns only from its edge. A sliver of room (an iPad with
        // the rail open clips the last column by 14px) is not a scroll: a
        // swipe that only nudged the grid would read as "swipe does nothing".
        if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
          // Down from the very top is the pull-to-refresh; anything else
          // vertical is the list scrolling.
          if (dy > 0 && swipe.atTop && canvas.scrollTop <= 0 && !document.querySelector('.modal-host')) {
            swipe.locked = 'pull';
            pullShow(canvas);
          } else {
            swipe.locked = 'scroll';
            return;
          }
        }
        if (!(Math.abs(dx) > 12 && Math.abs(dx) > 1.5 * Math.abs(dy))) return;
        // Measure the page's OWN width, not the canvas's scrollWidth: a page
        // still sliding in carries a translateX, and a transformed child
        // inflates its scroller's scrollWidth. Reading that mid-slide invented
        // hundreds of pixels of room, so the next swipe scrolled instead of
        // turning the page (found while re-running touch.cjs, 2026-09-09).
        const p = page();
        const content = p ? p.scrollWidth : canvas.scrollWidth;
        const room =
          dx < 0 ? content - canvas.clientWidth - canvas.scrollLeft : canvas.scrollLeft;
        swipe.locked = room > 40 ? 'scroll' : 'swipe';
      }
      if (swipe.locked === 'pull') {
        if (e.cancelable) e.preventDefault();
        swipe.armed = pullMove(dy) >= 1;
        return;
      }
      if (swipe.locked !== 'swipe') return;
      if (e.cancelable) e.preventDefault();
      swipe.dx = dx;
      const p = page();
      if (p) {
        p.style.transition = 'none';
        p.style.transform = 'translateX(' + dx + 'px)';
      }
    },
    { passive: false },
  );

  const end = (e) => {
    if (!canvas) return;
    // A paint during the gesture replaces the canvas: the captured reference is
    // then detached, its clientWidth is 0, and the commit threshold collapses to
    // a fifth of a pixel — any release would turn the page (review finding
    // 2026-09-09).
    if (!canvas.isConnected) {
      const live = root.querySelector('.canvas');
      if (!live) {
        swipe = null;
        pinch = null;
        return;
      }
      canvas = live;
    }
    if (pinch) {
      if (e.touches.length < 2) {
        saveZoom();
        pinch = null;
      }
      return;
    }
    if (!swipe) return;
    const s = swipe;
    swipe = null;
    if (s.locked === 'pull') {
      pullRelease(!!s.armed);
      return;
    }
    if (s.locked !== 'swipe') return;
    const p = page();
    const w = canvas.clientWidth || 1;
    const dt = Math.max(1, Date.now() - s.t0);
    // Far enough, or a quick flick.
    const flick = Math.abs(s.dx) > 30 && Math.abs(s.dx) / dt > 0.5;
    if (Math.abs(s.dx) >= Math.min(80, w * 0.2) || flick) {
      slideDir = s.dx < 0 ? 1 : -1;
      ghostPage(canvas, p, s.dx, slideDir);
      step(slideDir);
    } else if (p) {
      p.style.transition = 'transform 160ms ease-out';
      p.style.transform = '';
    }
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}

// The arrows turn the page the way a swipe does (user, 2026-09-09): the
// current page leaves as a clone, the next slides in.
function turnPage(dir) {
  const canvas = root.querySelector('.canvas');
  const p = canvas && canvas.firstElementChild;
  if (p && canvas.clientWidth) {
    slideDir = dir;
    ghostPage(canvas, p, 0, dir);
  }
  step(dir);
}

// ── Pull to refresh ──────────────────────────────────────────────────────────
// A finger dragged down from the top of the calendar draws a ring down with
// it; past the threshold, letting go reloads the page and the ring spins
// until the data is back, half a second at least so the reload is SEEN
// (user, 2026-09-09: a way to refresh by hand and know it happened, even
// though the page is already current). The ring lives on the body, so the
// reload's repaint cannot take it away mid-spin.
const PULL_MAX = 72; // px the ring travels at most
const PULL_ARM = 56; // px of travel that arms the reload
const PULL_MIN_SHOW = 500; // ms the spin is shown even when the data is instant
let pullRing = null;
function pullShow(canvas) {
  if (pullRing) pullRing.remove();
  const r = canvas.getBoundingClientRect();
  pullRing = document.createElement('div');
  pullRing.className = 'pull-ring';
  pullRing.innerHTML = '<div class="pull-ring-arc"></div>';
  pullRing.style.left = r.left + r.width / 2 + 'px';
  pullRing.style.top = r.top + 'px';
  document.body.appendChild(pullRing);
}
// Follows the finger with resistance; returns the progress towards arming.
function pullMove(dy) {
  if (!pullRing) return 0;
  const travel = Math.min(PULL_MAX, dy * 0.5);
  const p = Math.min(1, travel / PULL_ARM);
  pullRing.style.transition = 'none';
  pullRing.style.transform = 'translate(-50%,' + (travel - 40) + 'px)';
  pullRing.style.opacity = String(Math.min(1, 0.25 + p));
  pullRing.firstElementChild.style.transform = 'rotate(' + p * 270 + 'deg)';
  pullRing.classList.toggle('is-armed', p >= 1);
  return p;
}
async function pullRelease(armed) {
  const ring = pullRing;
  pullRing = null;
  if (!ring) return;
  if (armed) {
    ring.classList.add('is-loading');
    ring.style.transition = 'transform 160ms ease-out';
    ring.style.transform = 'translate(-50%,' + (PULL_ARM - 40) + 'px)';
    const started = Date.now();
    try {
      await load(); // toasts its own failure
    } catch {
      /* nothing more to say */
    }
    const left = PULL_MIN_SHOW - (Date.now() - started);
    if (left > 0) await new Promise((res) => window.setTimeout(res, left));
    ring.classList.remove('is-loading');
  }
  ring.style.transition = 'transform 200ms ease-in, opacity 200ms ease-in';
  ring.style.transform = 'translate(-50%,-40px)';
  ring.style.opacity = '0';
  window.setTimeout(() => ring.remove(), 240);
}

// The pinch pivots on the hour under the fingers: that hour stays where it
// is on the screen while everything above and below stretches away from it.
function startPinch(canvas, touches) {
  const grid = canvas.querySelector('.grid-day, .grid-week');
  if (!grid) return null;
  const body = grid.querySelector('.grid-body');
  const [a, b] = touches;
  const midY = (a.clientY + b.clientY) / 2;
  const canvasTop = canvas.getBoundingClientRect().top;
  const bodyTop = body.getBoundingClientRect().top;
  return {
    grid,
    d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
    z0: zoom(),
    bodyOffset: bodyTop - canvasTop + canvas.scrollTop, // where minute 0 sits in the scroll
    anchorMin: (midY - bodyTop) / zoom(), // band minutes under the fingers
    screenY: midY - canvasTop, // and where on the canvas they are
  };
}

function movePinch(canvas, p, touches) {
  const [a, b] = touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const z = setZoom(p.z0 * (d / p.d0));
  p.grid.style.setProperty('--pxm', z + 'px');
  canvas.scrollTop = p.bodyOffset + p.anchorMin * z - p.screenY;
}

// Touch: 550ms without moving is the right-click. Cancelled by any scroll or
// drag so the menu never fires mid-swipe — and by a SECOND finger: a pinch
// is not a press. (Found headless 2026-09-08: the second finger's touchstart
// re-armed the timer and orphaned the first one, which fired "New job" half
// a second into every pinch.)
function longPress(el, fire) {
  let timer = null;
  let fired = false;
  const cancel = () => window.clearTimeout(timer);
  el.addEventListener(
    'touchstart',
    (e) => {
      cancel();
      fired = false;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      timer = window.setTimeout(() => {
        // A repaint during the hold detaches this element; its geometry is then
        // all zeros, and "new job here" would read a start time off the raw
        // screen position (review finding 2026-09-09).
        if (!el.isConnected) return;
        fired = true;
        fire(touch);
      }, 550);
    },
    { passive: true },
  );
  el.addEventListener('touchmove', cancel, { passive: true });
  // The finger lifting after a press must not become a click: the browser
  // synthesises one from touchend, and the menu that just opened dismisses
  // itself on any click outside it (headless finding 2026-09-08: the menu
  // opened at 550ms and was gone the moment the finger came off).
  el.addEventListener('touchend', (e) => {
    cancel();
    if (fired && e.cancelable) e.preventDefault();
    fired = false;
  });
  el.addEventListener('touchcancel', cancel, { passive: true });
}

// One popup for every menu. Resolves with the chosen key, or null when the
// manager clicked away. ONE AT A TIME: on Android a long press fires the
// browser's own `contextmenu` AND our 550ms timer, and two menus would stack;
// opening a menu closes whatever menu is up.
let closeMenu = null;
function popupMenu(items, x, y) {
  return new Promise((resolve) => {
    if (closeMenu) closeMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.innerHTML = items
      .map(
        (i) =>
          '<button type="button" data-act="' + i.key + '"' +
          (i.disabled ? ' disabled' : '') +
          (i.danger ? ' class="danger"' : '') + '>' + esc(i.label) + '</button>',
      )
      .join('');
    document.body.appendChild(menu);
    // Keep it on screen: a menu opened near the bottom edge flips upward.
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = Math.max(0, x - r.width) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = Math.max(0, y - r.height) + 'px';
    const dismiss = (key) => {
      menu.remove();
      document.removeEventListener('click', onAway, true);
      if (closeMenu === mine) closeMenu = null;
      resolve(key);
    };
    const mine = () => dismiss(null);
    closeMenu = mine;
    // Capture-phase, so it sees the click before anything else — which means it
    // ALSO sees clicks on the menu's own items and must let those through, or
    // it resolves null before the item handler can answer (2026-09-07 finding:
    // every menu item was dead).
    const onAway = (e) => {
      if (menu.contains(e.target)) return;
      dismiss(null);
    };
    document.addEventListener('click', onAway, true);
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      e.stopPropagation();
      dismiss(btn.getAttribute('data-act'));
    });
  });
}

// Right-click on empty grid: a new job, prefilled with that day, that slot
// and that column's technician.
function newJobHere(col, clientY) {
  const date = col.getAttribute('data-date');
  if (!actionable(date)) {
    toast(
      isManager()
        ? 'That day has passed — corrections to history are a chat job.'
        : 'Managers only.',
      'error',
    );
    return;
  }
  const isMonthCell = col.hasAttribute('data-month-cell');
  const start = isMonthCell ? 9 * 60 : clampStart(minutesAtPointer(col, clientY), FALLBACK_SPAN);
  newJobAt(date, start, col.getAttribute('data-tech-ref') || null);
}

function newJobAt(date, startMin, technicianRef) {
  if (!actionable(date)) {
    toast(isManager() ? 'That day has passed — corrections to history are a chat job.' : 'Managers only.', 'error');
    return;
  }
  openNewJob({
    date: date,
    startTime: hhmm(startMin),
    endTime: hhmm(startMin + FALLBACK_SPAN),
    technicianRef: technicianRef,
    roster: (state.data && state.data.roster) || [],
    onDone: (msg) => {
      toast(msg);
      load();
    },
  });
}

// Move a visit to a day/time (and optionally a person) from the form — the
// same write, the same undo, as a drop; `before` is what the row carried.
function moveVisitTo(visitId, before, v) {
  const patch = v.crew === null ? {} : v.crew.length ? { technicianRefs: v.crew } : { unassign: true };
  const body = Object.assign(
    {
      visitId: visitId,
      date: v.date,
      startTime: v.startTime,
      endTime: v.endTime,
      reason: 'moved on the dispatch console',
    },
    patch,
  );
  const after = { start: v.date + 'T' + v.startTime, crew: crewAfter(before.crew, patch) };
  return write(
    () => api.previewMove(body),
    () => api.move(body),
    'Moved to ' + v.date + ' ' + v.startTime,
    null,
    () =>
      before.start
        ? undoMoveEntry('Undo move', visitId, before, after)
        : undoUntimeEntry(visitId, before.crew, after),
  );
}

function moveViaForm(el, title) {
  const visitId = el.getAttribute('data-visit-id');
  const before = beforeOf(payloadFrom(el));
  const span = Number(el.getAttribute('data-span')) || FALLBACK_SPAN;
  const startMin = before.start
    ? Number(before.start.slice(0, 2)) * 60 + Number(before.start.slice(3, 5))
    : 9 * 60;
  openMoveVisit({
    mode: 'move',
    title: title,
    date: before.date || (state.anchor >= state.today ? state.anchor : state.today),
    startTime: hhmm(startMin),
    endTime: before.end || hhmm(startMin + span),
    crew: before.crew || [],
    roster: (state.data && state.data.roster) || [],
    onSubmit: (v) => {
      sheetAway(el);
      return moveVisitTo(visitId, before, v);
    },
  });
}

// A phone's tray is a sheet over the day: once a row from it has been placed
// or booked, close it so the write's repaint shows the result underneath.
function sheetAway(el) {
  if (el.classList.contains('tray-item') && window.innerWidth < RAIL_MIN_WIDTH) state.railOpen = false;
}

function bookViaForm(row) {
  const jobId = row.getAttribute('data-job-id');
  const label = row.getAttribute('data-title') || null;
  const span = Number(row.getAttribute('data-span')) || FALLBACK_SPAN;
  const date = state.anchor >= state.today ? state.anchor : state.today;
  openMoveVisit({
    mode: 'book',
    title: 'Book' + (label ? ': ' + label : ''),
    date: date,
    startTime: '09:00',
    endTime: hhmm(9 * 60 + span),
    crew: [],
    roster: (state.data && state.data.roster) || [],
    onSubmit: (v) => {
      sheetAway(row);
      const body = Object.assign(
        { jobId: jobId, date: v.date, startTime: v.startTime, endTime: v.endTime },
        v.crew && v.crew.length ? { technicianRefs: v.crew } : {},
      );
      return write(
        () => api.previewBook(body),
        () => api.book(body),
        'Booked ' + v.date + ' ' + v.startTime,
        null,
        (r) => undoBookEntry(r, label),
      );
    },
  });
}

async function trayMenu(row, x, y) {
  const kind = row.getAttribute('data-kind');
  // "Put on the calendar…" / "Book…" are the touch route onto the grid (a
  // phone cannot drag a row); on a desktop they are simply the same thing
  // by form.
  const items =
    kind === 'parked'
      ? [
          { key: 'open', label: 'Open details' },
          { key: 'place', label: 'Put on the calendar…', disabled: !isManager() },
          { key: 'edit', label: 'Edit job' },
          { key: 'cancel', label: 'Cancel this visit', danger: true },
        ]
      : [
          { key: 'book', label: 'Book…', disabled: !isManager() },
          { key: 'edit', label: 'Edit job' },
          { key: 'delete', label: 'Delete this job', disabled: !isManager(), danger: true },
        ];
  const act = await popupMenu(items, x, y);
  if (!act) return;
  if (act === 'delete') {
    await deleteJob(row);
    return;
  }
  if (act === 'place') {
    moveViaForm(row, 'Put on the calendar');
    return;
  }
  if (act === 'book') {
    bookViaForm(row);
    return;
  }
  if (act === 'edit') {
    if (kind === 'parked') await editJobOfVisit(row.getAttribute('data-visit-id'));
    else editJobRow(row);
    return;
  }
  if (act === 'open') {
    try {
      showDetail(await api.visit(row.getAttribute('data-visit-id')));
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }
  if (act === 'cancel') {
    // An UNTIMED visit is nobody's appointment yet, so the server's preview
    // will say one-shot — but a reason is still owed to the record.
    const reason = window.prompt('Why is this visit being cancelled?');
    if (!reason || !reason.trim()) return;
    await cancelVisit(row.getAttribute('data-visit-id'), reason.trim(), (p) =>
      'Cancel the visit for ' + (p.customerName || 'this customer') + '? They are expecting it.',
    );
  }
}

async function cardMenu(card, x, y) {
  const visitId = card.getAttribute('data-visit-id');
  const jobId = card.getAttribute('data-job-id');
  const date = card.getAttribute('data-date');
  // A completed trip is history: it can be read and nothing else (user
  // decision 2026-09-07). Offering greyed verbs would still say "this could
  // be edited"; the menu simply has none.
  const done = card.getAttribute('data-status') === 'completed';
  const can = actionable(date);
  const act = await popupMenu(
    done
      ? [{ key: 'open', label: 'Open details' }]
      : [
          { key: 'open', label: 'Open details' },
          { key: 'edit', label: 'Edit job', disabled: !can || !jobId },
          { key: 'move', label: 'Move…', disabled: !can },
          { key: 'park', label: 'Take everyone off (park)', disabled: !can },
          { key: 'cancel', label: 'Cancel this visit', disabled: !can, danger: true },
        ],
    x,
    y,
  );
  if (!act) return;
  if (act === 'open') {
    try {
      showDetail(await api.visit(visitId));
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }
  if (act === 'edit') {
    await editJobOfVisit(visitId);
    return;
  }
  if (act === 'move') {
    moveViaForm(card, 'Move visit');
    return;
  }
  if (act === 'park') {
    const before = beforeOf(payloadFrom(card));
    const body = {
      visitId: visitId,
      date: date,
      startTime: before.start,
      unassign: true,
      reason: 'parked from the dispatch console',
    };
    await write(
      () => api.previewMove(body),
      () => api.move(body),
      'Parked',
      null,
      () =>
        before.crew && before.crew.length
          ? undoMoveEntry('Undo park', visitId, before, { start: date + 'T' + before.start, crew: [] })
          : null,
    );
    return;
  }
  if (act === 'cancel') {
    // The ONE irreversible, externally-visible act on this surface: a
    // customer is expecting this visit. It always asks, and it always asks
    // for a reason — the reason is what the customer is owed.
    const reason = window.prompt('Why is this visit being cancelled?');
    if (!reason || !reason.trim()) return;
    await cancelVisit(visitId, reason.trim(), (p) =>
      'Cancel the visit for ' +
      (p.customerName || 'this customer') +
      ' on ' + p.day + '? They are expecting it.',
    );
  }
}

// Delete = cancel the JOB (its visits go with it). Always asks, always wants
// a reason, and offers NO undo: a cancelled job is terminal, and minting a
// look-alike would be a different job with a different history.
async function deleteJob(row) {
  const jobId = row.getAttribute('data-job-id');
  const title = row.getAttribute('data-title') || 'this job';
  const reason = window.prompt('Why is this job being deleted?');
  if (!reason || !reason.trim()) return;
  const body = { jobId: jobId, reason: reason.trim() };
  await write(
    () => api.previewCancelJob(body),
    () => api.cancelJob(body),
    'Job deleted',
    (p) => {
      const n = (p.visits || []).length;
      return (
        'Delete “' + (p.jobTitle || title) + '”' + (p.customerName ? ' for ' + p.customerName : '') + '?' +
        (n ? ' Its ' + n + ' booked visit' + (n === 1 ? '' : 's') + ' will be cancelled too.' : '') +
        ' There is no undo for this.'
      );
    },
  );
}

// Cancel with its undo: the visit's day, time, crew and job are read BEFORE
// the row goes terminal, because afterwards the only way back is a fresh
// booking on the same job — and that needs all four.
async function cancelVisit(visitId, reason, confirmText) {
  let prior = null;
  try {
    prior = await api.visit(visitId);
  } catch {
    // Without it the cancel still goes ahead; it just has no undo.
  }
  const body = { visitId: visitId, reason: reason };
  await write(
    () => api.previewCancel(body),
    () => api.cancel(body),
    'Cancelled',
    confirmText,
    () => undoCancelEntry(prior && { ...prior, visitId: visitId }),
  );
}

function showDetail(detail) {
  const customer = detail.customer || {};
  const rows = [
    ['Customer', customer.name],
    ['Phone', customer.phone],
    ['Email', customer.email],
    ['Address', customer.address],
    ['Job', detail.jobTitle],
    ['Priority', detail.jobPriority],
    [
      'When',
      detail.start
        ? detail.start.slice(0, 10) + ' ' + detail.start.slice(11, 16) +
          (detail.end ? '–' + detail.end.slice(11, 16) : '')
        : 'no time set',
    ],
    ['Status', detail.status],
    [
      'Done at',
      detail.completedAt
        ? detail.completedAt.slice(0, 10) + ' ' + detail.completedAt.slice(11, 16)
        : null,
    ],
    ['Crew', (detail.technicianNames || []).join(', ') || 'nobody'],
  ];
  // customerNotes are the server's already-folded, already-truncated standing
  // facts (retractions applied there, not here) — rendered verbatim.
  const notes = detail.customerNotes || [];
  const body =
    '<dl class="detail">' +
    rows
      .filter((r) => r[1])
      .map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>')
      .join('') +
    '</dl>' +
    (notes.length
      ? '<h3>What we know</h3><dl class="detail">' +
        notes.map((n) => '<dt>' + esc(n.key) + '</dt><dd>' + esc(n.value) + '</dd>').join('') +
        '</dl>'
      : '');
  const host = document.createElement('div');
  host.className = 'modal-host';
  host.innerHTML =
    '<div class="modal-backdrop"></div><div class="modal"><div class="modal-head">' +
    '<h2>Visit</h2><button type="button" class="icon-btn" data-close="1">✕</button></div>' +
    '<div class="modal-body">' + body + '</div><div class="modal-foot">' +
    '<button type="button" class="btn" data-close="1">Close</button></div></div>';
  document.body.appendChild(host);
  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.classList.contains('modal-backdrop')) {
      retireHost(host);
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
// SIZE ON OPEN (user ruling 2026-09-07, second cut): the console NEVER asks
// Telegram to change its window on its own. It fills whatever it is given —
// the phone sheet after `expand()`, or the desktop window at whatever size the
// manager last dragged it to.
//
// What was verified against Telegram Web's source (telegram-tt,
// src/components/modals/browser/BrowserModal.tsx + WebAppTab.tsx) before this
// was settled, because the first two cuts guessed and guessed wrong:
//   - the Mini App window has three states — minimized, MAXIMIZED (a floating
//     window with the header controls, draggable and resizable), FULLSCREEN
//     (fills the whole tab, header gone);
//   - `requestFullscreen()` from a bot → FULLSCREEN. Nothing a bot sends can
//     make the MAXIMIZED window bigger; `expand()` has no handler at all there;
//   - the MAXIMIZED window's size IS REMEMBERED (`updateBrowserCachedSize`):
//     the next open uses the cached size, default 420×730, minimum 300×300.
// So "open at the size of my window" is the client's job and it already does
// it: drag once, and it stays. A load-time fullscreen request was the wrong
// tool — it took the whole tab and removed the very controls that resize.
//
// The toolbar keeps ONE button that toggles Telegram's fullscreen (Bot API
// 8.0) for the manager who wants the whole tab for a while; a click is the
// only way in, never the page on its own.
function canFullscreen() {
  return !!(
    tg &&
    typeof tg.requestFullscreen === 'function' &&
    typeof tg.isVersionAtLeast === 'function' &&
    tg.isVersionAtLeast('8.0')
  );
}
if (tg) {
  tg.ready();
  if (typeof tg.expand === 'function') tg.expand();
  // A phone's day list scrolls; a pull at its top must scroll, not minimise
  // the Mini App (Telegram's own vertical swipe-to-close, Bot API 7.7+).
  if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
}
// Ctrl+Z / ⌘Z — outside any text field or open dialog, where the keystroke
// already means something else.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
  if (e.repeat) return; // a held key must not fire a dozen undos
  const t = e.target;
  const typing =
    t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (typing || document.querySelector('.modal-host:not(.is-closing)')) return;
  if (!state.undo.length || !isManager()) return;
  e.preventDefault();
  undoLast();
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(repaintIfShapeChanged, 120);
});
if (tg && typeof tg.onEvent === 'function') {
  // A fullscreen flip changes the width the rail decision reads AND the
  // toolbar glyph; repaint.
  tg.onEvent('fullscreenChanged', () => {
    if (state.data) render();
  });
  // The popup's edges being dragged, or a phone keyboard shrinking the
  // viewport — the tree decision reads the width, so repaint (debounced
  // through the same timer as resize).
  tg.onEvent('viewportChanged', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(repaintIfShapeChanged, 150);
  });
  tg.onEvent('fullscreenFailed', () => {
    toast('Telegram kept the small window — drag its edges to widen it', 'error');
  });
}
wireTouchNav();
// The anchor starts on the browser's idea of today ONLY to make the first
// request; the server answers with the firm-local date and every later decision
// (what "Today" means, what counts as past) uses that.
state.anchor = new Date().toISOString().slice(0, 10);
state.today = state.anchor;
load();
