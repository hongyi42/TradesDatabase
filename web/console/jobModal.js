// The new-job window, and the small editor behind a card's "Edit".
//
// The FIELDS ARE OURS, not the reference product's. What a manager can state
// here is exactly what the spine stores about a job: who it is for, what it is
// called, how urgent, when, and who is going. There is no line-item table, no
// tax row and no price book, because none of those exist in this schema, and a
// form that collects them would be collecting nothing.
//
// Two fields are deliberately ABSENT even though the column exists:
//   job_type   — set from chat, where the duration vocabulary lives. The board
//                refuses it for the same reason; a second surface inventing
//                type strings is how a vocabulary rots.
//   notes      — job_notes is PLANNER-PRIVATE by migration (20260901120000),
//                and a manager's prose belongs in a capture with a channel,
//                not in the planner's notepad. Until that path exists, the
//                honest thing is not to offer a box that quietly drops text.

import { api, ApiError } from './api.js';
import { esc } from './grid.js';
import { employeeColors, initials } from './palette.js';

const PRIORITIES = ['emergency', 'urgent', 'routine', 'maintenance'];

let host = null;

// A window leaves the way it came: shrinking back to the centre (user,
// 2026-09-08). The host is marked at once — nothing treats a closing window
// as open, nothing in it takes a click — and removed when the shrink ends,
// or straight away where motion is reduced. Shared by every centred window:
// the forms here, the visit sheet and the confirm in app.js.
export function retireHost(h) {
  if (!h || !h.isConnected || h.classList.contains('is-closing')) return;
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    h.remove();
    return;
  }
  h.classList.add('is-closing');
  const gone = () => h.remove();
  const panel = h.querySelector('.modal');
  if (panel) panel.addEventListener('animationend', (e) => e.target === panel && gone(), { once: true });
  window.setTimeout(gone, 300);
}

function closeModal() {
  const h = host;
  host = null;
  retireHost(h);
  document.removeEventListener('keydown', onEsc);
}

function onEsc(e) {
  if (e.key === 'Escape') closeModal();
}

function openModal(title, bodyHtml, footerHtml) {
  closeModal();
  host = document.createElement('div');
  host.className = 'modal-host';
  host.innerHTML =
    '<div class="modal-backdrop"></div>' +
    '<div class="modal" role="dialog" aria-modal="true">' +
    '<div class="modal-head"><h2>' + esc(title) + '</h2>' +
    '<button type="button" class="icon-btn" data-close="1" aria-label="Close">✕</button></div>' +
    '<div class="modal-body">' + bodyHtml + '</div>' +
    '<div class="modal-foot">' + footerHtml + '</div>' +
    '</div>';
  document.body.appendChild(host);
  // Delegated, not bound per button: the header's X and the footer's Cancel
  // both carry data-close, and a querySelector here wired only the first one
  // (2026-09-07 preview finding — Cancel did nothing).
  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.classList.contains('modal-backdrop')) {
      closeModal();
    }
  });
  document.addEventListener('keydown', onEsc);
  return host;
}

function setError(msg) {
  if (!host) return;
  const box = host.querySelector('.modal-error');
  if (!box) return;
  box.textContent = msg || '';
  box.hidden = !msg;
}

function crewPickerHtml(roster, preselected) {
  if (!roster.length) return '<p class="hint">No active technicians on the roster.</p>';
  return (
    '<div class="crew-picker">' +
    roster
      .map(
        (t) =>
          '<label class="crew-option"><input type="checkbox" name="crew" value="' +
          esc(t.ref) + '"' + (preselected.indexOf(t.ref) >= 0 ? ' checked' : '') + '>' +
          '<span class="chip" style="background:' + employeeColors(t.ref).solid + '">' +
          esc(initials(t.name)) + '</span>' + esc(t.name) + '</label>',
      )
      .join('') +
    '</div>'
  );
}

