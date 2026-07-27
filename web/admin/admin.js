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

async function get(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token()}` } });
  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 503) throw new Error('the dashboard is not configured on this server');
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

const fetchReport = (p) => get(`/admin/api/costs?period=${encodeURIComponent(p)}`);
const fetchTenant = (id, p) =>
  get(`/admin/api/tenant?tenantId=${encodeURIComponent(id)}&period=${encodeURIComponent(p)}`);

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

    // TWO segments, not one tinted bar: since the spine's model calls moved to
    // GLM on DeepInfra, that vendor carries both precisely-metered spine spend
    // and the allocated share of the agent invoice. One bar flagged "est." would
    // either slander the measured half or launder the estimated half.
    const track = document.createElement('div');
    track.className = 'bar-track';
    for (const [amount, cls] of [[p.measuredUsd, 'bar-fill'], [p.allocatedUsd, 'bar-fill est']]) {
      if (amount <= 0) continue;
      const seg = document.createElement('div');
      seg.className = cls;
      seg.style.width = `${Math.max((amount / max) * 100, 1)}%`;
      seg.title = `${cls.includes('est') ? 'allocated' : 'measured'} ${usd(amount)}`;
      track.append(seg);
    }

    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = usd(p.costUsd);
    if (p.allocatedUsd > 0) markEstimate(value);

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

    // Seat tiers stay SEPARATE. Manager seats price higher and cost more to serve
    // than technician seats, so a blended $/seat divides two different products by
    // one denominator and describes neither — it is omitted rather than shown
    // misleadingly.
    const mgr = document.createElement('td');
    mgr.className = 'num';
    mgr.textContent = t.managerSeats || '—';

    const tech = document.createElement('td');
    tech.className = 'num';
    tech.textContent = t.technicianSeats || '—';

    const cost = document.createElement('td');
    cost.className = 'num';
    cost.textContent = usd(t.costUsd);
    if (t.hasEstimate) markEstimate(cost);

    const open = document.createElement('td');
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link';
    link.textContent = 'Breakdown ›';
    link.addEventListener('click', () => showTenant(t.tenantId));
    open.append(link);

    tr.append(name, mgr, tech, cost, open);
    body.append(tr);
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
  paintTrend($('trend'), report.trend);
  // Never offer a future month — there is nothing there to show.
  $('next').disabled = report.period >= new Date().toISOString().slice(0, 7);
}

// Render a bar chart of six monthly totals into `host`.
function paintTrend(host, trend) {
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

function renderTenantPage(r) {
  $('t-name').textContent = r.tenantName;
  $('t-seats').textContent = `${r.managerSeats} manager · ${r.technicianSeats} technician`;
  $('t-period').textContent = monthName(r.period);
  $('t-total').textContent = usd(r.totalUsd);
  $('t-measured').textContent = usd(r.measuredUsd);
  const alloc = $('t-allocated');
  alloc.textContent = usd(r.allocatedUsd);
  if (r.allocatedUsd > 0) markEstimate(alloc);

  const provBody = $('t-providers').querySelector('tbody');
  provBody.textContent = '';
  for (const p of r.providers) {
    const tr = document.createElement('tr');
    for (const [text, cls] of [[p.provider, ''], [p.method, 'breakdown'], [usd(p.costUsd), 'num']]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      if (cls === 'num' && p.method === 'allocated') markEstimate(td);
      tr.append(td);
    }
    provBody.append(tr);
  }

  const useBody = $('t-usage').querySelector('tbody');
  useBody.textContent = '';
  for (const u of r.usage) {
    const tr = document.createElement('tr');
    const cells = [
      [u.provider, ''],
      [u.sku, 'breakdown'],
      [`${u.quantity.toLocaleString()} ${u.unit}`, 'num'],
      [u.events.toLocaleString(), 'num'],
      // null cost = no rate covers this line. '—' says "not priced", which is a
      // different claim from "$0.00" — spine is unpriced BY DESIGN.
      [u.costUsd === null ? '—' : usd(u.costUsd), 'num'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.append(td);
    }
    useBody.append(tr);
  }
  const unpriced = r.usage.filter((u) => u.costUsd === null).map((u) => `${u.provider}/${u.sku}`);
  $('t-usage-note').textContent = unpriced.length
    ? `Not priced: ${unpriced.join(', ')} — spine is a counter (it drives the inference split), anything else means a gap in the price book.`
    : '';

  paintTrend($('t-trend'), r.trend);
}

let currentTenantId = null;

async function showTenant(tenantId) {
  currentTenantId = tenantId;
  try {
    renderTenantPage(await fetchTenant(tenantId, period));
    $('app').hidden = true;
    $('tenant').hidden = false;
    window.scrollTo(0, 0);
  } catch (err) {
    if (err.message === 'unauthorized') return load();
    $('t-usage-note').textContent = err.message;
  }
}

function showOverview() {
  currentTenantId = null;
  $('tenant').hidden = true;
  $('app').hidden = false;
}

async function load() {
  try {
    render(await fetchReport(period));
    $('gate').hidden = true;
    $('tenant').hidden = true;
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

// The month pager drives whichever view is open, so stepping months while
// looking at one tenant keeps you on that tenant.
const step = (delta) => {
  period = shift(period, delta);
  if (currentTenantId) showTenant(currentTenantId);
  else load();
};
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('back').addEventListener('click', showOverview);

if (token()) load();
else $('gate').hidden = false;
