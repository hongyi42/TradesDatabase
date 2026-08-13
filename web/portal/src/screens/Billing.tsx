import { Button, MonoButton, Pill, S, SectionHeading } from '../components/ui.js';
import { ACCOUNT, INVOICES, USER } from '../data/mock.js';
import { TIER_LABEL, money, moneyShort, type TierLine } from '../data/model.js';

// The handoff's estimate card has a single "N seats × $18" row. It becomes one
// row PER TIER here — manager and technician are different products at
// different prices, and the DB keeps their caps separate for exactly that
// reason. There is deliberately no combined "8 seats × $x" line anywhere.

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline' }}>
      <span style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{label}</span>
      <span style={{ ...S.mono, fontSize: 13, color: muted ? 'var(--ink-5)' : 'var(--ink)' }}>{value}</span>
    </div>
  );
}

export function Billing({
  lines,
  prorationCents,
  totalCents,
  notWired,
}: {
  lines: TierLine[];
  prorationCents: number;
  totalCents: number;
  /**
   * Plan D5. There is no Stripe account (the owner descoped billing on
   * 2026-08-12), so every figure on this screen is illustrative. The tempting
   * shortcut is to derive one from seats × price — but that invents a number
   * nobody will actually be charged, on the single screen whose whole purpose is
   * telling someone what they owe. A visible "not connected" state is honest; a
   * plausible wrong number is not. Remove this prop when Stripe lands.
   */
  notWired?: boolean;
}) {
  return (
    <>
      <h1 style={S.h1}>Billing</h1>
      <p style={S.sub}>
        {ACCOUNT.name} · {ACCOUNT.plan} · {ACCOUNT.billingCycle}
      </p>

      {notWired && (
        <div
          role="status"
          style={{
            marginTop: 16,
            padding: '13px 16px',
            borderRadius: 10,
            background: 'var(--amber-tint-bg)',
            border: '1px solid var(--amber-tint-line)',
            color: 'var(--ink)',
          }}
        >
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            Not connected to billing yet
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: 'var(--ink-2)' }}>
            Every figure on this page is an example, not your bill. Seats and people are real —
            invoices and payment are not switched on. We&rsquo;ll tell you before that changes.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18, marginTop: 22 }}>
        <section style={{ ...S.card, padding: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <p style={{ margin: 0, ...S.label }}>Estimated for August</p>
              <p
                style={{
                  margin: '8px 0 0',
                  fontFamily: 'var(--display)',
                  fontSize: 40,
                  fontWeight: 800,
                  letterSpacing: '-0.04em',
                }}
              >
                {money(totalCents)}
              </p>
            </div>
            <Button variant="outline">Pay now</Button>
          </div>

          <div style={{ height: 1, background: 'var(--line)', margin: '20px 0' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {lines.map((l) => (
              <Row
                key={l.tier}
                label={`${l.purchased} ${TIER_LABEL[l.tier].toLowerCase()} seat${l.purchased === 1 ? '' : 's'} × ${moneyShort(l.unitCents)}`}
                value={money(l.subtotalCents)}
              />
            ))}
            <Row
              label="Prorated additions (1 technician seat, 11 days)"
              value={money(prorationCents)}
            />
            <Row label="Sandbox overage" value={money(0)} muted />
          </div>
        </section>

        <section style={{ ...S.card, padding: 22, display: 'flex', flexDirection: 'column' }}>
          <p style={{ margin: 0, ...S.label }}>Payment method</p>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: '1px solid var(--line)',
              borderRadius: 9,
              padding: 12,
              marginTop: 12,
            }}
          >
            <div style={{ width: 38, height: 25, borderRadius: 4, background: 'var(--ink)', flex: 'none' }} />
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500 }}>Visa ending 4417</p>
              <p style={{ margin: 0, ...S.mono, fontSize: 11.5, color: 'var(--ink-5)' }}>exp 04/29</p>
            </div>
          </div>

          <Button variant="dashed" style={{ marginTop: 10, width: '100%', padding: '10px 12px', fontSize: 13 }}>
            + Add another card
          </Button>

          <div style={{ flex: 1, minHeight: 18 }} />

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-4)' }}>Billing contact</p>
            <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--ink-2)' }}>{USER.email}</p>
          </div>
        </section>
      </div>

      <SectionHeading title="Invoices" right={<MonoButton>Export CSV</MonoButton>} />

      <div style={{ ...S.card, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.2fr 1fr 1fr 1fr auto',
            gap: 16,
            padding: '10px 18px',
            background: 'var(--surface-alt-2)',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span style={S.colHead}>Invoice</span>
          <span style={S.colHead}>Period</span>
          <span style={S.colHead}>Seats</span>
          <span style={S.colHead}>Amount</span>
          <span style={S.colHead}>Status</span>
        </div>
        {INVOICES.map((inv, i) => (
          <div
            key={inv.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.2fr 1fr 1fr 1fr auto',
              gap: 16,
              padding: '14px 18px',
              alignItems: 'center',
              borderTop: i === 0 ? 0 : '1px solid var(--line-soft)',
            }}
          >
            <span style={{ ...S.mono, fontSize: 12.5 }}>{inv.id}</span>
            <span style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{inv.period}</span>
            {/* Split, not summed — same rule as the estimate card. */}
            <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-3)' }}>
              {inv.managerSeats} mgr · {inv.technicianSeats} tech
            </span>
            <span style={{ ...S.mono, fontSize: 12.5 }}>{money(inv.amountCents)}</span>
            <Pill tone="teal">{inv.status}</Pill>
          </div>
        ))}
      </div>
    </>
  );
}
