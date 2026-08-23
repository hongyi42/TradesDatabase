import { useState } from 'react';
import { VideoPlaceholder } from '../components/VideoPlaceholder.js';
import { ContactForm } from '../components/ContactForm.js';
import { PRICE_CENTS, CURRENCY } from '../data/model.js';
import './landing.css';

// Marketing landing — implements root DESIGN.md (IBM Carbon, adapted).
//
// THIS HEADER USED TO DESCRIBE A DARK SHELL WITH WARM-PAPER BANDS. That system
// was retired on 2026-08-21 (e276d11) and docs/design/handoff-landing-v2/ is
// marked HISTORICAL. Carbon is the system now: white canvas, charcoal type, one
// blue accent, 0-4px corners, no shadows, display type at weight 300 — and the
// authority is /DESIGN.md, not the old handoff.
//
// The organising idea is ONE RECORD, SHOWN EARLY. The proof — a text arriving
// and becoming a job sheet whose every field cites the message it came from —
// runs directly under the hero as a grey record band. It is the one thing here
// that could not sit on a competitor's page, and it leads for that reason. The
// bands alternate --canvas and --surface-1 from there (DESIGN.md §4); that
// alternation is load-bearing, so do not flatten it to one background.
//
// Do not bold display type. Weight 300 is the Carbon signature and the page
// previously ran two type systems at once because half the mid-size headings
// were left at 600 — see DESIGN.md §3 and the 2026-08-22 critique (B1).
//
// Tokens are declared on `.landing` in landing.css and shadow the app's
// same-named tokens for this subtree only — see the comment at the top of that
// file. The signed-in app keeps its own system and is untouched by this page.

// Both tiers are read off the app's own constants so the landing cannot drift
// from what Billing charges. They are NEVER averaged into one per-seat figure:
// two tiers are two products, and the only combined number on the page is the
// calculator's total, which adds them as separate line items.
const MANAGER_PRICE = PRICE_CENTS.manager / 100;
const TECHNICIAN_PRICE = PRICE_CENTS.technician / 100;

// The v2 handoff priced in £ for a UK audience. The target market is the US
// (owner decision 2026-08-20), so the page is dollars throughout AND every
// worked example on it is American — address, trade vocabulary, paperwork,
// phone format. A US electrician does not recognise "EICR" or "consumer unit",
// and a page whose only concrete details are foreign fails the one job the
// examples have: making the reader think "this is for me".
// Currency stays single-sourced: `CURRENCY` in data/model.ts.
const money = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: CURRENCY,
    maximumFractionDigits: 0,
  }).format(n);

const TRADES = ['Electrical', 'Plumbing', 'Roofing', 'HVAC', 'Appliance repair'];

const QUOTES = [
  { quote: '“It’s all in the group chat somewhere.”', who: 'Owner · 11 trucks' },
  { quote: '“They won’t use another app.”', who: 'Owner · 6 trucks' },
  { quote: '“What did we do at this address?”', who: 'Office manager' },
  { quote: '“I do the paperwork on Sunday.”', who: 'Owner · 4 trucks' },
];

const CLAIMS = [
  {
    title: 'No new app',
    body: 'It’s the chat they’re already in all day.',
  },
  {
    title: 'Search the address',
    body: 'Every visit, photo and report for it, going back years.',
  },
  {
    // The product's core claim, stated as a CONTRAST. Provenance is the one
    // thing no competitor in this category ships, so the line has to say so
    // out loud; "evidence kept" read as a feature label and landed as nothing.
    // `keystone` gives it the accent rule in the claims grid — exactly one of
    // the five carries it, because marking all five would mark none.
    title: 'Every field shows its source',
    body: 'Tap a line, see the message it came from. Ask your current software to do that.',
    keystone: true,
  },
  {
    // The retiring-technician argument. ~25,000 experienced techs leave the US
    // trades every year and nearly 30% of HVAC techs are over 55 — the single
    // strongest reason this record is worth paying for, and it was missing.
    title: 'It stays when they leave',
    body: 'When your best tech retires, what he knew about your customers stays.',
  },
  {
    title: 'Yours to take',
    body: 'Full export, any time. No exit fee, no hostage data.',
  },
];

