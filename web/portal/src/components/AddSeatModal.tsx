import { useEffect, useRef, useState } from 'react';
import { Button, Dot, Field, S, inputStyle, selectStyle } from '../components/ui.js';
import { ACCOUNT } from '../data/mock.js';
import { PRICE_CENTS, TIER_LABEL, money, moneyShort, prorate, type Tier } from '../data/model.js';

// Three steps, per the handoff. Two of them changed against the design, both
// because the design was drawn without the codebase:
//
//  STEP 2 was "paste the BotFather token". Telegram's Managed Bots (Bot API
//  9.6, Apr 2026) replaced that: the customer taps t.me/newbot/<manager>/<name>,
//  Telegram creates the bot, and we fetch the token with getManagedBotToken.
//  The customer never handles a credential and we never take one through a
//  form. What is left on this step is a link and a waiting state.
//
//  STEP 3 dropped the Lightsail region and sandbox-size selects. Sandboxes are
//  pre-built cold blanks claimed from `sandbox_pool` on a single host; `hosts`
//  has no region or plan column, so those selects had nothing to bind to.
//  Region and host are shown as account facts instead.

const TRADES = ['Electrician', 'Plumber', 'Roofer', 'HVAC', 'Carpenter'];
const STEP_NAMES = ['Person', 'Telegram bot', 'Sandbox & billing'];

const DAYS_LEFT = 11;
const DAYS_IN_MONTH = 31;

export function AddSeatModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (seat: { name: string; trade: string; tier: Tier }) => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [trade, setTrade] = useState(TRADES[0]);
  const [tier, setTier] = useState<Tier>('technician');
  const [botCreated, setBotCreated] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handle = name.trim().toLowerCase().split(/\s+/)[0] || 'tech';
  const suggestedBot = `harrow_${handle}_bot`;
  const unit = PRICE_CENTS[tier];
  const proratedCents = prorate(unit, DAYS_LEFT, DAYS_IN_MONTH);

  const canContinue = step === 1 ? name.trim().length > 0 : step === 2 ? botCreated : true;

  function next() {
    if (step === 3) {
      onConfirm({ name: name.trim(), trade, tier });
      return;
    }
    setStep((s) => s + 1);
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        zIndex: 40,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add a seat"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '100%',
          background: 'var(--surface)',
          // Reset from the shell's light body colour (see S.card).
          color: 'var(--ink)',
          borderRadius: 'var(--r-modal)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            padding: '20px 24px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em' }}>Add a seat</h2>
            <p style={{ margin: '4px 0 0', ...S.mono, fontSize: 11.5, color: 'var(--ink-5)' }}>
              Step {step} of 3 · {STEP_NAMES[step - 1]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 0, fontSize: 18, lineHeight: 1, color: 'var(--ink-4)', cursor: 'pointer' }}
          >
            ×
          </button>
        </header>

        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {step === 1 && (
            <>
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Pete Rowan"
                  style={inputStyle}
                />
              </Field>
              <Field label="Trade">
                <select value={trade} onChange={(e) => setTrade(e.target.value)} style={selectStyle}>
                  {TRADES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              {/* Not in the design — forced by the two-tier model. */}
              <Field
                label="Seat type"
                helper="Managers can book work and pair a mailbox. Technicians get a curated tool list and cannot send email directly."
              >
                <select value={tier} onChange={(e) => setTier(e.target.value as Tier)} style={selectStyle}>
                  {(['technician', 'manager'] as Tier[]).map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t]} — {moneyShort(PRICE_CENTS[t])}/mo
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              <div
                style={{
                  background: 'var(--surface-alt-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 9,
                  padding: 14,
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: 'var(--ink-2)',
                }}
              >
                Tap the link below and Telegram will ask you to confirm one new bot for{' '}
                <strong style={{ color: 'var(--ink)' }}>{name.trim() || 'this person'}</strong>. That
                is the whole step — there is no token to copy and nothing to paste.
              </div>

              <a
                href={`https://t.me/newbot/TradesDatabaseSetupBot/${suggestedBot}?name=${encodeURIComponent(name.trim() || 'Trades')}`}
                onClick={(e) => {
                  // Prototype: no real Telegram round-trip yet. Wiring this up
                  // means listening for the `managed_bot` update and polling
                  // here until it arrives.
                  e.preventDefault();
                  setBotCreated(true);
                }}
                style={{
                  display: 'block',
                  ...S.mono,
                  fontSize: 12.5,
                  padding: '12px 14px',
                  border: '1px solid var(--input-border)',
                  borderRadius: 8,
                  background: 'var(--surface-alt)',
                  wordBreak: 'break-all',
                }}
              >
                t.me/newbot/TradesDatabaseSetupBot/{suggestedBot}
              </a>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                {botCreated ? (
                  <>
                    <Dot />
                    <span style={{ color: 'var(--ink-2)' }}>
                      Bot created · resolves to{' '}
                      <span style={{ ...S.mono, color: 'var(--ink)' }}>@{suggestedBot}</span>
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        border: '2px solid var(--line)',
                        borderTopColor: 'var(--amber)',
                        borderRadius: '50%',
                        animation: 'tdspin 0.8s linear infinite',
                        flex: 'none',
                      }}
                    />
                    <span style={{ color: 'var(--ink-4)' }}>Waiting for Telegram…</span>
                  </>
                )}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
                <span style={{ color: 'var(--ink-4)' }}>
                  Host <span style={{ ...S.mono, color: 'var(--ink)' }}>{ACCOUNT.host}</span>
                </span>
                <span style={{ color: 'var(--ink-4)' }}>
                  Region <span style={{ ...S.mono, color: 'var(--ink)' }}>{ACCOUNT.region}</span>
                </span>
              </div>

              <div style={{ border: '1px solid var(--line)', borderRadius: 9, padding: 14 }}>
                <p style={{ margin: '0 0 10px', ...S.colHead }}>What happens on confirm</p>
                {[
                  'claim the next free sandbox from the pool on td-prod-1',
                  'write the bot token to the sandbox secret store',
                  'register webhook /hook/s_9c04e2',
                  'allowlist the Telegram ID the bot was created by',
                  `add a ${TIER_LABEL[tier].toLowerCase()} seat to the invoice, prorated ${DAYS_LEFT} days`,
                ].map((line, i) => (
                  <p
                    key={line}
                    style={{ margin: 0, ...S.mono, fontSize: 11.5, lineHeight: 1.9, color: 'var(--ink-3)' }}
                  >
                    {i + 1} · {line}
                  </p>
                ))}
              </div>

              <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)' }}>
                Adds {money(proratedCents)} to this month’s invoice, then {moneyShort(unit)}/mo.
              </p>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-5)' }}>
                The seat is only added once payment clears. Setup runs on its own and usually
                finishes within ten minutes.
              </p>
            </>
          )}
        </div>

        <footer
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '16px 24px',
            borderTop: '1px solid var(--line)',
            background: 'var(--surface-alt)',
          }}
        >
          <Button variant="outline" onClick={() => (step === 1 ? onClose() : setStep((s) => s - 1))}>
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>
          <Button variant="primary" onClick={next} disabled={!canContinue}>
            {step === 3 ? 'Confirm & provision' : 'Continue'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