// ── New job ──────────────────────────────────────────────────────────────────
export function openNewJob(opts) {
  const preselected = opts.technicianRef ? [opts.technicianRef] : [];
  const body =
    '<div class="modal-error" hidden></div>' +
    '<form id="newjob-form">' +
    '<section class="field-group">' +
    '<h3>Customer</h3>' +
    '<div class="tabs-inline">' +
    '<button type="button" class="tab-inline active" data-cust-tab="existing">Existing</button>' +
    '<button type="button" class="tab-inline" data-cust-tab="new">New customer</button>' +
    '</div>' +
    '<div data-cust-pane="existing">' +
    '<input type="search" id="cust-search" placeholder="Search name, phone or address" autocomplete="off">' +
    '<div id="cust-results" class="results"></div>' +
    '<input type="hidden" name="customerId">' +
    '<div id="cust-chosen" class="chosen" hidden></div>' +
    '</div>' +
    '<div data-cust-pane="new" hidden>' +
    '<input name="newName" placeholder="Name" autocomplete="off">' +
    '<input name="newPhone" placeholder="Phone" autocomplete="off">' +
    '<input name="newAddress" placeholder="Address" autocomplete="off">' +
    '<div class="row"><input name="newCity" placeholder="City" autocomplete="off">' +
    '<input name="newState" placeholder="State" autocomplete="off" size="4">' +
    '<input name="newPostal" placeholder="ZIP" autocomplete="off" size="8"></div>' +
    '</div>' +
    '</section>' +

    '<section class="field-group">' +
    '<h3>The work</h3>' +
    '<input name="title" placeholder="What is the job? (e.g. no cooling upstairs)" autocomplete="off">' +
    '<label class="lbl">Priority</label>' +
    '<select name="priority">' +
    PRIORITIES.map(
      (p) => '<option value="' + p + '"' + (p === 'routine' ? ' selected' : '') + '>' + p + '</option>',
    ).join('') +
    '</select>' +
    '</section>' +

    '<section class="field-group">' +
    '<h3>When</h3>' +
    '<label class="check"><input type="checkbox" name="untimed"> No time yet — put it in the tray</label>' +
    '<div class="row" data-when>' +
    '<input type="date" name="date" value="' + esc(opts.date || '') + '">' +
    '<input type="time" name="startTime" value="' + esc(opts.startTime || '') + '" step="900">' +
    '<input type="time" name="endTime" value="' + esc(opts.endTime || '') + '" step="900">' +
    '</div>' +
    '<p class="hint">The booked span is recorded as the job’s length — measured, never guessed.</p>' +
    '</section>' +

    '<section class="field-group">' +
    '<h3>Who</h3>' +
    crewPickerHtml(opts.roster || [], preselected) +
    '<p class="hint">Leave everyone unticked to put it on the calendar unassigned.</p>' +
    '</section>' +
    '</form>';

  const footer =
    '<button type="button" class="btn" data-close="1">Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="newjob-save">Create job</button>';

  const el = openModal('New job', body, footer);
  const form = el.querySelector('#newjob-form');

  // Customer tabs
  el.querySelectorAll('[data-cust-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.getAttribute('data-cust-tab');
      el.querySelectorAll('[data-cust-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      el.querySelectorAll('[data-cust-pane]').forEach((p) => {
        p.hidden = p.getAttribute('data-cust-pane') !== which;
      });
    });
  });

  // Untimed toggle. Controls are reached through form.elements throughout this
  // file, never as form.<name>: HTMLFormElement already HAS a `title` property
  // (the HTML title attribute), so `form.title` silently returns a string
  // instead of the input, and the job title would post as undefined.
  const untimed = form.elements.untimed;
  const whenRow = el.querySelector('[data-when]');
  untimed.addEventListener('change', () => {
    whenRow.hidden = untimed.checked;
  });

  // Customer search — debounced, and the query is only sent once it can mean
  // something (the server ignores anything shorter than two characters).
  let timer = null;
  const search = el.querySelector('#cust-search');
  const results = el.querySelector('#cust-results');
  search.addEventListener('input', () => {
    window.clearTimeout(timer);
    const q = search.value.trim();
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    timer = window.setTimeout(async () => {
      try {
        const out = await api.customers(q);
        results.innerHTML = out.customers.length
          ? out.customers
              .map(
                (c) =>
                  '<button type="button" class="result" data-id="' + esc(c.id) + '" data-name="' +
                  esc(c.name) + '">' + esc(c.name) +
                  (c.phone ? '<span class="result-sub">' + esc(c.phone) + '</span>' : '') +
                  (c.address ? '<span class="result-sub">' + esc(c.address) + '</span>' : '') +
                  '</button>',
              )
              .join('')
          : '<p class="hint">No match. Use “New customer” if they are not on file.</p>';
      } catch (err) {
        setError(err.message);
      }
    }, 220);
  });

  results.addEventListener('click', (e) => {
    const btn = e.target.closest('.result');
    if (!btn) return;
    form.elements.customerId.value = btn.getAttribute('data-id');
    const chosen = el.querySelector('#cust-chosen');
    chosen.hidden = false;
    chosen.textContent = btn.getAttribute('data-name');
    results.innerHTML = '';
    search.value = '';
  });

  el.querySelector('#newjob-save').addEventListener('click', () => submitNewJob(el, form, opts, false));
}

