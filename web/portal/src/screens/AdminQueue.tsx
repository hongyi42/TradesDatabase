import { Button, S } from '../components/ui.js';
import { QUEUE } from '../data/mock.js';

// Internal-only screen. Note for wiring: this is the SECOND cross-tenant
// surface in the system (the /admin cost dashboard is the first), and unlike
// that one it will be reached from the same app shell customers use. It must
// authenticate as an operator, not as a signed-in customer, and must never be
// reachable by a customer session — the sidebar link is only rendered for
// operator sessions once auth is real.

function Metric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div style={{ ...S.card, borderRadius: 10, padding: 16 }}>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-4)' }}>{label}</p>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 27,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: danger ? 'var(--danger)' : 'var(--ink)',
        }}
      >
        {value}
      </p>
    </div>
  );
}

export function AdminQueue() {
  return (
    <>
      <h1 style={S.h1}>Admin queue</h1>
      <p style={S.sub}>Internal only. Provisioning failures and records held for review.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 22 }}>
        <Metric label="Provisioning now" value="3" />
        <Metric label="Failed in 24h" value="1" danger />
        <Metric label="Lightsail capacity used" value="62%" />
      </div>

      <div style={{ ...S.card, overflow: 'hidden', marginTop: 22 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1.3fr 1.4fr 190px',
            gap: 16,
            padding: '10px 18px',
            background: 'var(--surface-alt-2)',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span style={S.colHead}>Account</span>
          <span style={S.colHead}>Item</span>
          <span style={S.colHead}>Reason</span>
          <span />
        </div>

        {QUEUE.map((q, i) => (
          <div
            key={q.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1.3fr 1.4fr 190px',
              gap: 16,
              padding: '14px 18px',
              alignItems: 'center',
              borderTop: i === 0 ? 0 : '1px solid var(--line-soft)',
            }}
          >
            <span style={{ fontSize: 13.5, fontWeight: 500 }}>{q.account}</span>
            <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-3)' }}>{q.item}</span>
            <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{q.reason}</span>
            <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="outline" style={{ padding: '6px 12px', fontSize: 12.5, borderRadius: 'var(--r-btn-sm)' }}>
                Dismiss
              </Button>
              <Button variant="dark" style={{ padding: '6px 12px', fontSize: 12.5, borderRadius: 'var(--r-btn-sm)' }}>
                {q.action}
              </Button>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
