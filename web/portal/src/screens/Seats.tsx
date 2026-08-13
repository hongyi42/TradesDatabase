import { useMemo, useState } from 'react';
import { Button, MonoButton, Pill, S } from '../components/ui.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  TIER_LABEL,
  countByTier,
  displayStatus,
  moneyShort,
  PRICE_CENTS,
  type DisplayStatus,
  type Seat,
  type Tier,
} from '../data/model.js';

export type SortKey = 'name' | 'trade' | 'tier' | 'status';
export type SortDir = 'asc' | 'desc';

const GRID = '1.5fr 0.9fr 1fr 1.1fr 1.2fr 0.9fr 1fr 34px';

const STATUS_TONE: Record<DisplayStatus, 'teal' | 'amber' | 'muted'> = {
  Active: 'teal',
  Provisioning: 'amber',
  Suspended: 'muted',
  Offboarded: 'muted',
};

function SortHeader({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={{ ...S.colHead, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}
    >
      {label}
      {active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

export function Seats({
  seats,
  purchased,
  onOpenSeat,
  onAddSeat,
  onDeleteSeat,
}: {
  seats: Seat[];
  // Purchased capacity comes in as a PROP, not from the mock module. Importing
  // the constant here meant the summary line kept reporting the seed value
  // while the seat list moved, so buying a seat rendered "3 of 2 manager
  // seats" — a used count above the cap, which is the one thing this line
  // exists to make impossible to miss.
  purchased: Record<Tier, number>;
  onOpenSeat: (ref: string) => void;
  // Both are OPTIONAL and currently undefined. Adding a seat spends money and
  // releasing one credits it (Phases 3 and 6 of the 2026-08-07 plan); neither
  // has a backend yet. Passing undefined disables the control, which is honest —
  // a button that silently mutates local state would look like it worked.
  onAddSeat?: () => void;
  onDeleteSeat?: (ref: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [pendingDelete, setPendingDelete] = useState<Seat | null>(null);

  function sort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir('asc');
    }
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = seats.filter((s) => {
      if (statusFilter !== 'all' && displayStatus(s) !== statusFilter) return false;
      if (tierFilter !== 'all' && s.tier !== tierFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.trade.toLowerCase().includes(q) ||
        (s.telegramUserId ?? '').includes(q)
      );
    });
    const key = (s: Seat) =>
      sortKey === 'name' ? s.name : sortKey === 'trade' ? s.trade : sortKey === 'tier' ? s.tier : displayStatus(s);
    return [...filtered].sort((a, b) => {
      const cmp = key(a).localeCompare(key(b));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [seats, query, statusFilter, tierFilter, sortKey, sortDir]);

  const mgr = countByTier(seats, 'manager');
  const tech = countByTier(seats, 'technician');
  const exempt = seats.filter((s) => s.seatExempt).length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={S.h1}>Seats</h1>
          <p style={S.sub}>
            {mgr} of {purchased.manager} manager seats at {moneyShort(PRICE_CENTS.manager)} ·{' '}
            {tech} of {purchased.technician} technician seats at {moneyShort(PRICE_CENTS.technician)}
            {exempt > 0 && ` · ${exempt} scheduled person on no seat`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <MonoButton>Export CSV</MonoButton>
          <Button
            variant="primary"
            onClick={onAddSeat}
            disabled={!onAddSeat}
            title={onAddSeat ? undefined : 'Buying a seat is not switched on yet — talk to us and we’ll add it.'}
          >
            Add seat
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, margin: '22px 0 14px', flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, trade or Telegram ID"
          aria-label="Search seats"
          style={{
            flex: '1 1 240px',
            maxWidth: 340,
            padding: 9,
            borderRadius: 'var(--r-nav)',
            border: '1px solid var(--input-border)',
            background: 'var(--surface)',
            fontSize: 13.5,
          }}
        />
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          aria-label="Filter by tier"
          style={{ padding: 9, borderRadius: 'var(--r-nav)', border: '1px solid var(--input-border)', background: 'var(--surface)', fontSize: 13.5 }}
        >
          <option value="all">All tiers</option>
          <option value="manager">Manager</option>
          <option value="technician">Technician</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          style={{ padding: 9, borderRadius: 'var(--r-nav)', border: '1px solid var(--input-border)', background: 'var(--surface)', fontSize: 13.5 }}
        >
          <option value="all">All statuses</option>
          <option value="Active">Active</option>
          <option value="Provisioning">Provisioning</option>
          <option value="Suspended">Suspended</option>
        </select>
      </div>

      <div style={{ ...S.card, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID,
            gap: 14,
            padding: '10px 18px',
            background: 'var(--surface-alt-2)',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <SortHeader label="Name" k="name" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
          <SortHeader label="Tier" k="tier" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
          <SortHeader label="Trade" k="trade" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
          <span style={S.colHead}>Telegram ID</span>
          <span style={S.colHead}>Bot</span>
          <span style={S.colHead}>Sandbox</span>
          <SortHeader label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
          <span />
        </div>

        {rows.map((s, i) => {
          const status = displayStatus(s);
          return (
            <div
              key={s.ref}
              style={{
                display: 'grid',
                gridTemplateColumns: GRID,
                gap: 14,
                padding: '14px 18px',
                alignItems: 'center',
                borderTop: i === 0 ? 0 : '1px solid var(--line-soft)',
              }}
            >
              <button
                type="button"
                onClick={() => onOpenSeat(s.ref)}
                style={{
                  textAlign: 'left',
                  background: 'none',
                  border: 0,
                  padding: 0,
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: 'var(--ink)',
                  cursor: 'pointer',
                }}
              >
                {s.name}
              </button>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                {s.seatExempt ? '—' : TIER_LABEL[s.tier]}
              </span>
              <span style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{s.trade}</span>
              <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-3)' }}>{s.telegramUserId ?? '—'}</span>
              <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-3)' }}>{s.botUsername ?? '—'}</span>
              <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-3)' }}>{s.sandboxRef ?? '—'}</span>
              {s.seatExempt ? (
                <Pill tone="muted">No seat</Pill>
              ) : (
                <Pill tone={STATUS_TONE[status]}>{status}</Pill>
              )}
              <button
                type="button"
                onClick={() => setPendingDelete(s)}
                disabled={!onDeleteSeat}
                aria-label={`Delete seat for ${s.name}`}
                title={`Delete seat for ${s.name}`}
                style={{
                  background: 'none',
                  border: 0,
                  padding: 0,
                  fontSize: 16,
                  lineHeight: 1,
                  color: 'var(--ink-5)',
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>
          );
        })}

        {rows.length === 0 && (
          <p style={{ margin: 0, padding: '28px 18px', fontSize: 13.5, color: 'var(--ink-4)' }}>
            No seats match those filters.
          </p>
        )}
      </div>

      {/* Footnote sits directly on the shell, so it takes shell ink. */}
      <p style={{ margin: '14px 0 0', fontSize: 12.5, color: 'var(--shell-ink-2)' }}>
        Deleting a seat destroys its sandbox and revokes the bot token. Credit is prorated to the
        next invoice.
      </p>

      {/* The handoff deletes immediately and flags that as a prototype-only
          shortcut: "It must be behind a confirmation dialog in production — it
          destroys infrastructure and revokes a token." It also cannot be
          undone here in the way the copy implies: roster refs are never reused,
          so the person cannot be restored to the same seat later. */}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.name}’s seat?`}
          confirmLabel="Delete the seat"
          destructive
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDeleteSeat?.(pendingDelete.ref);
            setPendingDelete(null);
          }}
        >
          {/* A seat still provisioning has no sandbox yet, and a seat-exempt
              person has neither — the sentence has to hold in all three cases. */}
          <p style={{ margin: 0 }}>
            {pendingDelete.sandboxRef ? (
              <>
                This destroys sandbox <span style={S.mono}>{pendingDelete.sandboxRef}</span> and
                revokes <span style={S.mono}>{pendingDelete.botUsername}</span>. They lose access
                straight away.
              </>
            ) : pendingDelete.botUsername ? (
              <>
                Their sandbox is still being set up. This cancels it and revokes{' '}
                <span style={S.mono}>{pendingDelete.botUsername}</span>.
              </>
            ) : (
              <>They have no bot or sandbox, so nothing is destroyed — this only frees the seat.</>
            )}
          </p>
          <p style={{ margin: '10px 0 0' }}>
            Credit is prorated onto your next invoice. Their record of past jobs is kept — but the
            seat cannot be handed back to the same person later, so re-hiring means a new seat.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