function readNewJobBody(form) {
  const f = form.elements;
  const crew = [...form.querySelectorAll('input[name="crew"]:checked')].map((i) => i.value);
  const untimed = f.untimed.checked;
  const body = {
    title: f.title.value.trim() || undefined,
    priority: f.priority.value,
  };
  if (crew.length) body.technicianRefs = crew;
  if (!untimed) {
    body.date = f.date.value;
    body.startTime = f.startTime.value;
    body.endTime = f.endTime.value;
  }
  if (f.customerId.value) {
    body.customerId = f.customerId.value;
  } else {
    const name = f.newName.value.trim();
    if (!name) return { error: 'Pick a customer, or fill in a name under “New customer”.' };
    body.newCustomer = {
      name: name,
      phone: f.newPhone.value.trim() || undefined,
      addressLine1: f.newAddress.value.trim() || undefined,
      city: f.newCity.value.trim() || undefined,
      state: f.newState.value.trim() || undefined,
      postalCode: f.newPostal.value.trim() || undefined,
    };
  }
  if (!untimed && (!body.date || !body.startTime || !body.endTime)) {
    return { error: 'Give a date and both times, or tick “No time yet”.' };
  }
  return { body: body };
}

async function submitNewJob(el, form, opts, force) {
  const read = readNewJobBody(form);
  if (read.error) {
    setError(read.error);
    return;
  }
  const body = read.body;
  if (force) body.forceNewJob = true;
  const save = el.querySelector('#newjob-save');
  save.disabled = true;
  setError('');
  try {
    const result = await api.newJob(body);
    closeModal();
    opts.onDone(
      'Booked' +
        (result.date ? ' ' + result.date + ' ' + (result.startTime || '') : ' with no time yet') +
        (result.warning ? ' — ' + result.warning : ''),
    );
  } catch (err) {
    save.disabled = false;
    // THE MINT GUARD. A refusal here is not a failure — it is the server saying
    // this customer already has open work and asking whether this is genuinely
    // something else. The list travels verbatim; the manager decides, and only
    // then does forceNewJob get set. Auto-retrying would delete the guard.
    if (err instanceof ApiError && err.status === 409 && !force) {
      setError(err.message);
      const foot = el.querySelector('.modal-foot');
      if (!foot.querySelector('#newjob-force')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'newjob-force';
        btn.className = 'btn btn-danger';
        btn.textContent = 'This is different work — create anyway';
        btn.addEventListener('click', () => submitNewJob(el, form, opts, true));
        foot.appendChild(btn);
      }
      return;
    }
    setError(err.message);
  }
}