// The provisioning story is: one tap → Telegram Managed Bots creates the bot →
// the sandbox builds in about ten minutes. Nothing here may mention pasting a
// BotFather token; that flow has been obsolete since Bot API 9.6.
const STEPS = [
  { when: '10 seconds', title: 'You add the name', note: null },
  { when: 'Automatic', title: 'Their bot is created', note: 'No token to copy.' },
  { when: '~10 minutes', title: 'Sandbox ready', note: 'They reply. That’s the training.' },
];

// ── PHOTOGRAPHS ───────────────────────────────────────────────────────────
//
// Every plate on this page is an empty slot waiting for a real photograph.
// To fill one:
//
//   1. Put the file in `web/portal/src/photos/` (create it; there is no
//      `public/` dir and there must not be a nested `assets/` dir — the build
//      output is deliberately FLAT because src/portal/portalApi.ts rejects any
//      filename containing a path separator. Importing through Vite is what
//      keeps the emitted name flat and content-hashed).
//   2. `import truckDoors from '../photos/truck-doors.jpg';`
//   3. Pass it in: `<PhotoPlate brief="…" src={truckDoors} alt="…" />`
//
// The `alt` is not optional and is not the shot brief — it describes what is in
// the photograph, for someone who cannot see it.
//
// LICENSING: this is a commercial page. Only use photographs we shot, or ones
// under a licence that permits commercial use without attribution (Unsplash and
// Pexels licences both do). Do not paste in an image found through a search
// engine — "it was on the internet" is not a licence.
//
// DESIGN.md §6 rules out STOCK photography specifically: a smiling man in clean
// hi-vis reads as fake to this audience and costs more trust than an empty
// plate buys. If a candidate image looks like an advert, it is the wrong image.
// What works: unposed, dirty, real light, faces incidental or absent.
//
// The three photographs in the strip. None have been shot yet.
const STRIP = [
  'Truck doors open, first light',
  'Hands, scuffed phone, finished panel',
  'Kitchen table, 9pm, paperwork',
];

/** An image slot. Give it a `src` and it renders the photograph; leave `src`
 *  off and it renders the honest unfinished plate carrying the brief for the
 *  shot it is holding.
 *
 *  DESIGN.md §6 rules out stock photography as an interim — this audience spots
 *  a smiling man in a clean hi-vis instantly and it costs trust — so a plate
 *  standing empty is a deliberate state, not a missing asset. When real
 *  photographs exist, import them (see the PHOTOS note below) and pass them in.
 *
 *  `alt` is required alongside `src` and must describe the photograph. The empty
 *  plate is aria-hidden instead: a screen-reader user has no use for a
 *  production note, and it previously announced all five shot briefs as content
 *  (2026-08-22 critique, C3). */
