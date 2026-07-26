// Dispatch board page script. Runs inside the Telegram Mini App webview; the
// server verifies every API call's initData, so this file holds NO auth logic —
// it just forwards the slip. Times/dates print VERBATIM (naive-local rule:
// start.slice(11,16), dates as stored) — no timezone math in the browser (the
// only date arithmetic below is day-window widening on the SERVER's `from`).
//
// Write path (managers only) inherits Feature A's confirmation doctrine via
// the server previews: requiresConfirmation false → commit one-shot and toast
// what happened; true → one in-UI confirm showing the promise break. Never
// ask twice, never confirm a reversible internal change.
/* global Telegram */
(function () {
  'use strict';

  var tg = window.Telegram && Telegram.WebApp;
  var app = document.getElementById('app');
  // view: 'team' | 'mine' — managers get a tab bar; technicians are always
  // effectively 'mine' (server-filtered) and never see tabs. Writes (drag/✕)
  // exist ONLY on the Team tab: Mine is a read-only "my week" glance.
  // weekOffset: whole CALENDAR weeks (Mon–Sun) from the firm-local current
  // week (0 = the week containing today, 1 = next, -1 = last …) — the ‹ ›
  // pager. Committed only when a load SUCCEEDS (same rule as view: a failed
  // page-flip must leave the controls agreeing with the week on screen).
  // today: the firm-local date from the server anchor — week 0 CONTAINS past
  // days now (Mon–Sun, not today+6), and those must be as read-only as past
  // weeks: a live drop target on yesterday is a one-mis-drag history rewrite.
  var state = {
    isManager: false,
    rendered: false,
    view: 'team',
    weekOffset: 0,
    today: null,
    // Last-fetched loose-bucket COUNT (managers only) — feeds the header
    // pill between loads. Only the number is kept: the tray re-fetches on
    // open, and a cached payload would invite rendering stale rows from it.
    bucketCount: null,
    // Session-cached roster for the assign picker (plan 4a.5) — fetched on
    // first picker open, never on the load path. Names change rarely; a
    // reopen of the webview clears it naturally.
    roster: null,
    // Last-rendered stops per date — the picker's client-side busy hints
    // ("2 visits Thu") come from data the board already painted.
    stopsByDate: null,
  };

  function actionable() {
    // Writes need all three: a manager, the Team tab, and a NON-PAST week.
    // Past weeks are read-only history — every day there is a drop target
    // otherwise, and a mis-drag would rewrite the record one-shot (review
    // finding). Deliberate history corrections stay a chat job.
    return state.isManager && state.view === 'team' && state.weekOffset >= 0;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    var map = {
      bg_color: '--bg',
      text_color: '--fg',
      hint_color: '--hint',
      button_color: '--accent',
      button_text_color: '--accent-fg',
      secondary_bg_color: '--card',
    };
    Object.keys(map).forEach(function (k) {
      if (tg.themeParams[k]) document.documentElement.style.setProperty(map[k], tg.themeParams[k]);
    });
  }

  function showEmpty(msg) {
    app.innerHTML = '<div class="empty">' + esc(msg) + '</div>';
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = isError ? 'error show' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = el.className.replace('show', '');
    }, 4000);
  }

  function confirmAsk(message, cb) {
    if (tg && typeof tg.showConfirm === 'function') tg.showConfirm(message, cb);
    else cb(window.confirm(message));
  }

  function hhmm(iso) {
    return iso.slice(11, 16);
  }

  // Day-window widening on the server-supplied firm-local `from` — pure UTC
  // string math on YYYY-MM-DD, no local-clock involvement.
  function addDays(ymd, n) {
    return new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  }

  // Monday of the calendar week containing ymd (getUTCDay: 0=Sun…6=Sat).
  function mondayOf(ymd) {
    var dow = new Date(Date.parse(ymd + 'T00:00:00Z')).getUTCDay();
    return addDays(ymd, -((dow + 6) % 7));
  }

  // Weekday label for a stored YYYY-MM-DD — same UTC string math as addDays
  // (naive-local rule: the date names itself; the phone's timezone must not
  // shift which weekday a stored day claims to be).
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dayName(ymd) {
    return DOW[new Date(Date.parse(ymd + 'T00:00:00Z')).getUTCDay()];
  }

  function stopBadges(stop) {
    var badges = '';
    if (stop.promiseLevel && stop.promiseLevel !== 'none') {
      // Four-level ladder (plan 4a.5): 'time' stores day+time; 'time_only'
      // stores a time with no day. Labels say exactly what was promised.
      var lbl =
        stop.promiseLevel === 'time'
          ? 'promised day+time'
          : stop.promiseLevel === 'time_only'
            ? 'promised time'
            : 'promised day';
      badges += '<span class="badge promise">' + lbl + '</span>';
    }
    // `locked` is NOT badged: it marks a manual placement for the FUTURE
    // auto-scheduler to route around — today every visit is manual, so the
    // badge read as "can't be changed" on rows that are freely movable
    // (user finding 2026-07-23). The promise ladder is what actually gates
    // changes, and it has its own badge above. Revisit the flag's display
    // when the 4b solver gives "pinned" real meaning.
    return badges;
  }

  function stopCard(stop, canAct) {
    // .draggable is what carries touch-action:none — the read-only surfaces
    // (technician view, manager's Mine tab, past weeks AND past days inside
    // the current calendar week) must keep native card-origin scrolling.
    // canAct comes from renderDay: actionable() AND the day not being past.
    return (
      '<div class="stop' + (canAct ? ' draggable' : '') + '" data-id="' + esc(stop.assignmentId) + '"' +
      ' data-start="' + esc(hhmm(stop.start)) + '" data-end="' + esc(hhmm(stop.end)) + '"' +
      ' data-ref="' + esc(stop.technicianRef || '') + '">' +
      '<div class="stop-time">' + esc(hhmm(stop.start)) + '–' + esc(hhmm(stop.end)) + '</div>' +
      '<div class="stop-body"><div class="stop-customer">' +
      esc(stop.customer || 'Unknown customer') +
      '</div>' +
      (stop.address ? '<div class="stop-address">' + esc(stop.address) + '</div>' : '') +
      '</div><div class="stop-badges">' + stopBadges(stop) + '</div>' +
      (canAct
        ? '<button type="button" class="stop-cancel" aria-label="Unschedule visit">✕</button>'
        : '') +
      '</div>'
    );
  }

  function lane(cls, laneRef, label, stops, canAct) {
    return (
      '<div class="' + cls + '" data-lane="' + esc(laneRef) + '"><h3>' + esc(label) + '</h3>' +
      stops
        .map(function (s) {
          return stopCard(s, canAct);
        })
        .join('') +
      '</div>'
    );
  }

  // Team layout (manager's Team tab): per-technician lanes plus an
  // "Unassigned" lane for stops with unassigned:true (their technicianName is
  // null — never print "null"). Lanes are keyed by technicianRef — the UNIQUE
  // roster handle — never by display name (two "Mike Chen"s must not merge,
  // and drag-to-assign needs a single ref per drop target). Since plan 4a.5
  // the unassigned lane is BOTH drag source and drop target (dropping parks
  // the visit — moveVisit's unassign detach); its data-lane is ''. Flat
  // layout (technician view, manager's Mine tab): a plain time-ordered list,
  // no lanes.
  // One "no time yet" strip card (plan 4b-2): an assigned visit holding this
  // day (or a range covering it) with no time. Tappable into the normal
  // detail sheet; a multi-day range is labelled in full so it reads as ONE
  // visit appearing on each covered day, never as three visits.
  function tbdCard(u) {
    var range =
      u.earliestDate === u.latestDate
        ? ''
        : ' · ' + u.earliestDate + ' – ' + u.latestDate;
    return (
      '<div class="tbd-card" data-id="' + esc(u.assignmentId) + '">' +
      '<div class="tbd-main">' + esc(u.customer || 'Unknown customer') +
      (u.jobTitle ? ' — ' + esc(u.jobTitle) : '') + '</div>' +
      '<div class="tbd-sub">' +
      esc(
        (u.technicianName || 'Unassigned') +
          ' · ' +
          (u.jobDurationMinutes != null ? fmtDur(u.jobDurationMinutes) : 'length not set') +
          range,
      ) +
      '</div></div>'
    );
  }

  function renderDay(date, stops, teamLayout, unplaced) {
    // Per-DAY write gate: the calendar week 0 contains already-past days, and
    // those are as read-only as past weeks (a live drop target on yesterday
    // is a one-mis-drag history rewrite). state.today is the firm-local
    // anchor; null (never loaded) fails safe to read-only via actionable()
    // being unreachable pre-render.
    var canAct = actionable() && state.today !== null && date >= state.today;
    // Mark the firm-local current day — with Mon–Sun weeks, "which day is
    // today" is no longer implicit in the window's first row.
    var isToday = state.today !== null && date === state.today;
    var html =
      '<section class="day' + (isToday ? ' today' : '') + '" data-date="' + esc(date) + '">' +
      '<h2>' + esc(dayName(date)) + ' · ' + esc(date) +
      (isToday ? ' <span class="today-tag">Today</span>' : '') + '</h2>';
    if (unplaced && unplaced.length) {
      html +=
        '<div class="tbd-strip"><div class="tbd-strip-title">No time yet</div>' +
        unplaced.map(tbdCard).join('') +
        '</div>';
    }
    if (!stops.length) {
      if (!unplaced || !unplaced.length) html += '<div class="day-empty">No visits</div>';
    } else if (!teamLayout) {
      html += stops
        .map(function (s) {
          return stopCard(s, canAct);
        })
        .join('');
    } else {
      var lanes = {};
      var labels = {};
      var order = [];
      var unassigned = [];
      stops.forEach(function (stop) {
        if (stop.unassigned) {
          unassigned.push(stop);
          return;
        }
        var key = stop.technicianRef;
        if (!lanes[key]) {
          lanes[key] = [];
          labels[key] = stop.technicianName || key;
          order.push(key);
        }
        lanes[key].push(stop);
      });
      order.sort();
      order.forEach(function (key) {
        html += lane('lane', key, labels[key], lanes[key], canAct);
      });
      // Unassigned lane renders last so it reads as the "to place" tray.
      // On actionable days it renders even EMPTY: it is drag-to-park's drop
      // target, and a lane that only exists when a parked visit already does
      // would leave the gesture targetless on every clean day (plan review
      // finding #4).
      if (unassigned.length || canAct) {
        html += lane('lane lane-unassigned', '', 'Unassigned', unassigned, canAct);
      }
    }
    return html + '</section>';
  }

  function tabsBar() {
    return (
      '<nav class="tabs">' +
      '<button type="button" class="tab' + (state.view === 'team' ? ' active' : '') + '" data-view="team">Team</button>' +
      '<button type="button" class="tab' + (state.view === 'mine' ? ' active' : '') + '" data-view="mine">My schedule</button>' +
      '</nav>'
    );
  }

  // Week pager (all tiers, both tabs): ‹ › page one Mon–Sun calendar week per
  // tap — the window stays 7 days, so every request remains inside the
  // server's 14-day cap. The label is the rendered week's DATE RANGE (from
  // the server echo — user decision 2026-07-19, replacing "N weeks ahead");
  // "Today" appears only when away from the current week.
  function pagerBar(from, to) {
    return (
      '<nav class="pager">' +
      '<button type="button" class="pager-btn" data-page="-1" aria-label="Previous week">‹</button>' +
      '<div class="pager-label">' + esc(from) + ' → ' + esc(to) + '</div>' +
      (state.weekOffset !== 0
        ? '<button type="button" class="pager-btn pager-today" data-page="0">Today</button>'
        : '') +
      '<button type="button" class="pager-btn" data-page="1" aria-label="Next week">›</button>' +
      '</nav>'
    );
  }

  function render(data) {
    var isManager = data.tier === 'manager';
    // Trust the server's resolved view, not what we asked for — a stale or
    // rejected param must never leave the page believing it shows "mine"
    // while rendering team data (or vice versa). Technicians have no tabs;
    // their state.view stays at its default.
    if (isManager && data.view) state.view = data.view;
    var teamLayout = isManager && data.view !== 'mine';
    var byDate = {};
    var unplacedByDate = {};
    data.days.forEach(function (d) {
      byDate[d.date] = d.stops;
      unplacedByDate[d.date] = d.unplaced || [];
    });
    // The picker's busy hints read from what the board just painted — but
    // ONLY the team layout shows the whole team; a Mine-tab payload holds one
    // person's stops, and hints computed from it would claim busy technicians
    // are "free" (final-review finding). null = busyHint makes no claim.
    state.stopsByDate = teamLayout ? byDate : null;
    // The dates live in the pager label now; this line carries only context
    // (whose stops / read-only) and disappears when there is none.
    var note = !isManager
      ? 'Your stops'
      : data.view === 'mine'
        ? 'Your visits'
        : state.weekOffset < 0
          ? 'Past week — read-only'
          : '';
    // The loose-bucket pill (managers only): the can't-forget signal for
    // parked visits + unscheduled jobs. Count fills asynchronously AFTER the
    // board paints (fetchBucket) — nothing new on the button path; between
    // loads the last known count renders immediately.
    var pill = isManager
      ? '<button type="button" class="bucket-pill" id="bucket-pill">' +
        esc(state.bucketCount === null ? 'Loose: …' : 'Loose: ' + state.bucketCount) +
        '</button>'
      : '';
    var head =
      '<header><div class="head-row"><h1>Dispatch board</h1>' + pill + '</div>' +
      (isManager ? tabsBar() : '') +
      pagerBar(data.from, data.to) +
      (note ? '<div class="range">' + esc(note) + '</div>' : '') +
      '</header>';
    // Render EVERY day in the window, empty ones included — empty days are the
    // drop targets that make "move to Thursday" possible at all.
    var html = head;
    // Technician horizon (Plan 4a): a window FULLY beyond the horizon
    // (from > horizonEnd — structured field, never parse the sentence) shows
    // the note alone, not empty day sections claiming "No visits". A TRIMMED
    // window renders its (already-trimmed) days — empty ones included; those
    // days ARE published — with the note after.
    if (data.horizonNote && data.horizonEnd && data.from > data.horizonEnd) {
      html += '<div class="empty">' + esc(data.horizonNote) + '</div>';
    } else {
      var date = data.from;
      while (date <= data.to) {
        html += renderDay(date, byDate[date] || [], teamLayout, unplacedByDate[date] || []);
        date = addDays(date, 1);
      }
      if (data.horizonNote) html += '<div class="range">' + esc(data.horizonNote) + '</div>';
    }
    app.innerHTML = html;
    state.rendered = true;
  }

  // ---- API ----

  function authHeaders() {
    return { Authorization: 'tma ' + tg.initData, 'content-type': 'application/json' };
  }

  // HTTP-level load failures: blank the page ONLY when there is nothing on it
  // yet. Once a board is rendered, a failed reload (now routine — tab clicks
  // refetch) keeps the last good view and toasts instead: replacing a healthy
  // board plus its tab bar with a dead-end error screen left no way back in.
  function loadFailed(msg) {
    if (state.rendered) toast(msg, true);
    else showEmpty(msg);
  }

  function apiGet(query) {
    return fetch('/board/api/day' + query, { headers: authHeaders() }).then(function (resp) {
      if (resp.status === 409) {
        loadFailed('This Telegram account matches more than one roster entry — ask your operator.');
        return null;
      }
      if (!resp.ok) {
        loadFailed(
          resp.status >= 500
            ? 'Server problem — try again shortly.'
            : "Couldn't verify you (" + resp.status + '). Reopen the board from Telegram.',
        );
        return null;
      }
      return resp.json();
    });
  }

  function apiPost(path, body, isPreview) {
    return fetch(path + (isPreview ? '?preview=1' : ''), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }).then(function (resp) {
      return resp
        .json()
        .catch(function () {
          return {};
        })
        .then(function (parsed) {
          return { ok: resp.ok, status: resp.status, body: parsed };
        });
    });
  }

  // `requestedView`/`requestedOffset` are what the user ASKED for; the state
  // stays the COMMITTED (rendered) values and moves only when a load lands.
  // A failed fetch therefore leaves state and DOM agreeing — the review-caught
  // alternative (flip state at click time) let a failed tab switch arm
  // drag-writes on a list still rendered read-only, and would make a failed
  // page-flip skip weeks on the retry tap.
  function load(requestedView, requestedOffset) {
    var offset = requestedOffset === undefined ? state.weekOffset : requestedOffset;
    // The selected tab rides as view=mine (harmless on the anchor call; the
    // server ignores it for non-managers).
    var v = (requestedView || state.view) === 'mine' ? 'view=mine' : '';

    // Fetch + render the selected 7-day CALENDAR week from a known firm-local
    // anchor. Weeks are Mon–Sun: Monday of the anchor's week, offset in whole
    // weeks from there (week 0 contains today, so it can include already-past
    // days).
    function fetchWeek(anchor) {
      var from = addDays(mondayOf(anchor), offset * 7);
      return apiGet(
        '?from=' + from + '&to=' + addDays(from, 6) + (v ? '&' + v : ''),
      ).then(function (data) {
        if (!data) return null;
        state.isManager = data.tier === 'manager';
        // Commit BEFORE render on purpose: render's pager label and the
        // actionable()/past-day checks inside renderDay read the committed
        // values. A throw inside render can't strand a wrong commit — the
        // server always returns renderable days on a 200 (readBoardDays shape).
        state.weekOffset = offset;
        state.today = anchor;
        render(data);
        // Pill fill AFTER the paint, manager-gated, never awaited (a
        // technician call would be a guaranteed 403 — review gap #2). The
        // roster warm-up rides the same rule (4a.6).
        if (data.tier === 'manager') {
          fetchBucket();
          prefetchRoster();
        }
        return data;
      });
    }

    // The firm-local `from` (server computes it — the client clock never
    // decides what "today" is) only needs to be learned ONCE. After the first
    // load state.today holds it, so every tab/pager/refresh reuses the cached
    // anchor instead of paying a whole extra round-trip (a full day read) just
    // to re-learn one date. visibilitychange clears state.today so a day
    // crossed while the webview was hidden still re-anchors on return.
    if (state.today) return fetchWeek(state.today);
    return apiGet(v ? '?' + v : '').then(function (first) {
      return first ? fetchWeek(first.from) : null;
    });
  }

  // Every load goes through this: a fetch-level REJECTION (network error, no
  // HTTP status) must never strand the page on "Loading…" or silently keep a
  // stale board after a committed write — the exact regression the Phase-2
  // .catch prevented before the Phase-3 rewrite dropped it.
  function refresh(requestedView, requestedOffset) {
    return load(requestedView, requestedOffset).catch(function () {
      if (state.rendered) toast('Network error — the board may be stale; try again.', true);
      else showEmpty('Network error — reopen the board to retry.');
    });
  }

  // ---- Loose-bucket pill + tray (managers only) ----

  function bucketCount(b) {
    return b.parkedVisits.length + b.unscheduledJobs.length;
  }

  function setPillText(text) {
    var pill = document.getElementById('bucket-pill');
    if (pill) pill.textContent = text;
  }

  // Async pill fill: fires AFTER a successful render, never awaited, and only
  // for managers (a technician call would be a guaranteed 403). A failure
  // leaves the pill at its last text — the pill is advisory, never a blocker.
  function fetchBucket() {
    return fetch('/board/api/bucket', { headers: authHeaders() })
      .then(function (resp) {
        if (!resp.ok) return null;
        return resp.json();
      })
      .then(function (b) {
        if (!b) return null;
        state.bucketCount = bucketCount(b);
        setPillText('Loose: ' + state.bucketCount);
        return b;
      })
      .catch(function () {
        return null;
      });
  }

  function bucketVisitRow(v) {
    // Server-composed strings verbatim (weekday/date/times) — no client date
    // math. Tappable: opens the visit's normal detail sheet; the Assign
    // button opens the picker (plan 4a.5 — the tray is manager-only, so the
    // affordance needs no tier gate here).
    // A time-TBD row (plan 4b-2) has no times — its main line says so and
    // carries the range; Assign posts an attach that KEEPS it unplaced.
    var whenTxt = v.timeTbd
      ? v.weekday + ' ' + v.date +
        (v.latestDate && v.latestDate !== v.date ? ' – ' + v.latestDate : '') +
        ' · no time yet'
      : v.weekday + ' ' + v.date + ' · ' + v.startTime + '–' + v.endTime;
    return (
      '<div class="bucket-row bucket-visit" data-id="' + esc(v.assignmentId) + '">' +
      '<div class="bucket-row-txt"><div class="bucket-row-main">' +
      esc(whenTxt) +
      '</div><div class="bucket-row-sub">' +
      esc(
        (v.overdue ? 'OVERDUE — the day passed with nobody assigned · ' : '') +
          (v.customer || 'Unknown customer') +
          (v.jobTitle ? ' — ' + v.jobTitle : '') +
          // The row was ALWAYS tappable into the full sheet, but "Assign" was
          // its only visible action, so the edit path read as nonexistent
          // (user finding 2026-07-23) — say it, like the job rows do. Overdue
          // rows open read-only (the date gate), so they promise less.
          (v.overdue ? ' · tap to open' : ' · tap to edit'),
      ) +
      '</div></div>' +
      // No Assign on OVERDUE rows: attaching keeps the visit's own (past)
      // date, and board writes never target the past (review finding #2 —
      // same rule as every other gate). Recovering an overdue visit means
      // rescheduling it, which stays a chat job for now.
      (v.overdue
        ? ''
        : '<button type="button" class="bucket-assign" data-id="' + esc(v.assignmentId) + '"' +
          ' data-date="' + esc(v.date) + '"' +
          (v.timeTbd
            ? ' data-tbd="1"'
            : ' data-start="' + esc(v.startTime) + '" data-end="' + esc(v.endTime) + '"') +
          '>Assign</button>') +
      '</div>'
    );
  }

  function bucketJobRow(j) {
    // Tappable (plan 4a.5): opens the booking sheet — the tray finally drains
    // from the same screen that shows it. Edit (4a.6): an unscheduled job's
    // title/priority were only reachable through a VISIT's sheet, so a
    // manager had to schedule a job before they could fix its description
    // (user finding 2026-07-23). /board/api/job is keyed by jobId and never
    // needed a visit — only the UI was missing.
    // data-duration mirrors data-title/priority (4b-1): without it the Edit
    // form would open showing "not set" on a job that HAS a length, and an
    // unrelated title edit would silently wipe the stored value.
    return (
      '<div class="bucket-row bucket-job" data-job="' + esc(j.jobId) + '"' +
      ' data-title="' + esc(j.title || '') + '" data-priority="' + esc(j.priority || '') + '"' +
      ' data-duration="' + (j.durationMinutes != null ? esc(String(j.durationMinutes)) : '') + '">' +
      '<div class="bucket-row-txt"><div class="bucket-row-main">' + esc(j.title || 'Untitled job') + '</div>' +
      '<div class="bucket-row-sub">' +
      esc(
        (j.customer || 'Unknown customer') + ' · ' + j.priority + ' · ' +
        (j.durationMinutes != null ? fmtDur(j.durationMinutes) : 'length not set') +
        ' · tap to book',
      ) +
      '</div></div>' +
      '<button type="button" class="bucket-edit">Edit</button>' +
      '</div>'
    );
  }

  function renderBucketSheet(b) {
    var rows;
    if (bucketCount(b) === 0) {
      rows = '<div class="bucket-empty">Nothing loose — all work is scheduled.</div>';
    } else {
      rows =
        // "Unassigned", never "parked" (user decision 2026-07-23): the tray
        // and the day-column lane show the SAME state (nobody attached) — two
        // names for one state read as two concepts. What differs is scope: the
        // lane shows the viewed day, the tray shows every day plus jobs with
        // no visit at all. `unassign` stays the VERB (an action, not a state).
        '<div class="bucket-section"><h3>Unassigned visits (' + b.parkedVisits.length + ')</h3>' +
        (b.parkedVisits.length
          ? b.parkedVisits.map(bucketVisitRow).join('')
          : '<div class="bucket-empty">None</div>') +
        '</div>' +
        '<div class="bucket-section"><h3>Unscheduled jobs (' + b.unscheduledJobs.length + ')</h3>' +
        (b.unscheduledJobs.length
          ? b.unscheduledJobs.map(bucketJobRow).join('')
          : '<div class="bucket-empty">None</div>') +
        '</div>';
    }
    return (
      '<div class="detail-sheet" role="dialog" aria-modal="true">' +
      '<button type="button" class="detail-close" aria-label="Close">✕</button>' +
      '<h2>Loose bucket</h2>' +
      rows +
      '</div>'
    );
  }

  function openBucket() {
    // Re-fetch on open so the tray is never stale (the fetch also refreshes
    // the pill count); ~one round trip on a deliberate tap, not a load path.
    fetchBucket().then(function (b) {
      if (!b) {
        toast('Could not load the loose bucket — try again.', true);
        return;
      }
      var prev = document.getElementById('detail-overlay');
      if (prev) prev.remove();
      var ov = document.createElement('div');
      ov.id = 'detail-overlay';
      ov.innerHTML = renderBucketSheet(b);
      ov.addEventListener('click', function (e) {
        if (e.target === ov || (e.target.closest && e.target.closest('.detail-close'))) {
          closeDetail();
          return;
        }
        // Assign a parked visit straight from the tray (plan 4a.5): picker →
        // move with the visit's OWN date/times (attach semantics).
        var assign = e.target.closest && e.target.closest('.bucket-assign');
        if (assign) {
          openPicker({
            title: 'Assign unassigned visit',
            allowNone: false,
            date: assign.getAttribute('data-date'),
            onPick: function (ref) {
              if (!ref) return;
              // A time-TBD row attaches WITHOUT inventing a time (plan 4b-2):
              // the visit keeps its day range and stays unplaced.
              if (assign.getAttribute('data-tbd')) {
                postMove(
                  {
                    assignmentId: assign.getAttribute('data-id'),
                    attachUnplaced: true,
                    technicianRef: ref,
                    reason: 'Assigned from the loose bucket',
                  },
                  function () {
                    return 'Assigned to ' + rosterName(ref) + ' — time still to be set';
                  },
                  null,
                );
                return;
              }
              postMove(
                {
                  assignmentId: assign.getAttribute('data-id'),
                  date: assign.getAttribute('data-date'),
                  startTime: assign.getAttribute('data-start'),
                  endTime: assign.getAttribute('data-end'),
                  technicianRef: ref,
                  reason: 'Assigned from the loose bucket',
                },
                function () {
                  return 'Assigned to ' + rosterName(ref);
                },
                assign.getAttribute('data-start'),
              );
            },
          });
          return;
        }
        // Edit an UNSCHEDULED job's identity (4a.6) — checked before the row
        // tap below, because the button lives inside the row.
        var jobEdit = e.target.closest && e.target.closest('.bucket-edit');
        if (jobEdit) {
          var editRow = jobEdit.closest('.bucket-job');
          if (editRow) {
            var durAttr = editRow.getAttribute('data-duration');
            openJobForm({
              jobId: editRow.getAttribute('data-job'),
              title: editRow.getAttribute('data-title'),
              priority: editRow.getAttribute('data-priority'),
              duration: durAttr ? parseInt(durAttr, 10) : null,
              onDone: openBucket, // came from the tray — go back to it (re-fetched)
            });
          }
          return;
        }
        // Book an unscheduled job (plan 4a.5): the booking sheet.
        var jobRow = e.target.closest && e.target.closest('.bucket-job');
        if (jobRow) {
          openBookingForm(jobRow.getAttribute('data-job'), jobRow.getAttribute('data-title'));
          return;
        }
        // Tap a parked visit → its normal detail sheet (replace-open swaps
        // the overlay instantly; openDetail already supports it).
        var row = e.target.closest && e.target.closest('.bucket-visit');
        if (row) openDetail(row.getAttribute('data-id'));
      });
      document.body.appendChild(ov);
      void ov.offsetHeight;
      ov.classList.add('open');
    });
  }

  // ---- Visit detail sheet (both tiers, read-only) ----

  function detailRow(label, valueHtml) {
    return (
      '<div class="detail-row"><div class="detail-label">' + esc(label) +
      '</div><div class="detail-value">' + valueHtml + '</div></div>'
    );
  }

  function promiseText(d) {
    // Disambiguated copy (user question 2026-07-23): the date is the day the
    // VISIT was promised FOR — never the day the telling happened. An
    // UNPLACED visit (plan 4b-2) has no start — its day comes from the range,
    // and time-level promises cannot exist on it (refused server-side).
    var day = d.promisedDay || (d.start ? d.start.slice(0, 10) : d.earliestDate);
    var when = dayName(day) + ' ' + day;
    if (d.promiseLevel === 'time' && d.start) {
      return "Customer was told we're coming " + esc(when) + ' at ' + esc(hhmm(d.start));
    }
    if (d.promiseLevel === 'day') return "Customer was told we're coming " + esc(when);
    if (d.promiseLevel === 'time_only' && d.start) {
      return 'Customer was told ' + esc(hhmm(d.start)) + ', day not promised';
    }
    return 'Nothing promised to the customer';
  }

  function renderDetail(d) {
    var c = d.customer || {};
    // Edit affordances (plan 4a.5): manager + a live, TODAY-OR-FUTURE visit.
    // The DATE term is what protects history (deliberate corrections stay a
    // chat job); the server independently re-gates tier AND floors past dates,
    // so this is disclosure, not the enforcement boundary.
    //
    // The Team-tab term was REMOVED in 4a.6 (user device finding 2026-07-23):
    // the loose-bucket pill renders on BOTH tabs, so a sheet opened from the
    // tray while on "My schedule" came up silently read-only — and out-of-
    // window unassigned visits are reachable ONLY through the tray, so that
    // was the whole experience for them. The tab said nothing about whether a
    // visit may be edited; it only described which list you happened to be
    // looking at. (Drag/✕ keep their own tab gate in actionable(): those act
    // on the RENDERED lane layout, which really is Team-tab-only.)
    // The visit's anchor day: placed start, else the range start (unplaced,
    // plan 4b-2). The date floor and the read-only reason both key on it.
    var anchorDay = d.start ? d.start.slice(0, 10) : d.earliestDate;
    var isTbd = !d.start;
    var canEdit =
      state.isManager &&
      d.status === 'confirmed' &&
      state.today !== null &&
      // An unplaced visit stays editable while ANY of its range is ahead.
      (isTbd ? d.latestDate >= state.today : anchorDay >= state.today);
    var pencil = function (kind) {
      return canEdit
        ? ' <button type="button" class="edit-btn" data-edit="' + kind + '" aria-label="Edit">✎</button>'
        : '';
    };
    var rows = '';
    if (d.jobTitle || (canEdit && d.jobId)) {
      // The Purpose editor needs the tenant-checked jobId; withheld → no ✎.
      // Length beside Purpose (4b-1): same form edits both, and "length not
      // set" is shown, not hidden — the sheet is where a manager learns which
      // work is placeable.
      rows += detailRow(
        'Purpose',
        esc(
          (d.jobTitle || 'Untitled job') + ' · ' +
          (d.jobDurationMinutes != null ? fmtDur(d.jobDurationMinutes) : 'length not set'),
        ) + (d.jobId ? pencil('job') : ''),
      );
    }
    if (isTbd) {
      // "Place" is the same When editor — it opens with the range day
      // prefilled and empty times, and saving books real times (a move).
      rows += detailRow(
        'When',
        esc(
          dayName(d.earliestDate) + ' · ' + d.earliestDate +
            (d.latestDate !== d.earliestDate ? ' – ' + d.latestDate : '') +
            ' · no time yet',
        ) + (canEdit ? ' <button type="button" class="edit-btn" data-edit="when" aria-label="Place">Place</button>' : ''),
      );
    } else {
      rows += detailRow(
        'When',
        esc(dayName(d.start.slice(0, 10)) + ' · ' + d.start.slice(0, 10)) +
          ', ' + esc(hhmm(d.start) + '–' + hhmm(d.end)) + pencil('when'),
      );
    }
    rows += detailRow('Technician', esc(d.technicianName || 'Unassigned') + pencil('tech'));
    if (c.phone) {
      // tel: href keeps only digits and + — the display keeps the stored form.
      rows += detailRow(
        'Phone',
        '<a href="tel:' + esc(String(c.phone).replace(/[^+\d]/g, '')) + '">' + esc(c.phone) + '</a>',
      );
    }
    if (c.email) {
      rows += detailRow('Email', '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>');
    }
    if (c.address) {
      rows += detailRow(
        'Address',
        '<a href="https://maps.google.com/?q=' + esc(encodeURIComponent(c.address)) +
          '" data-ext="1">' + esc(c.address) + '</a>',
      );
    }
    // "Scheduling promise", not "Promise" — the word stops doing two jobs:
    // this row is the day/time commitment that gates moves/cancels; anything
    // else promised to the customer (a discount…) lives in the notes below.
    rows += detailRow('Scheduling promise', promiseText(d) + pencil('promise'));
    var flags = [];
    if (d.status !== 'confirmed') flags.push(d.status);
    if (flags.length) rows += detailRow('Flags', esc(flags.join(', ')));
    // Compressed customer notes (both tiers — recorded decision 2026-07-23):
    // server-composed strings verbatim, already folded/capped/truncated.
    if (d.customerNotes && d.customerNotes.length) {
      rows += '<div class="notes-head">Customer notes</div>';
      d.customerNotes.forEach(function (n) {
        rows +=
          '<div class="note-row"><span class="note-key">' + esc(n.key) + '</span> ' +
          esc(n.value) + '</div>';
      });
    }
    // A read-only sheet SAYS WHY (4a.6, user device finding): silently
    // dropping every ✎ is indistinguishable from "this can't be edited at
    // all" — which is exactly how the tab-gated tray sheet was read. State the
    // reason instead, so a gate is always self-explaining.
    var why = '';
    if (state.isManager && !canEdit) {
      why =
        d.status !== 'confirmed'
          ? 'Read-only — this visit is ' + d.status + '.'
          : state.today !== null && (isTbd ? d.latestDate < state.today : anchorDay < state.today)
            ? 'Read-only — the day has passed. Ask the assistant in chat to correct past visits.'
            : 'Read-only — reopen the board and try again.';
    }
    return (
      '<div class="detail-sheet" role="dialog" aria-modal="true">' +
      '<button type="button" class="detail-close" aria-label="Close">✕</button>' +
      '<h2>' + esc(c.name || 'Unknown customer') + '</h2>' +
      (why ? '<div class="sheet-note">' + esc(why) + '</div>' : '') +
      rows +
      '</div>'
    );
  }

  // Animated dismiss: drop .open (sheet slides down, backdrop fades — CSS
  // owns the motion) and remove the element once the transition is over. The
  // data-closing guard makes a second close during the slide a no-op, and the
  // timeout tracks the longest transition (0.28s) rather than transitionend —
  // which never fires under prefers-reduced-motion's transition:none.
  function closeDetail() {
    var ov = document.getElementById('detail-overlay');
    if (!ov || ov.getAttribute('data-closing')) return;
    ov.setAttribute('data-closing', '1');
    ov.classList.remove('open');
    setTimeout(function () {
      ov.remove();
    }, 300);
  }

  function openDetail(assignmentId) {
    fetch('/board/api/visit?assignmentId=' + encodeURIComponent(assignmentId), {
      headers: authHeaders(),
    })
      .then(function (resp) {
        if (!resp.ok) {
          // A failed detail fetch never touches the board behind it — toast
          // and stay (the 404 case is real: the visit may have been moved or
          // cancelled since this card rendered).
          toast(
            resp.status === 404
              ? 'Visit not found — the board may be out of date; pull to refresh.'
              : 'Could not load the visit (' + resp.status + ') — try again.',
            true,
          );
          return null;
        }
        return resp.json();
      })
      .then(function (d) {
        if (!d) return;
        // Replacing an already-open sheet swaps INSTANTLY (no animated close —
        // it would leave two elements sharing the id for the slide's 300ms,
        // and getElementById would then close the wrong one).
        var prev = document.getElementById('detail-overlay');
        if (prev) prev.remove();
        var ov = document.createElement('div');
        ov.id = 'detail-overlay';
        ov.innerHTML = renderDetail(d);
        // Backdrop tap or ✕ closes; external links route through Telegram's
        // opener so they leave the webview instead of navigating the board.
        ov.addEventListener('click', function (e) {
          if (e.target === ov || (e.target.closest && e.target.closest('.detail-close'))) {
            closeDetail();
            return;
          }
          // ✎ → the row's editor (plan 4a.5).
          var edit = e.target.closest && e.target.closest('[data-edit]');
          if (edit) {
            openEditor(edit.getAttribute('data-edit'), d);
            return;
          }
          var ext = e.target.closest && e.target.closest('a[data-ext]');
          if (ext && tg && typeof tg.openLink === 'function') {
            e.preventDefault();
            tg.openLink(ext.href);
          }
        });
        document.body.appendChild(ov);
        // Mounted CLOSED (sheet below the viewport). Force one reflow so that
        // state is the painted baseline, THEN add .open — the class flip now
        // transitions instead of appearing pre-applied. (rAF alone is not
        // enough on WebKit: the frame can coalesce, skipping the slide.)
        void ov.offsetHeight;
        ov.classList.add('open');
      })
      .catch(function () {
        toast('Network error — could not load the visit.', true);
      });
  }

  // ---- Quick-edit machinery (plan 4a.5) ----

  // ONE roster fetch, de-duplicated: the post-paint warm-up and a picker
  // opened before it lands share the same in-flight promise instead of racing
  // two identical requests.
  var rosterInFlight = null;
  function loadRoster() {
    if (state.roster) return Promise.resolve(state.roster);
    if (rosterInFlight) return rosterInFlight;
    rosterInFlight = fetch('/board/api/roster', { headers: authHeaders() })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (b) {
        rosterInFlight = null;
        if (b && b.technicians) {
          state.roster = b.technicians;
          return state.roster;
        }
        return null;
      })
      .catch(function (err) {
        rosterInFlight = null;
        throw err;
      });
    return rosterInFlight;
  }

  // Warm the cache just after the board paints (4a.6 — user reported the
  // assign gesture felt slow): the first Assign used to pay a whole extra
  // round-trip with the manager already staring at the sheet. Silent and
  // never awaited — a failure just leaves the cache empty, and the picker's
  // own on-demand fetch keeps the error path.
  function prefetchRoster() {
    if (state.roster) return;
    loadRoster().catch(function () {});
  }

  function fetchRoster(cb) {
    loadRoster()
      .then(function (list) {
        if (list) {
          cb(list);
          return;
        }
        toast('Could not load the team list — try again.', true);
        cb(null);
      })
      .catch(function () {
        toast('Network error — could not load the team list.', true);
        cb(null);
      });
  }

  function rosterName(ref) {
    var name = ref;
    (state.roster || []).forEach(function (t) {
      if (t.ref === ref) name = t.name;
    });
    return name;
  }

  // "2 visits" / "available" for a date the board has already painted; ''
  // outside the rendered window (no data, no claim). "available" — not "free"
  // (user, 2026-07-23): free reads as "costs nothing" on a page about work.
  function busyHint(ref, date) {
    var stops = state.stopsByDate && state.stopsByDate[date];
    if (!stops) return '';
    var n = 0;
    stops.forEach(function (s) {
      if (s.technicianRef === ref) n++;
    });
    return n === 0 ? 'available' : n + (n === 1 ? ' visit' : ' visits');
  }

  // Overlay helper for the new sheets (picker / mini-forms): the
  // detail-overlay pattern with a caller-supplied click handler.
  function openSheet(html, onClick) {
    var prev = document.getElementById('detail-overlay');
    if (prev) prev.remove();
    var ov = document.createElement('div');
    ov.id = 'detail-overlay';
    ov.innerHTML = html;
    ov.addEventListener('click', function (e) {
      if (e.target === ov || (e.target.closest && e.target.closest('.detail-close'))) {
        closeDetail();
        return;
      }
      onClick(e, ov);
    });
    document.body.appendChild(ov);
    void ov.offsetHeight;
    ov.classList.add('open');
  }

  function sheetShell(title, inner) {
    return (
      '<div class="detail-sheet" role="dialog" aria-modal="true">' +
      '<button type="button" class="detail-close" aria-label="Close">✕</button>' +
      '<h2>' + esc(title) + '</h2>' + inner + '</div>'
    );
  }

  function openPicker(opts) {
    fetchRoster(function (roster) {
      if (!roster) return;
      var rows = '';
      if (opts.allowNone) {
        rows +=
          '<div class="picker-row" data-pick="">' +
          '<span class="picker-name">None — leave unassigned</span>' +
          '<span class="picker-hint">nobody assigned</span></div>';
      }
      roster.forEach(function (t) {
        rows +=
          '<div class="picker-row" data-pick="' + esc(t.ref) + '">' +
          '<span class="picker-name">' + esc(t.name) +
          (opts.currentRef && t.ref === opts.currentRef ? ' · current' : '') +
          '</span><span class="picker-hint">' +
          esc(opts.date ? busyHint(t.ref, opts.date) : '') +
          '</span></div>';
      });
      openSheet(sheetShell(opts.title, rows), function (e) {
        var row = e.target.closest && e.target.closest('.picker-row');
        if (!row) return;
        // Dismiss BEFORE the write starts (4a.6): a move is preview →
        // (confirm) → commit, and holding the picker open across both round
        // trips read as a frozen tap. Failures still toast, and every write
        // path refreshes the board, so nothing is hidden by closing early.
        closeDetail();
        opts.onPick(row.getAttribute('data-pick') || null);
      });
    });
  }

  // The one confirm dialog's copy, from the move preview: name what actually
  // breaks (a day promise vs a time_only promise), and say when the drop also
  // parks the visit. oldStart is the PROMISED time — the preview's startTime
  // is the requested NEW one, which by definition differs whenever a
  // time_only dialog fires (review finding: the dialog named the wrong time).
  function breakMsg(p, oldStart) {
    // A day+time promise broken by a SAME-DAY time change is a time break too
    // (final-review finding: the day branch would print "promised day (X → X)").
    var timeBreak =
      p.promiseLevel === 'time_only' || (p.promiseLevel === 'time' && p.fromDay === p.toDay);
    var what = timeBreak
      ? 'a promised time (' + (oldStart || p.startTime) + ' → ' + p.startTime + ')'
      : 'a promised day (' + p.fromDay + ' → ' + p.toDay + ')';
    return (
      'This breaks ' + what + ' — the customer must be told.' +
      (p.unassign ? ' The visit will be left with NOBODY assigned.' : '') +
      ' Move anyway?'
    );
  }

  // Preview → (one confirm when a promise breaks) → commit, shared by every
  // move-shaped write: drag, tray Assign, the Technician picker, the When
  // editor. doneMsg(body) composes the success toast; promise-break and
  // warning disclosures ride on top, never dropped.
  function postMove(body, doneMsg, oldStart) {
    apiPost('/board/api/move', body, true)
      .then(function (p) {
        if (!p.ok) {
          toast(p.body.error || 'Move failed (' + p.status + ')', true);
          return;
        }
        var commit = function () {
          apiPost('/board/api/move', body, false)
            .then(function (r) {
              if (!r.ok) {
                // Incl. the UNSCHEDULED stranding — show the raw failure, refetch.
                toast(r.body.error || 'Move failed (' + r.status + ')', true);
                refresh();
                return;
              }
              closeDetail();
              // "Say what you did" includes a promise broken in the preview→
              // commit race window — the server reports it; never swallow it.
              toast(
                doneMsg(r.body) +
                  (r.body.promiseBroken ? '. This BROKE a customer promise — tell them' : '') +
                  (r.body.warning ? '. ' + r.body.warning : ''),
                !!r.body.promiseBroken,
              );
              refresh();
            })
            .catch(function () {
              toast('Network error — the move may or may not have landed; refreshing.', true);
              refresh();
            });
        };
        if (p.body.requiresConfirmation) {
          confirmAsk(breakMsg(p.body, oldStart), function (yes) {
            if (yes) commit();
          });
        } else {
          commit();
        }
      })
      .catch(function () {
        toast('Network error — nothing was changed.', true);
      });
  }

  var PRIORITY_OPTIONS = [
    ['emergency', 'emergency'],
    ['urgent', 'urgent'],
    ['routine', 'routine'],
    ['maintenance', 'maintenance'],
  ];
  var PROMISE_OPTIONS = [
    ['none', 'No promise'],
    ['day', 'Day only'],
    ['time_only', 'Time only'],
    ['time', 'Day + time'],
  ];

  function promiseLabel(level) {
    var label = level;
    PROMISE_OPTIONS.forEach(function (o) {
      if (o[0] === level) label = o[1];
    });
    return label;
  }

  // The OFFERED job lengths (plan 4b-1) — mirrors DURATION_LADDER in
  // src/db/jobs.ts (the PRIORITY_OPTIONS client-mirror precedent: this webview
  // is plain script, no build step). Presentation only: any whole minutes up
  // to the bound is legal server-side, so Custom… below is a first-class path.
  // Keep BOTH constants in lockstep with src/db/jobs.ts when editing a rung
  // or the bound — the one fact per surface, not per line (review finding).
  var DURATION_LADDER = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];
  var MAX_DURATION_MINUTES = 1440;

  // JS mirror of src/db/jobs.ts formatDuration — chat and board must label a
  // length identically ('1h 30m').
  function fmtDur(m) {
    if (m % 60 === 0) return m / 60 + 'h';
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  // Options for the length select: not-set, the ladder, the CURRENT value as
  // its own option when off-ladder (an 80-minute booked span or a typed 20 is
  // NORMAL data — it must display correctly, never read as "not set" and never
  // be silently lost by an unrelated edit), then Custom….
  function durationOptions(current) {
    var opts = [['', '— length not set —']];
    DURATION_LADDER.forEach(function (m) {
      opts.push([String(m), fmtDur(m)]);
    });
    if (typeof current === 'number' && DURATION_LADDER.indexOf(current) === -1) {
      opts.push([String(current), fmtDur(current)]);
    }
    opts.push(['custom', 'Custom…']);
    return opts;
  }

  function fieldRow(label, inputHtml) {
    return '<label class="field-row"><span>' + esc(label) + '</span>' + inputHtml + '</label>';
  }

  function selectHtml(id, options, selected) {
    var html = '<select id="' + id + '">';
    options.forEach(function (o) {
      html +=
        '<option value="' + esc(o[0]) + '"' + (o[0] === selected ? ' selected' : '') + '>' +
        esc(o[1]) + '</option>';
    });
    return html + '</select>';
  }

  function formButtons(saveLabel) {
    return (
      '<div class="sheet-btnrow">' +
      '<button type="button" class="sheet-btn" data-form="cancel">Cancel</button>' +
      '<button type="button" class="sheet-btn primary" data-form="save">' + esc(saveLabel) + '</button>' +
      '</div>'
    );
  }

  function val(ov, id) {
    var el = ov.querySelector('#' + id);
    return el ? el.value : '';
  }

  // The sheet-row editors. Every write goes through the Phase-2 endpoints —
  // the same shared verbs chat drives. NOTE: /promise and /job are ONE-SHOT
  // endpoints; never send them ?preview=1 (it is ignored and would commit).
  function openEditor(kind, d) {
    // Unplaced visits (plan 4b-2): the editors prefill from the range day and
    // EMPTY times — placing means typing real ones.
    var vDate = d.start ? d.start.slice(0, 10) : d.earliestDate;
    if (kind === 'tech') {
      openPicker({
        title: 'Assign technician',
        allowNone: !d.unassigned,
        currentRef: d.technicianRef,
        date: vDate,
        onPick: function (ref) {
          if ((ref || null) === (d.technicianRef || null)) {
            closeDetail();
            return;
          }
          // An UNPLACED visit attaches without inventing a time (plan 4b-2).
          if (!d.start) {
            if (!ref) {
              toast('This visit has nobody attached yet — pick a person.', true);
              return;
            }
            postMove(
              {
                assignmentId: d.assignmentId,
                attachUnplaced: true,
                technicianRef: ref,
                reason: 'Assigned on the visit sheet',
              },
              function () {
                return 'Assigned to ' + rosterName(ref) + ' — time still to be set';
              },
              null,
            );
            return;
          }
          var body = {
            assignmentId: d.assignmentId,
            date: vDate,
            startTime: hhmm(d.start),
            endTime: hhmm(d.end),
            reason: ref ? 'Assigned on the visit sheet' : 'Unassigned on the visit sheet',
          };
          if (ref) body.technicianRef = ref;
          else body.unassign = true;
          postMove(
            body,
            function () {
              return ref ? 'Assigned to ' + rosterName(ref) : 'Now unassigned — nobody on it';
            },
            hhmm(d.start),
          );
        },
      });
      return;
    }
    if (kind === 'when') {
      openSheet(
        sheetShell(
          'Edit day & time',
          fieldRow(
            'Day',
            '<input type="date" id="qe-date" value="' + esc(vDate) + '"' +
              (state.today ? ' min="' + esc(state.today) + '"' : '') + '>',
          ) +
            fieldRow('Start', '<input type="time" id="qe-start" value="' + esc(d.start ? hhmm(d.start) : '') + '">') +
            fieldRow('End', '<input type="time" id="qe-end" value="' + esc(d.end ? hhmm(d.end) : '') + '">') +
            formButtons('Save'),
        ),
        function (e, ov) {
          var btn = e.target.closest && e.target.closest('[data-form]');
          if (!btn) return;
          if (btn.getAttribute('data-form') === 'cancel') {
            openDetail(d.assignmentId);
            return;
          }
          var body = {
            assignmentId: d.assignmentId,
            date: val(ov, 'qe-date'),
            startTime: val(ov, 'qe-start'),
            endTime: val(ov, 'qe-end'),
            reason: 'Edited on the visit sheet',
          };
          if (!body.date || !body.startTime || !body.endTime) {
            toast('Day, start and end are all required.', true);
            return;
          }
          // min= only constrains the native picker — desktop text entry can
          // still type a past date; this check is the belt to that brace.
          if (state.today && body.date < state.today) {
            toast('Board writes never target the past — pick today or later.', true);
            return;
          }
          // A move mints a NEW visit id, so the sheet cannot re-open itself —
          // close + refresh instead.
          postMove(
            body,
            function () {
              return (
                (d.start ? 'Moved to ' : 'Placed — ') +
                body.date + ' ' + body.startTime + '–' + body.endTime
              );
            },
            d.start ? hhmm(d.start) : null,
          );
        },
      );
      return;
    }
    if (kind === 'promise') {
      openSheet(
        sheetShell(
          'Scheduling promise',
          '<div class="field-note">What was the customer ACTUALLY told about this visit?</div>' +
            fieldRow('Promise', selectHtml('qe-promise', PROMISE_OPTIONS, d.promiseLevel)) +
            formButtons('Save'),
        ),
        function (e, ov) {
          var btn = e.target.closest && e.target.closest('[data-form]');
          if (!btn) return;
          if (btn.getAttribute('data-form') === 'cancel') {
            openDetail(d.assignmentId);
            return;
          }
          var level = val(ov, 'qe-promise');
          if (level === d.promiseLevel) {
            openDetail(d.assignmentId);
            return;
          }
          apiPost('/board/api/promise', { assignmentId: d.assignmentId, promiseLevel: level })
            .then(function (r) {
              if (!r.ok) {
                toast(r.body.error || 'Promise update failed (' + r.status + ')', true);
                return;
              }
              toast('Promise: ' + promiseLabel(d.promiseLevel) + ' → ' + promiseLabel(level));
              openDetail(d.assignmentId); // same id — the record edit never remints
              refresh();
            })
            .catch(function () {
              toast('Network error — nothing was changed.', true);
            });
        },
      );
      return;
    }
    if (kind === 'job') {
      openJobForm({
        jobId: d.jobId,
        title: d.jobTitle,
        priority: d.jobPriority,
        duration: d.jobDurationMinutes,
        onDone: function () {
          openDetail(d.assignmentId); // same id — a job edit never remints the visit
        },
      });
    }
  }

  // The job-identity form — ONE body for both entry points (4a.6): the visit
  // sheet's Purpose ✎ and the tray's Edit on a job that has no visit yet.
  // `onDone` is where the caller came from, so Cancel/Save return there.
  function openJobForm(opts) {
    // Current length, normalised: a number or null ("not set").
    var curDur = typeof opts.duration === 'number' && isFinite(opts.duration) ? opts.duration : null;
    openSheet(
      sheetShell(
        'Edit job',
        fieldRow('Title', '<input type="text" id="qe-title" value="' + esc(opts.title || '') + '">') +
          fieldRow('Priority', selectHtml('qe-priority', PRIORITY_OPTIONS, opts.priority || 'routine')) +
          // Length (4b-1): the ladder is offered, any whole minutes accepted —
          // Custom… reveals the number input (numeric keypad via type=number).
          fieldRow(
            'Length',
            selectHtml('qe-duration', durationOptions(curDur), curDur != null ? String(curDur) : ''),
          ) +
          '<div id="qe-duration-custom-row" class="field-hidden">' +
          fieldRow(
            'Minutes',
            '<input type="number" id="qe-duration-custom" min="1" max="' +
              MAX_DURATION_MINUTES + '" step="1">',
          ) +
          '</div>' +
          formButtons('Save'),
      ),
      function (e, ov) {
        var btn = e.target.closest && e.target.closest('[data-form]');
        if (!btn) return;
        if (btn.getAttribute('data-form') === 'cancel') {
          opts.onDone();
          return;
        }
        var body = { jobId: opts.jobId };
        var title = val(ov, 'qe-title').trim();
        if (title && title !== (opts.title || '')) body.title = title;
        var priority = val(ov, 'qe-priority');
        if (priority !== opts.priority) body.priority = priority;
        var durSel = val(ov, 'qe-duration');
        var newDur;
        if (durSel === 'custom') {
          // Number(), not parseInt: "45.5" must be REFUSED like the server
          // refuses it, not silently truncated to 45 (review observation).
          var typed = Number(val(ov, 'qe-duration-custom'));
          if (!(Number.isInteger(typed) && typed >= 1 && typed <= MAX_DURATION_MINUTES)) {
            toast('Custom length must be whole minutes from 1 to ' + MAX_DURATION_MINUTES + '.', true);
            return;
          }
          newDur = typed;
        } else {
          newDur = durSel === '' ? null : parseInt(durSel, 10);
        }
        // Presence, not truthiness (4b-1 review): null = an explicit CLEAR, so
        // the field rides in the body whenever the value CHANGED — including
        // a change to null.
        if (newDur !== curDur) body.durationMinutes = newDur;
        if (!body.title && !body.priority && !('durationMinutes' in body)) {
          opts.onDone();
          return;
        }
        apiPost('/board/api/job', body)
          .then(function (r) {
            if (!r.ok) {
              toast(r.body.error || 'Job update failed (' + r.status + ')', true);
              return;
            }
            toast(
              'Job updated' +
                (body.title ? ' — title: ' + body.title : '') +
                (body.priority ? ' — priority: ' + body.priority : '') +
                ('durationMinutes' in body
                  ? ' — length: ' + (newDur != null ? fmtDur(newDur) : 'not set')
                  : ''),
            );
            opts.onDone();
            refresh(); // the title shows on cards behind the sheet
          })
          .catch(function () {
            toast('Network error — nothing was changed.', true);
          });
      },
    );
    // Reveal the custom-minutes row only when Custom… is picked. openSheet
    // appends synchronously, so the overlay exists here; change events don't
    // bubble into its click delegation, hence the direct listener.
    var ovEl = document.getElementById('detail-overlay');
    var durSelEl = ovEl && ovEl.querySelector('#qe-duration');
    if (durSelEl) {
      durSelEl.addEventListener('change', function () {
        var row = ovEl.querySelector('#qe-duration-custom-row');
        if (row) row.classList.toggle('field-hidden', durSelEl.value !== 'custom');
      });
    }
  }

  // The tray's booking sheet (plan 4a.5): day + start + end are REQUIRED —
  // the server never invents a visit length (standing user decision) — plus
  // technician-or-leave-unassigned and the promise selector.
  function openBookingForm(jobId, title) {
    fetchRoster(function (roster) {
      if (!roster) return;
      var techOptions = [['', 'Leave unassigned']];
      roster.forEach(function (t) {
        techOptions.push([t.ref, t.name]);
      });
      openSheet(
        sheetShell(
          'Book: ' + (title || 'Untitled job'),
          fieldRow(
            'Day',
            '<input type="date" id="qe-date"' +
              (state.today ? ' min="' + esc(state.today) + '"' : '') + '>',
          ) +
            '<label class="field-row tbd-toggle"><span>Time not settled yet</span>' +
            '<input type="checkbox" id="qe-tbd"></label>' +
            '<div id="qe-times">' +
            fieldRow('Start', '<input type="time" id="qe-start">') +
            fieldRow('End', '<input type="time" id="qe-end">') +
            '</div>' +
            '<div id="qe-until" style="display:none">' +
            fieldRow(
              'Until (optional)',
              '<input type="date" id="qe-latest"' +
                (state.today ? ' min="' + esc(state.today) + '"' : '') + '>',
            ) +
            '<div class="field-note">Leave empty for a single day; set it for "sometime that week".</div>' +
            '</div>' +
            fieldRow('Technician', selectHtml('qe-tech', techOptions, '')) +
            fieldRow('Promise', selectHtml('qe-promise', PROMISE_OPTIONS, 'none')) +
            formButtons('Book visit'),
        ),
        function (e, ov) {
          // The toggle hides the time inputs and books UNPLACED (plan 4b-2).
          var tbdBox = e.target.id === 'qe-tbd' ? e.target : null;
          if (tbdBox) {
            var times = ov.querySelector('#qe-times');
            var until = ov.querySelector('#qe-until');
            if (times) times.style.display = tbdBox.checked ? 'none' : '';
            if (until) until.style.display = tbdBox.checked ? '' : 'none';
            return;
          }
          var btn = e.target.closest && e.target.closest('[data-form]');
          if (!btn) return;
          if (btn.getAttribute('data-form') === 'cancel') {
            closeDetail();
            return;
          }
          var tbdEl = ov.querySelector('#qe-tbd');
          var isTbd = !!(tbdEl && tbdEl.checked);
          var body;
          if (isTbd) {
            body = { jobId: jobId, timeTbd: true, earliestDate: val(ov, 'qe-date') };
            var latest = val(ov, 'qe-latest');
            if (latest) body.latestDate = latest;
            if (!body.earliestDate) {
              toast('Pick the day (or the range start).', true);
              return;
            }
            if (body.latestDate && body.latestDate < body.earliestDate) {
              toast('"Until" must be on or after the day.', true);
              return;
            }
            body.date = body.earliestDate; // the past-date belt below reuses it
          } else {
            body = {
              jobId: jobId,
              date: val(ov, 'qe-date'),
              startTime: val(ov, 'qe-start'),
              endTime: val(ov, 'qe-end'),
            };
            if (!body.date || !body.startTime || !body.endTime) {
              toast('Day, start and end are all required.', true);
              return;
            }
          }
          // Same belt as the When editor: min= doesn't stop a typed past date.
          if (state.today && body.date < state.today) {
            toast('Board writes never target the past — pick today or later.', true);
            return;
          }
          var ref = val(ov, 'qe-tech');
          if (ref) body.technicianRef = ref;
          var level = val(ov, 'qe-promise');
          if (level !== 'none') body.promiseLevel = level;
          apiPost('/board/api/book', body, true)
            .then(function (p) {
              if (!p.ok) {
                toast(p.body.error || 'Booking failed (' + p.status + ')', true);
                return;
              }
              var commit = function () {
                apiPost('/board/api/book', body, false)
                  .then(function (r) {
                    if (!r.ok) {
                      // A raced refusal (overlap landed between preview and
                      // commit) means the board behind the sheet is stale —
                      // refetch, same as the move flow (final-review parity).
                      toast(r.body.error || 'Booking failed (' + r.status + ')', true);
                      refresh();
                      return;
                    }
                    closeDetail();
                    toast(
                      'Booked — ' + body.date +
                        (isTbd
                          ? (body.latestDate ? ' – ' + body.latestDate : '') + ', time to be set'
                          : ' ' + body.startTime + '–' + body.endTime) +
                        (ref ? ' with ' + rosterName(ref) : ', unassigned') +
                        (r.body.warning ? '. ' + r.body.warning : ''),
                    );
                    refresh(); // repaints the board; the pill refetches with it
                  })
                  .catch(function () {
                    toast('Network error — the booking may or may not have landed; refreshing.', true);
                    refresh();
                  });
              };
              if (p.body.requiresConfirmation) {
                confirmAsk(
                  'This records a promise to the customer (' + promiseLabel(level) + ') for ' +
                    body.date + (isTbd ? ' (time to be set)' : ' ' + body.startTime) + '. Book it?',
                  function (yes) {
                    if (yes) commit();
                  },
                );
              } else {
                commit();
              }
            })
            .catch(function () {
              toast('Network error — nothing was booked.', true);
            });
        },
      );
    });
  }

  // ---- Manager write path ----

  function moveFlow(card, targetDate, laneRef, laneLabel, unassign) {
    var currentRef = card.getAttribute('data-ref');
    var sameDay = card.closest('.day').getAttribute('data-date') === targetDate;
    var body = {
      assignmentId: card.getAttribute('data-id'),
      date: targetDate,
      startTime: card.getAttribute('data-start'),
      endTime: card.getAttribute('data-end'),
    };
    // A lane drop assigns/reassigns; a plain day drop keeps the person (or
    // keeps it unassigned — moveVisit's omitted-ref semantics); an
    // Unassigned-lane drop PARKS (plan 4a.5 — the detach verb). An already-
    // parked card dropped on another day's Unassigned lane is a plain day
    // move (nothing to detach) — the shared same-spot guard below covers the
    // dropped-where-it-was case for parked cards too.
    if (unassign && currentRef) {
      body.unassign = true;
    } else if (!unassign && laneRef && laneRef !== currentRef) {
      body.technicianRef = laneRef;
    }
    if (sameDay && !body.technicianRef && !body.unassign) return; // dropped where it already was
    // The audit reason tracks what the move ACTUALLY does, not the drop
    // target (final-review finding: an already-unassigned card day-moved via
    // the Unassigned lane was stamped as if it had just been detached).
    body.reason = body.unassign
      ? 'Unassigned on the dispatch board'
      : 'Moved on the dispatch board';
    postMove(
      body,
      function () {
        return (
          'Moved to ' + targetDate + ' ' + body.startTime +
          (body.technicianRef
            ? ' — now with ' + (laneLabel || body.technicianRef)
            : body.unassign
              ? ' — now unassigned, nobody on it'
              : '')
        );
      },
      card.getAttribute('data-start'),
    );
  }

  function cancelFlow(card) {
    var body = { assignmentId: card.getAttribute('data-id') };
    apiPost('/board/api/cancel', body, true).then(function (p) {
      if (!p.ok) {
        toast(p.body.error || 'Unschedule failed (' + p.status + ')', true);
        return;
      }
      var commit = function () {
        apiPost(
          '/board/api/cancel',
          { assignmentId: body.assignmentId, reason: 'Unscheduled on the dispatch board' },
          false,
        )
          .then(function (r) {
            if (!r.ok) {
              toast(r.body.error || 'Unschedule failed (' + r.status + ')', true);
              refresh();
              return;
            }
            // Disclose a promise that appeared between preview and commit —
            // the cancel one-shot must still "say what you did" in full.
            var hadPromise = r.body.promiseLevel && r.body.promiseLevel !== 'none';
            toast(
              'Unscheduled ' + (p.body.customerName || 'the visit') + ' on ' + p.body.day +
                ' — back in the loose bucket' +
                (hadPromise ? '. This visit was PROMISED to the customer — tell them' : ''),
              !!hadPromise,
            );
            refresh();
          })
          .catch(function () {
            toast('Network error — the unschedule may or may not have landed; refreshing.', true);
            refresh();
          });
      };
      if (p.body.requiresConfirmation) {
        // Name what was ACTUALLY promised per level (final-review finding:
        // the old two-level ternary described a time_only cancel as "promised
        // a day" — a false statement of the stake on a destructive dialog).
        var stake =
          p.body.promiseLevel === 'time_only'
            ? 'was promised a time (' + card.getAttribute('data-start') + ')'
            : p.body.promiseLevel === 'time'
              ? 'was promised the day AND time on ' + p.body.day
              : 'was promised a day on ' + p.body.day;
        confirmAsk(
          (p.body.customerName || 'The customer') + ' ' + stake + '. Unschedule anyway?',
          function (yes) {
            if (yes) commit();
          },
        );
      } else {
        commit();
      }
    }).catch(function () {
      toast('Network error — nothing was changed.', true);
    });
  }

  // ---- Drag wiring (pointer events: mouse drags on move, touch after a
  //      short hold so the page still scrolls normally) ----

  var drag = null; // { card, chip }
  var pending = null; // { card, x, y, holdTimer }

  function targetAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    var laneEl = el.closest && el.closest('.lane');
    var t = null;
    if (laneEl) {
      // The Unassigned lane is a LIVE drop target since plan 4a.5: the detach
      // verb exists, so dropping here parks the visit (person pulled off,
      // day/time kept). It renders on every actionable day exactly for this.
      if (laneEl.classList.contains('lane-unassigned')) {
        t = {
          date: laneEl.closest('.day').getAttribute('data-date'),
          laneRef: null,
          label: 'Unassigned',
          unassign: true,
          el: laneEl,
        };
        if (state.today !== null && t.date < state.today) return null;
        return t;
      }
      var h3 = laneEl.querySelector('h3');
      t = {
        date: laneEl.closest('.day').getAttribute('data-date'),
        laneRef: laneEl.getAttribute('data-lane'),
        label: h3 ? h3.textContent : null,
        el: laneEl,
      };
    } else {
      var dayEl = el.closest && el.closest('.day');
      if (dayEl) {
        t = { date: dayEl.getAttribute('data-date'), laneRef: null, label: null, el: dayEl };
      }
    }
    // Past days are INERT drop targets — the calendar week 0 contains them,
    // and a drop must not move a visit into history.
    if (t && state.today !== null && t.date < state.today) return null;
    return t;
  }

  function clearHover() {
    var prev = document.querySelector('.drop-hover');
    if (prev) prev.classList.remove('drop-hover');
  }

  function beginDrag(card, x, y, pointerId) {
    // Telegram's own vertical-swipe-to-collapse gesture fights vertical drags
    // (Bot API 7.7+) — suspend it for the duration of the drag only.
    if (tg && typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    var chip = document.createElement('div');
    chip.className = 'drag-chip';
    var who = card.querySelector('.stop-customer');
    chip.textContent =
      card.getAttribute('data-start') + ' ' + (who ? who.textContent : 'visit');
    document.body.appendChild(chip);
    // pointerId = the ONE finger that owns this drag; every other pointer's
    // moves/lifts are ignored, or a stray second touch would steer the chip
    // and commit the drop at coordinates the manager never chose.
    drag = { card: card, chip: chip, pointerId: pointerId };
    card.classList.add('dragging');
    // Desktop cursor only: the pointer leaves the source card almost at once,
    // so the closed-hand cursor has to live on the document for the gesture.
    document.body.classList.add('dragging');
    positionChip(x, y);
  }

  function positionChip(x, y) {
    drag.chip.style.left = x + 'px';
    drag.chip.style.top = y + 'px';
  }

  // A completed drag can still fire a synthetic click on the source card
  // (mouse drags especially) — that click must NOT pop the detail sheet the
  // gesture never asked for. endDrag stamps the moment; the click handler
  // ignores card taps in its shadow.
  var lastDragEnd = 0;

  function endDrag() {
    if (!drag) return;
    if (tg && typeof tg.enableVerticalSwipes === 'function') tg.enableVerticalSwipes();
    drag.card.classList.remove('dragging');
    document.body.classList.remove('dragging');
    drag.chip.remove();
    drag = null;
    lastDragEnd = Date.now();
    clearHover();
  }

  function wireWrites() {
    app.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('.tab');
      if (tab) {
        var view = tab.getAttribute('data-view');
        // The requested view rides to refresh(); state.view moves only when
        // render() commits the server's echo — a failed switch leaves the old
        // tab live (and re-clickable), never a half-switched page.
        if (view !== state.view) refresh(view);
        return;
      }
      var pageBtn = e.target.closest && e.target.closest('.pager-btn');
      if (pageBtn) {
        var step = pageBtn.getAttribute('data-page');
        // Same commit rule as tabs: the target week rides as a REQUEST;
        // state.weekOffset moves only when that week's data renders.
        refresh(undefined, step === '0' ? 0 : state.weekOffset + Number(step));
        return;
      }
      var bucketPill = e.target.closest && e.target.closest('.bucket-pill');
      if (bucketPill) {
        openBucket();
        return;
      }
      // A "no time yet" strip card opens the normal detail sheet (plan 4b-2).
      var tbd = e.target.closest && e.target.closest('.tbd-card');
      if (tbd) {
        openDetail(tbd.getAttribute('data-id'));
        return;
      }
      var btn = e.target.closest && e.target.closest('.stop-cancel');
      if (btn) {
        cancelFlow(btn.closest('.stop'));
        return;
      }
      // Tap a card → detail sheet (both tiers, every tab, past weeks too —
      // it's a read). Guarded against the click a just-finished drag emits.
      var card = e.target.closest && e.target.closest('.stop');
      if (card && !drag && Date.now() - lastDragEnd > 400) {
        openDetail(card.getAttribute('data-id'));
      }
    });

    app.addEventListener('pointerdown', function (e) {
      if (!actionable() || drag) return;
      if (e.target.closest && e.target.closest('.stop-cancel')) return;
      var card = e.target.closest && e.target.closest('.stop');
      if (!card) return;
      // Only cards RENDERED draggable may start a drag — the class is the
      // single write-affordance truth (past days inside the current week
      // render without it even while actionable() is true).
      if (!card.classList.contains('draggable')) return;
      pending = { card: card, x: e.clientX, y: e.clientY, holdTimer: null, pointerId: e.pointerId };
      if (e.pointerType === 'touch') {
        pending.holdTimer = setTimeout(function () {
          if (pending) beginDrag(pending.card, pending.x, pending.y, pending.pointerId);
        }, 300);
      }
    });

    document.addEventListener(
      'pointermove',
      function (e) {
        if (!pending && !drag) return;
        // Only the initiating finger drives the gesture.
        if (e.pointerId !== (drag ? drag.pointerId : pending.pointerId)) return;
        if (!drag) {
          var dx = e.clientX - pending.x;
          var dy = e.clientY - pending.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (e.pointerType === 'touch') {
            // Moved before the hold fired → it's a scroll, not a drag.
            if (dist > 10) {
              clearTimeout(pending.holdTimer);
              pending = null;
            }
            return;
          }
          if (dist > 8) beginDrag(pending.card, e.clientX, e.clientY, e.pointerId);
          else return;
        }
        e.preventDefault();
        positionChip(e.clientX, e.clientY);
        clearHover();
        var t = targetAt(e.clientX, e.clientY);
        if (t) t.el.classList.add('drop-hover');
      },
      { passive: false },
    );

    var finish = function (e) {
      // A second finger lifting must not end (let alone commit) a drag it
      // never owned — only the initiating pointer finishes the gesture.
      if (e.pointerId !== (drag ? drag.pointerId : pending ? pending.pointerId : e.pointerId)) {
        return;
      }
      if (pending) clearTimeout(pending.holdTimer);
      if (drag) {
        var card = drag.card;
        var t = e.type === 'pointerup' ? targetAt(e.clientX, e.clientY) : null;
        endDrag();
        if (t) moveFlow(card, t.date, t.laneRef, t.label, t.unassign);
      }
      pending = null;
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  // Outside Telegram (desktop browser probe) there is no initData: show a
  // clear empty state instead of a confusing 401.
  if (!tg || !tg.initData) {
    showEmpty('Open this board from your Telegram chat with the board bot.');
    return;
  }
  tg.ready();
  tg.expand();
  applyTheme();
  wireWrites();
  // An idle-open board can cross firm-local midnight with a stale `today`
  // anchor — one day of already-past cards would keep their write
  // affordances until the next load (review finding). Since load() now reuses
  // the cached anchor, clear it here so the foreground return RE-LEARNS today
  // from the server; refresh() then keeps the current tab/week.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.rendered) {
      var prev = state.today;
      state.today = null;
      refresh().then(function () {
        // A FAILED re-anchor must not strand the page anchor-less (4a.6):
        // every write gate reads state.today, so a null one silently turns
        // every sheet read-only — over an already-rendered board whose cards
        // still look editable — until some later load happens to succeed.
        // Restoring the previous anchor is safe: the server floors past-dated
        // board writes regardless, so a stale-by-one-day anchor can only cost
        // a refused write, never a wrong one.
        if (state.today === null) state.today = prev;
      });
    }
  });
  refresh();
})();