// ── Edit an existing job ─────────────────────────────────────────────────────
// Title, priority and length — the same three the board edits, for the same
// reason: they are the fields a dispatcher changes while looking at a calendar.
// Move or book through a form: date, start, end, and who. This is the FLOOR
// every tree has — the grid's drag is the desktop accelerator over it, and a
// touch device (phone list, or an iPad on the grid, where HTML5 drag never
// fires) has only this. `mode: 'move'` offers "keep the current crew";
// `mode: 'book'` (a tray job, no visit yet) does not. The crew here is one
// person or nobody — multi-person crews are set on the desktop or in chat.
export function openMoveVisit(opts) {
  const roster = opts.roster || [];
  const crew = opts.crew || [];
  // Everyone on the roster, then anyone on the visit who is no longer on it
  // (still shown, so they can be unticked). A crew is a SET of people — a
  // two-person install is the common case, not the exception (user,
  // 2026-09-08) — so this is a tick list, not a drop-down.
  const people = roster.map((t) => ({ ref: t.ref, name: t.name || t.ref }));
  for (const ref of crew) if (!people.some((p) => p.ref === ref)) people.push({ ref: ref, name: ref });
  const body =
    '<div class="modal-error" hidden></div>' +
    '<form id="move-form">' +
    '<section class="field-group">' +
    '<h3>When</h3>' +
    '<div class="row">' +
    '<input type="date" name="date" value="' + esc(opts.date || '') + '">' +
    '<input type="time" name="startTime" value="' + esc(opts.startTime || '') + '" step="900">' +
    '<input type="time" name="endTime" value="' + esc(opts.endTime || '') + '" step="900">' +
    '</div>' +
    '</section>' +
    '<section class="field-group">' +
    '<h3>Who</h3>' +
    '<div class="crew-pick">' +
    people
      .map(
        (p) =>
          '<label class="crew-opt"><input type="checkbox" name="crew" value="' + esc(p.ref) + '"' +
          (crew.includes(p.ref) ? ' checked' : '') + '>' +
          '<span class="chip" style="background:' + employeeColors(p.ref).solid + '">' +
          esc(initials(p.name)) + '</span>' +
          '<span class="crew-name">' + esc(p.name) + '</span></label>',
      )
      .join('') +
    (people.length ? '' : '<p class="hint">Nobody on the roster.</p>') +
    '</div>' +
    '<p class="hint crew-hint">Tick everyone who goes. Nobody ticked = unassigned.' +
    (opts.mode === 'move' ? ' Left as it is, the crew stays.' : '') + '</p>' +
    '</section>' +
    '</form>';
  const footer =
    '<button type="button" class="btn" data-close="1">Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="move-save">' +
    (opts.mode === 'book' ? 'Book it' : 'Move it') + '</button>';
  const el = openModal(opts.title || (opts.mode === 'book' ? 'Book' : 'Move visit'), body, footer);
  const form = el.querySelector('#move-form');
  el.querySelector('#move-save').addEventListener('click', () => {
    const f = form.elements;
    const date = f.date.value;
    const startTime = f.startTime.value;
    const endTime = f.endTime.value;
    if (!date || !startTime || !endTime) {
      setError('Date, start and end are all needed.');
      return;
    }
    if (endTime <= startTime) {
      setError('The end must be after the start.');
      return;
    }
    const picked = [...form.querySelectorAll('input[name="crew"]:checked')].map((i) => i.value);
    const same = picked.length === crew.length && picked.every((r) => crew.includes(r));
    // null = leave the crew alone (nothing was changed, and a move must not
    // overwrite a crew somebody else set meanwhile); [] = nobody; [refs] = them.
    const next = opts.mode === 'move' && same ? null : picked;
    closeModal();
    opts.onSubmit({ date: date, startTime: startTime, endTime: endTime, crew: next });
  });
}

export function openEditJob(opts) {
  const body =
    '<div class="modal-error" hidden></div>' +
    '<form id="editjob-form">' +
    '<label class="lbl">Title</label>' +
    '<input name="title" value="' + esc(opts.title || '') + '" autocomplete="off">' +
    '<label class="lbl">Priority</label>' +
    '<select name="priority">' +
    PRIORITIES.map(
      (p) =>
        '<option value="' + p + '"' + (p === opts.priority ? ' selected' : '') + '>' + p + '</option>',
    ).join('') +
    '</select>' +
    '<label class="lbl">Length (minutes)</label>' +
    '<input name="durationMinutes" type="number" min="1" max="1440" step="5" value="' +
    esc(opts.durationMinutes == null ? '' : opts.durationMinutes) + '">' +
    '<p class="hint">Common lengths: 15, 30, 45, 60, 90, 120, 180, 240, 360, 480. Any whole ' +
    'number is fine. Leave blank to say the length is not known.</p>' +
    '</form>';
  const footer =
    '<button type="button" class="btn" data-close="1">Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="editjob-save">Save</button>';
  const el = openModal('Edit job', body, footer);
  const form = el.querySelector('#editjob-form');

  el.querySelector('#editjob-save').addEventListener('click', async () => {
    const f = form.elements;
    const patch = { jobId: opts.jobId };
    const title = f.title.value.trim();
    if (title) patch.title = title;
    if (f.priority.value !== opts.priority) patch.priority = f.priority.value;
    const raw = f.durationMinutes.value.trim();
    // Blank is the CLEAR arm, not "leave alone" — the field is pre-filled with
    // the stored value, so emptying it is a deliberate "we do not know".
    const next = raw === '' ? null : Number(raw);
    if (next !== (opts.durationMinutes == null ? null : opts.durationMinutes)) {
      patch.durationMinutes = next;
    }
    if (Object.keys(patch).length === 1) {
      closeModal();
      return;
    }
    setError('');
    try {
      await api.editJob(patch);
      closeModal();
      // What changed and what it was — enough for the caller to offer an undo.
      opts.onDone('Job updated', {
        patch: patch,
        previous: {
          title: opts.title || null,
          priority: opts.priority,
          durationMinutes: opts.durationMinutes == null ? null : opts.durationMinutes,
        },
      });
    } catch (err) {
      setError(err.message);
    }
  });
}

export { closeModal };
