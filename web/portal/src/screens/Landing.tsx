import { useEffect, useRef, useState } from 'react';
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
// Photographs are picked up from `web/portal/src/photos/` BY FILENAME. There is
// no code change to make: drop a file named for the slot and it appears; remove
// it and the slot goes back to its honest "photo to shoot" plate.
//
//   photo-band.jpg   the wide band under the hero, behind the trades strip
//   strip-1.jpg      truck doors, first light
//   strip-2.jpg      hands, scuffed phone, finished panel
//   strip-3.jpg      kitchen table, 9pm, paperwork
//
// .jpg .jpeg .png .webp and .avif all work. No subdirectories — the portal build
// is deliberately FLAT because src/portal/portalApi.ts rejects any filename
// containing a path separator, and Vite is what keeps the emitted name flat and
// content-hashed.
//
// The ALT TEXT lives in this file, not in the filename, because it describes
// what is IN the photograph for someone who cannot see it — which the filename
// cannot know. Each slot below carries alt written for the shot its brief
// describes. **If the photograph you drop in differs from the brief, change the
// alt to match it**, or the page will describe an image that isn't there.
//
// LICENSING: this is a commercial page. Only photographs we shot, or images
// under a licence permitting commercial use without attribution (Unsplash and
// Pexels both qualify). An image found through a search engine is not licensed.
//
// WHAT WORKS: unposed, doing the actual work, dirty hands, real light, faces
// incidental or absent — and AMERICAN. A European DIN-rail consumer unit reads
// wrong to a US contractor exactly the way "EICR" did before 2026-08-20; the
// market is US and every concrete detail has to say "this is for me".
//
// Vite resolves this glob at build time, so a missing file is not an error —
// the slot simply stays empty, which is a designed state (DESIGN.md §6).
const PHOTO_FILES = import.meta.glob('../photos/*.{jpg,jpeg,png,webp,avif}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** Slot name (the filename without its extension) -> resolved asset URL. */
const PHOTOS: Record<string, string> = Object.fromEntries(
  Object.entries(PHOTO_FILES).map(([path, url]) => [
    path.split('/').pop()!.replace(/\.[^.]+$/, ''),
    url,
  ]),
);

// The three photographs in the strip. `slot` is the filename to drop in
// src/photos/; `alt` describes the intended shot and must be updated if the
// photograph you use differs from the brief.
const STRIP = [
  {
    slot: 'strip-1',
    brief: 'Truck doors open, first light',
    alt: 'A work van with its rear doors open at dawn, tools racked inside.',
  },
  {
    slot: 'strip-2',
    brief: 'Hands, scuffed phone, finished panel',
    alt: "A technician's hands holding a worn phone in front of a finished electrical panel.",
  },
  {
    slot: 'strip-3',
    brief: 'Kitchen table, 9pm, paperwork',
    alt: 'Job paperwork spread across a kitchen table under a lamp at night.',
  },
];

/** An image slot, resolved by name from src/photos/ (see the PHOTOGRAPHS note
 *  above). Drop `<slot>.jpg` in that directory and this renders the photograph;
 *  with no such file it renders the honest unfinished plate carrying the brief
 *  for the shot it is holding.
 *
 *  DESIGN.md §6 rules out stock photography as an interim — this audience spots
 *  a smiling man in clean hi-vis instantly and it costs trust — so an empty
 *  plate is a deliberate state, not a missing asset.
 *
 *  The empty plate is aria-hidden: a screen-reader user has no use for a
 *  production note, and it previously announced all five shot briefs as content
 *  (2026-08-22 critique, C3). A filled plate carries its `alt` instead. */
function PhotoPlate({
  slot,
  brief,
  alt,
  className,
}: {
  slot: string;
  brief: string;
  alt: string;
  className?: string;
}) {
  const src = PHOTOS[slot];
  const cls = className ? `ld-plate ${className}` : 'ld-plate';

  if (src) {
    return (
      <div className={`${cls} ld-plate-shot`}>
        <img className="ld-plate-img" src={src} alt={alt} loading="lazy" decoding="async" />
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

/** Plays the proof band's fill sequence once, the first time it scrolls into
 *  view. Returns a ref for the band and the class names to put on it.
 *
 *  Reduced motion is handled by NOT ARMING at all rather than by animating
 *  faster: a reader who asked for less motion gets the finished band on first
 *  paint, with no transitions attached to sit through. The CSS carries a
 *  matching guard so the two cannot drift apart.
 *
 *  The observer disconnects after firing — this is a one-shot demonstration,
 *  not something that should replay every time the reader scrolls back up. */
function useFillOnce() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [armed] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const el = ref.current;
    // IntersectionObserver is everywhere we support, but a missing implementation
    // must not leave the band invisible — show it rather than hide it.
    if (!el || typeof IntersectionObserver === 'undefined') {
      setPlaying(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPlaying(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [armed]);

  const className = [
    'ld-proof',
    armed ? 'ld-proof-armed' : '',
    armed && playing ? 'is-playing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return { ref, className };
}

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  const proof = useFillOnce();

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
            {/* Sign in is for people who already bought; it is not a conversion
                path and it should not be the only button in the nav. Below 520px
                the three anchors above are display:none, so before this the ONLY
                thing a prospect on a phone could press was a door they have no
                key to. Text link now — still reachable, no longer competing. */}
            <button type="button" className="ld-nav-signin" onClick={onSignIn}>
              Sign in
            </button>
            {/* The persistent CTA. The page previously offered no way to act
                between the hero and the footer form — roughly 3,000px of scroll
                on desktop and five screens on a phone — which was the 2026-08-22
                critique's P0. It survives the 520px breakpoint deliberately. */}
            <a className="ld-btn-sm ld-btn-sm-primary" href="#contact">
              Book a walkthrough
            </a>
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

      {/* ── Photo band ───────────────────────────────────────────────────────
          The band is only tall when there is a photograph to be tall FOR. With
          the slot empty it collapses to the trades strip alone — a slim, solid
          qualification band that looks decided, instead of ~460px of hatch
          announcing an unfinished page. Drop photo-band.jpg into src/photos/
          and it expands back to the full bleed with the strip over the scrim;
          no code change, see the PHOTOGRAPHS note above. */}
      <section className={PHOTOS['photo-band'] ? 'ld-photoband' : 'ld-photoband ld-photoband-slim'}>
        <PhotoPlate
          slot="photo-band"
          brief="Electrician mid-job, phone in hand, open breaker panel behind"
          alt="An electrician working at an open breaker panel, phone in hand."
        />
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

          <div className={proof.className} ref={proof.ref}>
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

              <div className="ld-bubble-tech ld-seq ld-seq-msg">
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

              <div
                className="ld-bubble-tech ld-seq ld-seq-file"
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px' }}
              >
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

              <div className="ld-bubble-bot ld-seq ld-seq-bot">
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

            <div className="ld-arrow ld-seq ld-seq-arrow" aria-hidden="true">
              &rarr;
            </div>

            {/* Job sheet — the page's only shadow */}
            <div className="ld-sheet">
              <div className="ld-sheet-head">
                <span>Job sheet</span>
                <span>JOB-4471</span>
              </div>
              <div style={{ padding: '4px 18px 16px' }}>
                <div className="ld-row ld-seq ld-seq-row">
                  <span className="ld-row-label">Customer</span>
                  <span className="ld-row-value">M. Okonjo · 1420 Birch St, Aurora CO</span>
                </div>
                <div className="ld-row ld-seq ld-seq-row">
                  <span className="ld-row-label">Work</span>
                  <span className="ld-row-value">Breaker panel replacement</span>
                </div>
                <div className="ld-row ld-seq ld-seq-row">
                  <span className="ld-row-label">Visit</span>
                  <span className="ld-row-value">Aug 6 · Pete Rowan</span>
                </div>
                <div className="ld-row ld-seq ld-seq-row">
                  <span className="ld-row-label">Attached</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>Inspection_1420Birch.pdf</span>
                </div>
                {/* The evidence link back to L1 — the product's core claim.
                    Every structured field can show the message it came from.
                    Keep this block. */}
                <div className="ld-source ld-seq ld-seq-source">
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
        {STRIP.map((p) => (
          <PhotoPlate key={p.slot} slot={p.slot} brief={p.brief} alt={p.alt} />
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
