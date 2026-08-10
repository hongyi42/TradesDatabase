import { Button, Logo } from '../components/ui.js';
import { PRICE_CENTS, moneyShort } from '../data/model.js';

// Step copy is load-bearing — the handoff calls it "the clearest explanation of
// the provisioning model anywhere in the design". Step 1 is the one place it
// had to change: the design predates Telegram's Managed Bots (Bot API 9.6), so
// it told customers to paste a BotFather token. They now tap a link and
// Telegram makes the bot; we fetch the token by API and nobody handles a
// credential. Steps 2 and 3 keep the original wording.
const STEPS = [
  {
    n: '01',
    h: 'Add a seat',
    p: 'Tap one link and Telegram creates the bot for you. No tokens to copy, no BotFather, nothing to paste.',
  },
  {
    n: '02',
    h: 'We provision the sandbox',
    p: 'An isolated container spins up on our Lightsail host and binds to that bot. Typically under ten minutes.',
  },
  {
    n: '03',
    h: 'Billing follows the seat',
    p: 'Add or delete seats mid-cycle and the next invoice is prorated to the day. No support ticket.',
  },
];

const MOCK_ROWS = [
  { name: 'Ray Harrow', bot: '@harrow_ray_bot', trade: 'Electrician' },
  { name: 'Pete Rowan', bot: '@harrow_pr_bot', trade: 'Plumber' },
  { name: 'Dev Singh', bot: '@harrow_dev_bot', trade: 'HVAC' },
  { name: 'Marnie Boyd', bot: '@harrow_marnie_bot', trade: 'Roofer' },
];

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div style={{ flex: 1 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '22px 56px',
          borderBottom: '1px solid var(--shell-line)',
          background: 'var(--shell-sidebar)',
        }}
      >
        <Logo />
        <nav className="on-shell" style={{ display: 'flex', alignItems: 'center', gap: 30, fontSize: 14, color: 'var(--shell-ink-2)' }}>
          <a href="#product">Product</a>
          <a href="#pricing">Pricing</a>
          <a href="#docs">Docs</a>
          <Button variant="shell-outline" onClick={onSignIn} style={{ padding: '9px 18px', borderRadius: 'var(--r-nav)' }}>
            Sign in
          </Button>
        </nav>
      </header>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: '1.05fr 0.95fr',
          gap: 64,
          alignItems: 'center',
          padding: '88px 56px 76px',
          maxWidth: 1360,
          margin: '0 auto',
        }}
      >
        <div>
          <div
            style={{
              display: 'inline-block',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              color: 'var(--amber-deep)',
              border: '1px solid var(--amber-tint-line)',
              background: 'var(--amber-tint-bg)',
              padding: '5px 10px',
              borderRadius: 5,
            }}
          >
            Telegram-native
          </div>
          <h1
            style={{
              margin: '22px 0 0',
              fontSize: 56,
              lineHeight: 1.03,
              letterSpacing: '-0.03em',
              fontWeight: 600,
              textWrap: 'balance',
              color: 'var(--shell-ink)',
            }}
          >
            One database for every trade on your books.
          </h1>
          <p
            style={{
              margin: '22px 0 0',
              fontSize: 18,
              lineHeight: 1.6,
              color: 'var(--shell-ink-2)',
              maxWidth: '30em',
              textWrap: 'pretty',
            }}
          >
            Your team logs jobs, certs and callouts through a Telegram bot. You get a clean,
            searchable record — one seat per person, provisioned without a support ticket.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 32 }}>
            <Button
              variant="primary"
              onClick={onSignIn}
              style={{ padding: '13px 24px', borderRadius: 8, fontSize: 15 }}
            >
              Sign in to your account
            </Button>
            <Button variant="shell-outline" style={{ padding: '13px 24px', borderRadius: 8, fontSize: 15 }}>
              Book a walkthrough
            </Button>
          </div>
          {/* Two tiers, never blended into one per-seat number. */}
          <p style={{ margin: '20px 0 0', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--shell-ink-2)' }}>
            {moneyShort(PRICE_CENTS.manager)} per manager seat · {moneyShort(PRICE_CENTS.technician)} per
            technician seat, per month · cancel a seat any time, billed prorated
          </p>
        </div>

        {/* Fake browser window — a product glimpse, not a real screenshot. */}
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--surface)',
            color: 'var(--ink)',
            boxShadow: 'var(--shadow-mock)',
          }}
          aria-hidden="true"
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '11px 14px',
              borderBottom: '1px solid var(--line)',
              background: 'var(--surface-alt)',
            }}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--input-border)' }}
              />
            ))}
            <span
              style={{
                marginLeft: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink-4)',
              }}
            >
              app.tradesdatabase.io/seats
            </span>
          </div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {MOCK_ROWS.map((r) => (
              <div key={r.bot} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--teal)', flex: 'none' }} />
                <span style={{ fontSize: 14, fontWeight: 500, minWidth: 110 }}>{r.name}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)', flex: 1 }}>
                  {r.bot}
                </span>
                <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>{r.trade}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="product"
        style={{
          borderTop: '1px solid var(--shell-line)',
          background: 'var(--shell-sidebar)',
          padding: '64px 56px',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 40,
            maxWidth: 1360,
            margin: '0 auto',
          }}
        >
          {STEPS.map((s) => (
            <div key={s.n}>
              <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--amber-on-shell)' }}>
                {s.n}
              </p>
              <h3 style={{ margin: '12px 0 0', fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--shell-ink)' }}>
                {s.h}
              </h3>
              <p style={{ margin: '9px 0 0', fontSize: 15, lineHeight: 1.6, color: 'var(--shell-ink-2)', textWrap: 'pretty' }}>
                {s.p}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer
        className="on-shell"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '28px 56px',
          borderTop: '1px solid var(--shell-line)',
          fontSize: 13,
          color: 'var(--shell-ink-2)',
        }}
      >
        <span>© 2026 TradesDatabase</span>
        <span style={{ display: 'flex', gap: 22 }}>
          <a href="#status">Status</a>
          <a href="#terms">Terms</a>
          <a href="#privacy">Privacy</a>
        </span>
      </footer>
    </div>
  );
}
