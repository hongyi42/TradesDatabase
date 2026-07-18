// Dispatch board page script. Runs inside the Telegram Mini App webview; the
// server verifies every API call's initData, so this file holds NO auth logic —
// it just forwards the slip. Times/dates print VERBATIM (naive-local rule:
// start.slice(11,16), promisedDay as stored) — no timezone math in the browser.
/* global Telegram */
(function () {
  'use strict';

  var tg = window.Telegram && Telegram.WebApp;
  var app = document.getElementById('app');

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

  function hhmm(iso) {
    return iso.slice(11, 16);
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
    return (
      '<div class="stop" data-id="' + esc(stop.assignmentId) + '">' +
      '<div class="stop-time">' + esc(hhmm(stop.start)) + '–' + esc(hhmm(stop.end)) + '</div>' +
      '<div class="stop-body"><div class="stop-customer">' +
      esc(stop.customer || 'Unknown customer') +
      '</div>' +
      (stop.address ? '<div class="stop-address">' + esc(stop.address) + '</div>' : '') +
      '</div><div class="stop-badges">' + stopBadges(stop) + '</div></div>'
    );
  }

  function lane(cls, laneRef, label, stops) {
    return (
      '<div class="' + cls + '" data-lane="' + esc(laneRef) + '"><h3>' + esc(label) + '</h3>' +
      stops.map(stopCard).join('') +
      '</div>'
    );
  }

  // Manager view: per-technician lanes plus an "Unassigned" lane for stops with
  // unassigned:true (their technicianName is null — never print "null"). Lanes
  // are keyed by technicianRef — the UNIQUE roster handle — never by display
  // name (two "Mike Chen"s must not merge, and Phase 3's drag-to-assign needs a
  // single ref per drop target). The unassigned lane's data-lane is ''.
  function renderDay(day, isManager) {
    var html = '<section class="day"><h2>' + esc(day.date) + '</h2>';
    if (!isManager) {
      html += day.stops.map(stopCard).join('');
    } else {
      var lanes = {};
      var labels = {};
      var order = [];
      var unassigned = [];
      day.stops.forEach(function (stop) {
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

  function render(data) {
    var isManager = data.tier === 'manager';
    var head =
      '<header><h1>Dispatch board</h1><div class="range">' +
      esc(data.from) + (data.to !== data.from ? ' → ' + esc(data.to) : '') +
      (isManager ? '' : ' · your day') +
      '</div></header>';
    if (!data.days.length) {
      app.innerHTML = head + '<div class="empty">Nothing scheduled in this window.</div>';
      return;
    }
    app.innerHTML =
      head +
      data.days
        .map(function (d) {
          return renderDay(d, isManager);
        })
        .join('');
  }

  function load() {
    return fetch('/board/api/day', {
      headers: { Authorization: 'tma ' + tg.initData },
    })
      .then(function (resp) {
        if (resp.status === 409) {
          showEmpty('This Telegram account is on more than one firm — ask your operator.');
          return null;
        }
        if (!resp.ok) {
          showEmpty("Couldn't verify you (" + resp.status + '). Reopen the board from Telegram.');
          return null;
        }
        return resp.json();
      })
      .then(function (data) {
        if (data) render(data);
      })
      .catch(function () {
        showEmpty('Network error — pull to retry.');
      });
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
  load();
})();
