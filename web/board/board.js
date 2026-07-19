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
  var state = { isManager: false, rendered: false, view: 'team' };

  function actionable() {
    return state.isManager && state.view === 'team';
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

  function stopCard(stop) {
    // .draggable (Team tab only) is what carries touch-action:none — the
    // read-only views (technician, manager's Mine tab) must keep native
    // card-origin scrolling.
    return (
      '<div class="stop' + (actionable() ? ' draggable' : '') + '" data-id="' + esc(stop.assignmentId) + '"' +
      ' data-start="' + esc(hhmm(stop.start)) + '" data-end="' + esc(hhmm(stop.end)) + '"' +
      ' data-ref="' + esc(stop.technicianRef || '') + '">' +
      '<div class="stop-time">' + esc(hhmm(stop.start)) + '–' + esc(hhmm(stop.end)) + '</div>' +
      '<div class="stop-body"><div class="stop-customer">' +
      esc(stop.customer || 'Unknown customer') +
      '</div>' +
      (stop.address ? '<div class="stop-address">' + esc(stop.address) + '</div>' : '') +
      '</div><div class="stop-badges">' + stopBadges(stop) + '</div>' +
      (actionable()
        ? '<button type="button" class="stop-cancel" aria-label="Cancel visit">✕</button>'
        : '') +
      '</div>'
    );
  }

  function lane(cls, laneRef, label, stops) {
    return (
      '<div class="' + cls + '" data-lane="' + esc(laneRef) + '"><h3>' + esc(label) + '</h3>' +
      stops.map(stopCard).join('') +
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
    var html = '<section class="day" data-date="' + esc(date) + '"><h2>' + esc(date) + '</h2>';
    if (!stops.length) {
      html += '<div class="day-empty">No visits</div>';
    } else if (!teamLayout) {
      html += stops.map(stopCard).join('');
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
        html += lane('lane', key, labels[key], lanes[key]);
      });
      // Unassigned lane renders last so it reads as the "to place" tray.
      if (unassigned.length) {
        html += lane('lane lane-unassigned', '', 'Unassigned', unassigned);
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
    var head =
      '<header><h1>Dispatch board</h1><div class="range">' +
      esc(data.from) + ' → ' + esc(data.to) +
      (isManager ? (data.view === 'mine' ? ' · your visits' : '') : ' · your stops') +
      '</div>' +
      (isManager ? tabsBar() : '') +
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

  // `requestedView` is the tab the user ASKED for; state.view stays the
  // COMMITTED (rendered) view and only render() moves it, from the server's
  // echo. A failed fetch therefore leaves state and DOM agreeing — the
  // review-caught alternative (flip state at click time) let a failed switch
  // arm drag-writes on a list still rendered read-only.
  function load(requestedView) {
    // First call learns the FIRM-local `from` (server computes it — the client
    // clock never decides what "today" is), second widens to a 7-day window.
    // The selected tab rides as view=mine on both calls (harmless on the
    // first; the server ignores it for non-managers).
    var v = (requestedView || state.view) === 'mine' ? 'view=mine' : '';
    return apiGet(v ? '?' + v : '').then(function (first) {
      if (!first) return null;
      return apiGet(
        '?from=' + first.from + '&to=' + addDays(first.from, 6) + (v ? '&' + v : ''),
      ).then(function (data) {
        if (!data) return null;
        state.isManager = data.tier === 'manager';
        render(data);
        return data;
      });
    });
  }

  // Every load goes through this: a fetch-level REJECTION (network error, no
  // HTTP status) must never strand the page on "Loading…" or silently keep a
  // stale board after a committed write — the exact regression the Phase-2
  // .catch prevented before the Phase-3 rewrite dropped it.
  function refresh(requestedView) {
    return load(requestedView).catch(function () {
      if (state.rendered) toast('Network error — the board may be stale; try again.', true);
      else showEmpty('Network error — reopen the board to retry.');
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
    if (laneEl) {
      // The Unassigned lane is a drag SOURCE only — moveVisit cannot detach a
      // person, so a drop here must be INERT, not silently degrade into a
      // day-move the gesture never meant.
      if (laneEl.classList.contains('lane-unassigned')) return null;
      var h3 = laneEl.querySelector('h3');
      return {
        date: laneEl.closest('.day').getAttribute('data-date'),
        laneRef: laneEl.getAttribute('data-lane'),
        label: h3 ? h3.textContent : null,
        el: laneEl,
      };
    }
    var dayEl = el.closest && el.closest('.day');
    if (dayEl) {
      return { date: dayEl.getAttribute('data-date'), laneRef: null, label: null, el: dayEl };
    }
    return null;
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
    positionChip(x, y);
  }

  function positionChip(x, y) {
    drag.chip.style.left = x + 'px';
    drag.chip.style.top = y + 'px';
  }

  function endDrag() {
    if (!drag) return;
    if (tg && typeof tg.enableVerticalSwipes === 'function') tg.enableVerticalSwipes();
    drag.card.classList.remove('dragging');
    drag.chip.remove();
    drag = null;
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
      var btn = e.target.closest && e.target.closest('.stop-cancel');
      if (btn) cancelFlow(btn.closest('.stop'));
    });

    app.addEventListener('pointerdown', function (e) {
      if (!actionable() || drag) return;
      if (e.target.closest && e.target.closest('.stop-cancel')) return;
      var card = e.target.closest && e.target.closest('.stop');
      if (!card) return;
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
  refresh();
})();
