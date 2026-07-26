// Operator cost dashboard. Plain DOM, no build step, no framework (board
// precedent). Every figure comes from the authed JSON call — nothing is
// computed here that the server did not already commit to.

const $ = (id) => document.getElementById(id);
const KEY = 'admin-dashboard-token';

// sessionStorage, never the URL: a token in a query string lands in browser
// history, proxy logs, and any screenshot of the address bar.
const token = () => sessionStorage.getItem(KEY) ?? '';

const usd = (n) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;

let period = new Date().toISOString().slice(0, 7);

function shift(p, delta) {
  const d = new Date(`${p}-01T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

const monthName = (p) =>
  new Date(`${p}-01T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

async function fetchReport(p) {
  const res = await fetch(`/admin/api/costs?period=${encodeURIComponent(p)}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 503) throw new Error('the dashboard is not configured on this server');
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

// Append the est. marker to any element showing a part-allocated figure. Used on
// the headline total, the per-tenant Cost and $/seat cells, and each breakdown
// line — inference is allocated BY DESIGN and is usually the largest vendor, so
// the biggest number on the page is nearly always part-estimate. Bare, it reads
// as a metered fact.
function markEstimate(el) {
  const tag = document.createElement('span');
  tag.className = 'est-tag';
  tag.textContent = 'est.';
  el.append(tag);
}

function renderProviders(byProvider) {
  const host = $('providers');
  host.textContent = '';
  if (byProvider.length === 0) {
    host.innerHTML = '<p class="muted">No spend recorded for this month.</p>';
    return;
  }
  const max = Math.max(...byProvider.map((p) => p.costUsd), 0.0001);
  for (const p of byProvider) {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const name = document.createElement('div');
    name.className = 'bar-name';
    name.textContent = p.provider;

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    // Hatched when any part of the total was allocated rather than metered.
    fill.className = p.hasEstimate ? 'bar-fill est' : 'bar-fill';
    fill.style.width = `${Math.max((p.costUsd / max) * 100, 1)}%`;
    track.append(fill);

    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = usd(p.costUsd);
    if (p.hasEstimate) markEstimate(value);

    row.append(name, track, value);
    host.append(row);
  }
}

function renderTenants(tenants) {
  const body = $('tenants').querySelector('tbody');
  body.textContent = '';
  if (tenants.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No tenant spend this month.</td></tr>';
    return;
  }
  for (const t of tenants) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'tenant-name';
    name.textContent = t.tenantName;

    const seats = document.createElement('td');
    seats.className = 'num';
    seats.textContent = t.seats || '—';

    const cost = document.createElement('td');
    cost.className = 'num';
    cost.textContent = usd(t.costUsd);
    if (t.hasEstimate) markEstimate(cost);

    // The number that actually matters commercially: cost per seat is gross
    // margin per seat once you know what a seat sells for. '—' when seats are
    // unknown — "we can't say" is not the same claim as "$0.00".
    const perSeat = document.createElement('td');
    perSeat.className = 'num';
    perSeat.textContent = t.costPerSeatUsd === null ? '—' : usd(t.costPerSeatUsd);
    if (t.hasEstimate && t.costPerSeatUsd !== null) markEstimate(perSeat);

    const breakdown = document.createElement('td');
    breakdown.className = 'breakdown';
    breakdown.append(
      ...t.lines.flatMap((l, i) => {
        const s = document.createElement('span');
        s.textContent = `${l.provider} ${usd(l.costUsd)}`;
        if (l.method === 'allocated') markEstimate(s);
        return i === 0 ? [s] : [document.createTextNode(' · '), s];
      }),
    );

    tr.append(name, seats, cost, perSeat, breakdown);
    body.append(tr);
  }
}

function renderTrend(trend) {
  const host = $('trend');
  host.textContent = '';
  const max = Math.max(...trend.map((t) => t.totalUsd), 0.0001);
  for (const t of trend) {
    const col = document.createElement('div');
    col.className = 'trend-col';
    const bar = document.createElement('div');
    bar.className = 'trend-bar';
    bar.style.height = `${Math.max((t.totalUsd / max) * 100, 1)}%`;
    bar.title = `${t.period}: ${usd(t.totalUsd)}`;
    const label = document.createElement('div');
    label.className = 'trend-label';
    label.textContent = t.period.slice(5);
    col.append(bar, label);
    host.append(col);
  }
}

function render(report) {
  $('period-label').textContent = monthName(report.period);
  const total = $('total');
  total.textContent = usd(report.totalUsd);
  if (report.totalHasEstimate) markEstimate(total);
  $('tenant-count').textContent = String(report.tenants.length);
  $('generated').textContent = `updated ${new Date(report.generatedAt).toLocaleString()}`;

  const delta = $('delta');
  if (report.previousTotalUsd > 0) {
    const pct = ((report.totalUsd - report.previousTotalUsd) / report.previousTotalUsd) * 100;
    delta.textContent = `${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}% vs last month`;
    delta.className = `delta ${pct >= 0 ? 'up' : 'down'}`;
  } else {
    delta.textContent = 'no prior month to compare';
    delta.className = 'delta';
  }

  renderProviders(report.byProvider);
  renderTenants(report.tenants);
  renderTrend(report.trend);
  // Never offer a future month — there is nothing there to show.
  $('next').disabled = report.period >= new Date().toISOString().slice(0, 7);
}

async function load() {
  try {
    render(await fetchReport(period));
    $('gate').hidden = true;
    $('app').hidden = false;
  } catch (err) {
    if (err.message === 'unauthorized') {
      sessionStorage.removeItem(KEY);
      $('app').hidden = true;
      $('gate').hidden = false;
      $('gate-error').textContent = 'That token was not accepted.';
      $('gate-error').hidden = false;
      return;
    }
    $('gate').hidden = true;
    $('app').hidden = false;
    $('generated').textContent = err.message;
  }
}

$('gate').addEventListener('submit', (e) => {
  e.preventDefault();
  sessionStorage.setItem(KEY, $('token').value.trim());
  $('token').value = '';
  $('gate-error').hidden = true;
  load();
});

$('prev').addEventListener('click', () => {
  period = shift(period, -1);
  load();
});
$('next').addEventListener('click', () => {
  period = shift(period, 1);
  load();
});

if (token()) load();
else $('gate').hidden = false;
