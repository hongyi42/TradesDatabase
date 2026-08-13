import { Button, Dot, Pill, S } from '../components/ui.js';
import { ACCOUNT, RECORDS, SANDBOX_LOG } from '../data/mock.js';
import { downloadText } from '../data/csv.js';
import { PRICE_CENTS, TIER_LABEL, displayStatus, moneyShort, type Seat } from '../data/model.js';

function Defs({ cols, rows }: { cols: string; rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: cols, rowGap: 13, columnGap: 18, margin: 0 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ fontSize: 13, color: 'var(--ink-4)' }}>{k}</dt>
          <dd style={{ margin: 0, fontSize: 13, color: 'var(--ink)' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SeatDetail({
  seat,
  onBack,
  onDelete,
}: {
  seat: Seat;
  onBack: () => void;
  /** Optional: releasing a seat credits money and has no backend yet (Phase 6). */
  onDelete?: () => void;
}) {
  const status = displayStatus(seat);

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          fontSize: 13,
          color: 'var(--shell-ink-2)',
          cursor: 'pointer',
        }}
      >
        ← Seats
      </button>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginTop: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 52, height: 52, borderRadius: 11, background: 'var(--nav-selected)', flex: 'none' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={S.h1}>{seat.name}</h1>
              <Pill tone={status === 'Active' ? 'teal' : status === 'Provisioning' ? 'amber' : 'muted'}>
                {status}
              </Pill>
            </div>
            <p style={S.sub}>
              {seat.trade} · {TIER_LABEL[seat.tier]} seat since {seat.seatSince} ·{' '}
              {moneyShort(PRICE_CENTS[seat.tier])}/mo
            </p>
          </div>
        </div>
        {/* These two sit on the shell, not in a card. */}
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="shell-outline">Suspend</Button>
          <Button variant="shell-danger" onClick={onDelete} disabled={!onDelete}>
            Delete seat
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 18, marginTop: 22 }}>
        <section style={{ ...S.card, padding: 22 }}>
          <h2 style={{ margin: '0 0 16px', fontFamily: 'var(--display)', fontSize: 14, fontWeight: 700 }}>Bot binding</h2>
          <Defs
            cols="130px 1fr"
            rows={[
              ['Bot handle', <span style={S.mono}>{seat.botUsername ?? '—'}</span>],
              [
                'Token',
                // Was a hardcoded masked string. On a REAL seat that reads as
                // this person's actual token fingerprint, which it never was —
                // the same "plausible wrong data" problem the Billing banner
                // exists to avoid (plan D5). Bot tokens are not in the API at
                // all: they arrive with Managed Bots in Phase 4, and are stored
                // encrypted and never rendered. Until then this is honestly
                // blank, like every other field we do not have.
                <span style={S.mono}>—</span>,
              ],
              ['Telegram user ID', <span style={S.mono}>{seat.telegramUserId ?? '—'}</span>],
              ['Webhook path', <span style={S.mono}>—</span>],
              ['Last message', <span style={{ color: 'var(--ink-2)' }}>—</span>],
            ]}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <Button variant="outline" style={{ fontSize: 13, padding: '8px 14px' }}>
              Rotate token
            </Button>
            <Button variant="outline" style={{ fontSize: 13, padding: '8px 14px' }}>
              Send test message
            </Button>
          </div>
        </section>

        <section style={{ ...S.card, padding: 22 }}>
          <h2 style={{ margin: '0 0 16px', fontFamily: 'var(--display)', fontSize: 14, fontWeight: 700 }}>Lightsail sandbox</h2>
          <Defs
            cols="110px 1fr"
            rows={[
              ['Instance', <span style={S.mono}>{seat.sandboxRef ?? '—'}</span>],
              // Region and plan are account-level, not per seat: one host, and
              // `hosts` carries no region or plan column.
              ['Host', <span style={S.mono}>{ACCOUNT.host}</span>],
              ['Region', <span style={S.mono}>{ACCOUNT.region}</span>],
              ['Uptime', <span style={{ color: 'var(--ink-2)' }}>6d 04h</span>],
              [
                'Health',
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Dot />
                  Healthy
                </span>,
              ],
            ]}
          />
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 18, paddingTop: 14 }}>
            {/* Illustrative: there is no provisioning-log endpoint yet (Phase 5).
                Labelled rather than removed so the shape of the screen survives,
                but nobody mistakes these lines for this seat's real history. */}
            <p style={{ margin: '0 0 8px', ...S.label, color: 'var(--ink-4)' }}>
              Example log · not this seat&rsquo;s real history
            </p>
            {SANDBOX_LOG.map((line) => (
              <p
                key={line}
                style={{ margin: 0, ...S.mono, fontSize: 11.5, lineHeight: 1.8, color: 'var(--ink-5)' }}
              >
                {line}
              </p>
            ))}
            {/* Per-seat log download. Inside a white card, so light variant. */}
            <Button
              variant="outline"
              style={{ marginTop: 14, fontSize: 13, padding: '8px 14px' }}
              onClick={() =>
                downloadText(
                  `sandbox-${seat.sandboxRef ?? seat.ref}-log.txt`,
                  [
                    `# ${seat.name} · sandbox ${seat.sandboxRef ?? '(none)'} · host ${ACCOUNT.host}`,
                    '',
                    ...SANDBOX_LOG,
                  ].join('\n'),
                  'text/plain;charset=utf-8',
                )
              }
            >
              Download full log
            </Button>
          </div>
        </section>
      </div>

      <h2 style={{ margin: '30px 0 12px', fontFamily: 'var(--display)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em', color: 'var(--shell-ink)' }}>
        Recent records logged
      </h2>
      <div style={{ ...S.card, padding: '4px 22px 18px' }}>
        {RECORDS.map((r, i) => (
          <div
            key={r.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr 1fr 90px',
              gap: 16,
              alignItems: 'center',
              padding: '13px 0',
              borderTop: i === 0 ? 0 : '1px solid var(--line-soft)',
            }}
          >
            <span style={{ ...S.mono, fontSize: 12 }}>{r.id}</span>
            <span style={{ fontSize: 13.5 }}>{r.description}</span>
            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>{r.site}</span>
            <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-5)' }}>{r.date}</span>
          </div>
        ))}
      </div>
    </>
  );
}
