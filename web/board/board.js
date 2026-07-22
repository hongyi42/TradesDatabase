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
      badges +=
        '<span class="badge promise">promised ' +
        esc(stop.promiseLevel === 'time' ? 'time' : 'day') +
        '</span>';
    }
    if (stop.locked) badges += '<span class="badge lock">locked</span>';
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
        ? '<button type="button" class="stop-cancel" aria-label="Cancel visit">✕</button>'
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
  // and drag-to-assign needs a single ref per drop target). The unassigned
  // lane is a drag SOURCE, not a target (moveVisit cannot detach a person),
  // and its data-lane is ''. Flat layout (technician view, manager's Mine
  // tab): a plain time-ordered list, no lanes.
  function renderDay(date, stops, teamLayout) {
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
    if (!stops.length) {
      html += '<div class="day-empty">No visits</div>';
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
      if (unassigned.length) {
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
    data.days.forEach(function (d) {
      byDate[d.date] = d.stops;
    });
    // The dates live in the pager label now; this line carries only context
    // (whose stops / read-only) and disappears when there is none.
    var note = !isManager
      ? 'Your stops'
      : data.view === 'mine'
        ? 'Your visits'
        : state.weekOffset < 0
          ? 'Past week — read-only'
          : '';
    var head =
      '<header><h1>Dispatch board</h1>' +
      (isManager ? tabsBar() : '') +
      pagerBar(data.from, data.to) +
      (note ? '<div class="range">' + esc(note) + '</div>' : '') +
      '</header>';
    // Render EVERY day in the window, empty ones included — empty days are the
    // drop targets that make "move to Thursday" possible at all.
    var html = head;
    var date = data.from;
    while (date <= data.to) {
      html += renderDay(date, byDate[date] || [], teamLayout);
      date = addDays(date, 1);
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

  // ---- Visit detail sheet (both tiers, read-only) ----

  function detailRow(label, valueHtml) {
    return (
      '<div class="detail-row"><div class="detail-label">' + esc(label) +
      '</div><div class="detail-value">' + valueHtml + '</div></div>'
    );
  }

  function promiseText(d) {
    if (d.promiseLevel === 'time') return 'Customer was told the day AND time (' + esc(d.promisedDay || '') + ')';
    if (d.promiseLevel === 'day') return 'Customer was told the day (' + esc(d.promisedDay || '') + ')';
    return 'Nothing promised to the customer';
  }

  function renderDetail(d) {
    var c = d.customer || {};
    var rows = '';
    if (d.jobTitle) rows += detailRow('Purpose', esc(d.jobTitle));
    rows += detailRow(
      'When',
      esc(dayName(d.start.slice(0, 10)) + ' · ' + d.start.slice(0, 10)) +
        ', ' + esc(hhmm(d.start) + '–' + hhmm(d.end)),
    );
    rows += detailRow('Technician', esc(d.technicianName || 'Unassigned'));
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
    rows += detailRow('Promise', promiseText(d));
    var flags = [];
    if (d.locked) flags.push('locked (manager-pinned)');
    if (d.status !== 'confirmed') flags.push(d.status);
    if (flags.length) rows += detailRow('Flags', esc(flags.join(', ')));
    return (
      '<div class="detail-sheet" role="dialog" aria-modal="true">' +
      '<button type="button" class="detail-close" aria-label="Close">✕</button>' +
      '<h2>' + esc(c.name || 'Unknown customer') + '</h2>' +
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

  // ---- Manager write path ----

  function moveFlow(card, targetDate, laneRef, laneLabel) {
    var currentRef = card.getAttribute('data-ref');
    var sameDay = card.closest('.day').getAttribute('data-date') === targetDate;
    var body = {
      assignmentId: card.getAttribute('data-id'),
      date: targetDate,
      startTime: card.getAttribute('data-start'),
      endTime: card.getAttribute('data-end'),
      reason: 'Moved on the dispatch board',
    };
    // A lane drop assigns/reassigns; a plain day drop keeps the person (or
    // keeps it unassigned — moveVisit's omitted-ref semantics).
    if (laneRef && laneRef !== currentRef) body.technicianRef = laneRef;
    if (sameDay && !body.technicianRef) return; // dropped where it already was

    apiPost('/board/api/move', body, true).then(function (p) {
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
            // "Say what you did" includes a promise broken in the preview→commit
            // race window (someone promoted the promise between the two calls) —
            // the server reports it; never swallow it.
            var msg =
              'Moved to ' + targetDate + ' ' + body.startTime +
              (body.technicianRef ? ' — now with ' + (laneLabel || body.technicianRef) : '') +
              (r.body.promiseBroken ? '. This BROKE a customer promise — tell them' : '') +
              (r.body.warning ? '. ' + r.body.warning : '');
            toast(msg, !!r.body.promiseBroken);
            refresh();
          })
          .catch(function () {
            toast('Network error — the move may or may not have landed; refreshing.', true);
            refresh();
          });
      };
      if (p.body.requiresConfirmation) {
        confirmAsk(
          'This breaks a promised day (' + p.body.fromDay + ' → ' + p.body.toDay + '). ' +
            'The customer was told ' + p.body.fromDay + '. Move anyway?',
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

  function cancelFlow(card) {
    var body = { assignmentId: card.getAttribute('data-id') };
    apiPost('/board/api/cancel', body, true).then(function (p) {
      if (!p.ok) {
        toast(p.body.error || 'Cancel failed (' + p.status + ')', true);
        return;
      }
      var commit = function () {
        apiPost(
          '/board/api/cancel',
          { assignmentId: body.assignmentId, reason: 'Cancelled on the dispatch board' },
          false,
        )
          .then(function (r) {
            if (!r.ok) {
              toast(r.body.error || 'Cancel failed (' + r.status + ')', true);
              refresh();
              return;
            }
            // Disclose a promise that appeared between preview and commit —
            // the cancel one-shot must still "say what you did" in full.
            var hadPromise = r.body.promiseLevel && r.body.promiseLevel !== 'none';
            toast(
              'Cancelled ' + (p.body.customerName || 'the visit') + ' on ' + p.body.day +
                (hadPromise ? '. This visit was PROMISED to the customer — tell them' : ''),
              !!hadPromise,
            );
            refresh();
          })
          .catch(function () {
            toast('Network error — the cancel may or may not have landed; refreshing.', true);
            refresh();
          });
      };
      if (p.body.requiresConfirmation) {
        confirmAsk(
          (p.body.customerName || 'The customer') + ' was promised a ' +
            (p.body.promiseLevel === 'time' ? 'time' : 'day') + ' on ' + p.body.day +
            '. Cancel anyway?',
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
      // The Unassigned lane is a drag SOURCE only — moveVisit cannot detach a
      // person, so a drop here must be INERT, not silently degrade into a
      // day-move the gesture never meant.
      if (laneEl.classList.contains('lane-unassigned')) return null;
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
        if (t) moveFlow(card, t.date, t.laneRef, t.label);
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
      state.today = null;
      refresh();
    }
  });
  refresh();
})();
