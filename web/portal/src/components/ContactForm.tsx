import { useState } from 'react';

// "Get in touch" — the landing's only real conversion surface.
//
// Onboarding is by hand, one firm at a time, so this form matters more than a
// self-serve signup would. There is no signup flow to add: the product is
// invite-only, we create the tenant.
//
// Nothing is submitted anywhere yet. When this is wired, note that it is the
// first UNAUTHENTICATED write surface on the whole domain, which makes it the
// obvious spam and abuse target: it needs a rate limit, a bot check that is
// not a CAPTCHA if we can avoid one, and server-side validation. It also
// collects a name, email and phone number — personal data — so it needs a
// retention answer before it is switched on, not after.

// Verbatim from the handoff, in this order. Controlled rather than a bare
// `selected` attribute, which React drops.
const TEAM_SIZES = ['Just me', '2–3 people', '4–10 people', '11–20 people', 'More than 20'];

export function ContactForm() {
  const [sent, setSent] = useState(false);
  const [teamSize, setTeamSize] = useState(TEAM_SIZES[2]);

  // The confirmation replaces the card in place — the handoff rules out a modal.
  if (sent) {
    return (
      <div className="ld-form" role="status" style={{ justifyContent: 'center', minHeight: 220 }}>
        <p
          style={{
            margin: 0,
            fontFamily: 'var(--display)',
            fontWeight: 300,
            fontSize: 23,
            letterSpacing: '-0.01em',
          }}
        >
          Got it — we&rsquo;ll come back to you today.
        </p>
        <button type="button" className="ld-btn ld-btn-outline" style={{ alignSelf: 'flex-start' }} onClick={() => setSent(false)}>
          Send another
        </button>
      </div>
    );
  }

  return (
    <form
      className="ld-form"
      onSubmit={(e) => {
        e.preventDefault();
        // Prototype only — no network call. See the note at the top of the file.
        setSent(true);
      }}
    >
      <div className="ld-field-pair">
        <label className="ld-field ld-field-half">
          <span className="ld-field-label">Your name</span>
          <input className="ld-input" required name="name" autoComplete="name" />
        </label>
        <label className="ld-field ld-field-half">
          <span className="ld-field-label">Business</span>
          <input
            className="ld-input"
            required
            name="company"
            autoComplete="organization"
          />
        </label>
      </div>

      <div className="ld-field-pair">
        <label className="ld-field ld-field-half">
          <span className="ld-field-label">Email</span>
          <input
            className="ld-input"
            required
            type="email"
            name="email"
            autoComplete="email"
          />
        </label>
        <label className="ld-field ld-field-half">
          <span className="ld-field-label">Phone (optional)</span>
          <input className="ld-input" type="tel" name="phone" autoComplete="tel" />
        </label>
      </div>

      <div className="ld-field">
        <label className="ld-field-label" htmlFor="team-size">
          How many in the field
        </label>
        <select
          className="ld-select"
          id="team-size"
          name="teamSize"
          value={teamSize}
          onChange={(e) => setTeamSize(e.target.value)}
        >
          {TEAM_SIZES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>

      <label className="ld-field">
        <span className="ld-field-label">What&rsquo;s driving you mad</span>
        <textarea
          className="ld-textarea"
          name="message"
          rows={3}
          placeholder="Chasing job sheets, reports going missing…"
        />
      </label>

      <button type="submit" className="ld-btn ld-btn-primary" style={{ alignSelf: 'flex-start' }}>
        Ask us to get in touch
      </button>
    </form>
  );
}