function PhotoPlate({
  brief,
  src,
  alt,
  className,
}: {
  brief: string;
  src?: string;
  alt?: string;
  className?: string;
}) {
  const cls = className ? `ld-plate ${className}` : 'ld-plate';

  if (src) {
    return (
      <div className={`${cls} ld-plate-shot`}>
        <img className="ld-plate-img" src={src} alt={alt ?? ''} loading="lazy" decoding="async" />
      </div>
    );
  }

  return (
    <div className={cls} aria-hidden="true">
      <span className="ld-plate-note">Photo to shoot &middot; {brief}</span>
      <span className="ld-tick ld-tick-tl" aria-hidden="true" />
      <span className="ld-tick ld-tick-br" aria-hidden="true" />
    </div>
  );
}

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  // The only stateful widget on the page.
  const [managers, setManagers] = useState(1);
  const [technicians, setTechnicians] = useState(4);

  const total = managers * MANAGER_PRICE + technicians * TECHNICIAN_PRICE;
  const clamp = (n: number, lo: number) => Math.max(lo, Math.min(60, n));

  return (
    <div className="landing">
      {/* First thing in the tab order. Keyboard and screen-reader users
          otherwise walk the whole nav on every section jump. */}
      <a className="ld-skip" href="#product">
        Skip to content
      </a>
      <header className="ld-header">
        <div className="ld-header-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="ld-mark-td" aria-hidden="true">
              TD
            </span>
            <span className="ld-wordmark">TradesDatabase</span>
          </div>
          {/* Product / Pricing / Contact / Sign in. There is no docs site and
              no docs link — do not add one. */}
          <nav className="ld-nav">
            <a className="ld-nav-link" href="#product">
              Product
            </a>
            <a className="ld-nav-link" href="#pricing">
              Pricing
            </a>
            <a className="ld-nav-link" href="#contact">
              Contact
            </a>
            <button type="button" className="ld-btn-sm" onClick={onSignIn}>
              Sign in
            </button>
          </nav>
        </div>
      </header>

      <main>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="ld-hero">
        <div className="ld-hero-inner">
          <div className="ld-hero-copy">
            <h1 className="ld-h1">
              They already{' '}
              <br />
              text you.{' '}
              <br />
              <span className="ld-h1-turn">Now it&rsquo;s a record.</span>
            </h1>
            <p className="ld-lead">
              One Telegram bot each. They text it like they text you. Nobody installs
              anything, and nobody logs in.
            </p>
            <div className="ld-cta-row">
              <a className="ld-btn ld-btn-primary" href="#contact">
                Book a walkthrough
              </a>
            </div>
          </div>
          <div className="ld-hero-film">
            <VideoPlaceholder
              onSeeHow={() =>
                document.getElementById('product')?.scrollIntoView({ behavior: 'smooth' })
              }
            />
          </div>
        </div>
      </section>

      {/* ── Photo band ───────────────────────────────────────────────────── */}
      <section className="ld-photoband">
        <PhotoPlate brief="Electrician mid-job, phone in hand, open breaker panel behind" />
        <div className="ld-photoband-plate">
          <div className="ld-trades">
            <span>Built for</span>
            {TRADES.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ── The proof ─────────────────────────────────────────────────────
          Promoted from band four on 2026-08-22, and now the third band: the
          hero, then the trades photo band that qualifies the reader, then this.
          It is the one thing on the page that could not sit on a competitor's
          site — a text arriving and becoming a record whose every field cites
          the message it came from — and it was reading below three other bands.
          Keep it above the quotes: the page shows the thing, then explains the
          problem it solves.
          See docs/design/decisions/2026-08-22-landing-critique.md (B3, B4). */}
      <section id="product" className="ld-section ld-surface">
        <div className="ld-wrap">
          <div className="ld-head" style={{ marginBottom: 'clamp(24px, 3vw, 40px)' }}>
            <h2 className="ld-h2">One text in. One record out.</h2>
          </div>

          <div className="ld-proof">
            {/* Chat card */}
            <div className="ld-chat">
              <div className="ld-chat-head">
                <span className="ld-chat-avatar" aria-hidden="true">
                  TD
                </span>
                {/* Mono, because a bot handle is a machine-generated value. */}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--paper-ink-2)' }}>
                  @brandtelectric_pete_bot
                </span>
              </div>

              <div className="ld-bubble-tech">
                <p className="ld-bubble-text">
                  Done at 1420 Birch St. Replaced the breaker panel, tested and signed off. Report
                  attached.
                </p>
                <p
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    color: 'var(--paper-ink-2)',
                    textAlign: 'right',
                    margin: '5px 0 0',
                  }}
                >
                  14:52
                </p>
              </div>

              <div className="ld-bubble-tech" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px' }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 22,
                    height: 22,
                    background: 'var(--card)',
                    border: '1px solid var(--paper-line)',
                    borderRadius: 3,
                    flex: '0 0 auto',
                  }}
                />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>Inspection_1420Birch.pdf</span>
              </div>

              <div className="ld-bubble-bot">
                <p className="ld-bubble-text" style={{ marginBottom: 9 }}>
                  Filed. Birch St, breaker panel.
                </p>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    color: 'var(--on-amber)',
                    background: 'var(--amber)',
                    padding: '3px 7px',
                    borderRadius: 4,
                  }}
                >
                  JOB-4471
                </span>
              </div>
            </div>

            <div className="ld-arrow" aria-hidden="true">
              &rarr;
            </div>

            {/* Job sheet — the page's only shadow */}
            <div className="ld-sheet">
              <div className="ld-sheet-head">
                <span>Job sheet</span>
                <span>JOB-4471</span>
              </div>
              <div style={{ padding: '4px 18px 16px' }}>
                <div className="ld-row">
                  <span className="ld-row-label">Customer</span>
                  <span className="ld-row-value">M. Okonjo · 1420 Birch St, Aurora CO</span>
                </div>
                <div className="ld-row">
                  <span className="ld-row-label">Work</span>
                  <span className="ld-row-value">Breaker panel replacement</span>
                </div>
                <div className="ld-row">
                  <span className="ld-row-label">Visit</span>
                  <span className="ld-row-value">Aug 6 · Pete Rowan</span>
                </div>
                <div className="ld-row">
                  <span className="ld-row-label">Attached</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>Inspection_1420Birch.pdf</span>
                </div>
                {/* The evidence link back to L1 — the product's core claim.
                    Every structured field can show the message it came from.
                    Keep this block. */}
                <div className="ld-source">
                  <p
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      color: 'var(--paper-ink-2)',
                      margin: '0 0 5px',
                    }}
                  >
                    Source · Telegram 14:52
                  </p>
                  <p style={{ fontSize: 14, lineHeight: 1.5, margin: 0 }}>
                    &ldquo;Done at 1420 Birch St&hellip;&rdquo;
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="ld-claims">
            {CLAIMS.map((c) => (
              <div
                key={c.title}
                className={c.keystone ? 'ld-claim ld-claim-keystone' : 'ld-claim'}
              >
                {c.keystone && <p className="ld-claim-mark">The difference</p>}
                <p className="ld-claim-title" style={{ margin: 0 }}>
                  {c.title}
                </p>
                <p className="ld-claim-body">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── What we heard ───────────────────────────────────────────────── */}
      <section className="ld-section ld-paper">
        <div className="ld-wrap">
          <h2 className="ld-h2" style={{ margin: '0 0 clamp(22px, 3vw, 36px)' }}>
            The same four problems, every time
          </h2>
          <div className="ld-grid ld-quotes">
            {QUOTES.map((q) => (
              <div className="ld-quote-cell" key={q.who + q.quote}>
                <p className="ld-quote">{q.quote}</p>
                <p className="ld-attrib" style={{ margin: 0 }}>
                  {q.who}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Photo strip ──────────────────────────────────────────────────── */}
      <section className="ld-strip">
        {STRIP.map((brief) => (
          <PhotoPlate key={brief} brief={brief} />
        ))}
      </section>

      {/* ── Adding someone takes one tap ─────────────────────────────────── */}
      <section className="ld-section ld-dark">
        <div className="ld-wrap">
          <div className="ld-head">
            <h2 className="ld-h2">Adding someone takes one tap</h2>
          </div>
          <div className="ld-grid ld-steps">
            {STEPS.map((s) => (
              <div className="ld-step" key={s.title}>
                <p className="ld-step-when" style={{ margin: '0 0 12px' }}>
                  {s.when}
                </p>
                <p className="ld-step-title" style={{ margin: 0 }}>
                  {s.title}
                </p>
                {s.note && <p className="ld-step-note">{s.note}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Two kinds of seat ────────────────────────────────────────────── */}
      <section id="pricing" className="ld-section ld-paper">
        <div className="ld-wrap">
          <div className="ld-head" style={{ marginBottom: 'clamp(24px, 3vw, 36px)' }}>
            <h2 className="ld-h2">Two kinds of seat</h2>
          </div>

          <div className="ld-seats">
            {/* Technician */}
            <div className="ld-seat ld-seat-tech">
              <h3 className="ld-seat-name">Technician</h3>
              <div className="ld-price-row" style={{ borderTop: '1px solid var(--paper-line-2)' }}>
                <span className="ld-price">{money(TECHNICIAN_PRICE)}</span>
                <span className="ld-per" style={{ color: 'var(--paper-ink-2)' }}>
                  / person / month
                </span>
              </div>
              <div className="ld-seat-items" style={{ color: 'var(--paper-ink-2)' }}>
                {['Own Telegram bot', 'Jobs, reports, photos', 'Sees their own day'].map((i) => (
                  <div key={i}>
                    <span style={{ color: 'var(--paper-ink)' }} aria-hidden="true">
                      &mdash;
                    </span>
                    {i}
                  </div>
                ))}
              </div>
            </div>

            {/* Manager — inverted card */}
            <div className="ld-seat ld-seat-mgr">
              <h3 className="ld-seat-name">Manager</h3>
              {/* Absolutely positioned into the card's top-right corner. It
                  sits AFTER the heading in the DOM on purpose: before it, the
                  detector (rightly) read it as a kicker above the h3. */}
              <span className="ld-seat-tab">At least one</span>
              <div className="ld-price-row" style={{ borderTop: '1px solid var(--invert-line)' }}>
                {/* Amber carries text here only because this card is dark ink,
                    not paper — 9.2:1. Amber text is never put on --paper. */}
                <span className="ld-price" style={{ color: 'var(--amber)' }}>
                  {money(MANAGER_PRICE)}
                </span>
                <span className="ld-per" style={{ color: 'var(--text-2)' }}>
                  / person / month
                </span>
              </div>
              <div className="ld-seat-items" style={{ color: 'var(--text-2)' }}>
                {['Everything opposite', 'Books the crew’s work', 'Dispatch board', 'Adds and drops seats'].map(
                  (i) => (
                    <div key={i}>
                      <span style={{ color: 'var(--teal)' }} aria-hidden="true">
                        &mdash;
                      </span>
                      {i}
                    </div>
                  ),
                )}
              </div>
            </div>

            {/* Calculator — the only place a combined figure appears */}
            <div className="ld-seat ld-calc">
              <p className="ld-seat-label" style={{ color: 'var(--paper-ink-2)', margin: '0 0 14px' }}>
                Your month
              </p>

              <div className="ld-calc-row">
                <span className="ld-calc-name">Managers</span>
                <div className="ld-stepper">
                  <button
                    type="button"
                    className="ld-step-btn"
                    aria-label="One fewer manager"
                    disabled={managers <= 1}
                    onClick={() => setManagers((n) => clamp(n - 1, 1))}
                  >
                    &ndash;
                  </button>
                  <span className="ld-count" aria-live="polite">
                    {managers}
                  </span>
                  <button
                    type="button"
                    className="ld-step-btn"
                    aria-label="One more manager"
                    disabled={managers >= 60}
                    onClick={() => setManagers((n) => clamp(n + 1, 1))}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="ld-calc-row">
                <span className="ld-calc-name">Technicians</span>
                <div className="ld-stepper">
                  <button
                    type="button"
                    className="ld-step-btn"
                    aria-label="One fewer technician"
                    disabled={technicians <= 0}
                    onClick={() => setTechnicians((n) => clamp(n - 1, 0))}
                  >
                    &ndash;
                  </button>
                  <span className="ld-count" aria-live="polite">
                    {technicians}
                  </span>
                  <button
                    type="button"
                    className="ld-step-btn"
                    aria-label="One more technician"
                    disabled={technicians >= 60}
                    onClick={() => setTechnicians((n) => clamp(n + 1, 0))}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="ld-total-row">
                <span
                  className="ld-mark"
                  style={{ color: 'var(--paper-ink-2)', letterSpacing: '0.1em', fontSize: 12 }}
                >
                  Per month
                </span>
                <span className="ld-total">{money(total)}</span>
              </div>
            </div>
          </div>

          <p className="ld-scope">
            We don&rsquo;t do invoicing, estimates or payroll. Keep whatever you use for
            those. This is the record underneath them.
          </p>
          <p className="ld-foot-note">Placeholder pricing. No setup fee, no contract.</p>
        </div>
      </section>

      {/* ── Get in touch ─────────────────────────────────────────────────── */}
      <section id="contact" className="ld-section ld-dark">
        <div className="ld-contact-inner">
          <div className="ld-contact-copy">
            <h2 className="ld-h2-contact">
              Fifteen minutes,
              <br />
              no slide deck.
            </h2>
            <p style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--text-2)', maxWidth: '34ch', margin: 0 }}>
              We set firms up one at a time, by hand. Same business day reply.
            </p>
          </div>
          <ContactForm />
        </div>
      </section>

      </main>

      <footer className="ld-footer">
        <div className="ld-footer-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              aria-hidden="true"
              style={{ width: 20, height: 20, background: 'var(--amber-fill)', flex: '0 0 auto' }}
            />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-3)' }}>
              © 2026 TradesDatabase
            </span>
          </div>
          {/* Status / Terms / Privacy lived here as href="#status" etc. with no
              matching elements — they did nothing when clicked. Removed rather
              than left dead. They MUST return, as real routes, before the
              contact form is wired to anything: it collects a name, email and
              phone, and a privacy link is not optional once that is live. */}
        </div>
      </footer>
    </div>
  );
}
