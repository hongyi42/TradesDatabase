import { useState } from 'react';
import { Button, Field, Logo, inputStyle } from '../components/ui.js';
import * as api from '../data/api.js';

// Magic link only.
//
// The handoff drew email + password with a magic link underneath, and the
// earlier prototype swapped the order but kept a password field. That field is
// now GONE rather than reordered: there is no password authentication in the
// system (plan D1 rejected it — a password is credential custody this system
// does not otherwise have), so a "Use a password" control could only ever fake a
// sign-in. A control that cannot do what it says is worse than no control.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (D1, Phase 3).

export function SignIn({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || state === 'sending') return;
    setState('sending');
    try {
      await api.requestSignInLink(email.trim());
      setState('sent');
    } catch (err) {
      // 503 is the only failure the customer can see, and it is ours, not
      // theirs: sign-in mail is not configured. Everything else the server
      // deliberately answers 204 to.
      setError(
        err instanceof api.ApiError && err.status === 503
          ? 'Sign-in email is not available right now. Please contact us and we’ll sort it out.'
          : 'Something went wrong. Please try again.',
      );
      setState('error');
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: '100vh' }}>
      {/* Explicit `surface` background, not inherited: the theme note warns that
          without it this column falls onto the dark shell while keeping
          light-theme text. */}
      <div
        style={{
          background: 'var(--surface)',
          color: 'var(--ink)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '48px clamp(48px, 8vw, 120px)',
        }}
      >
        <div style={{ marginBottom: 44 }}>
          <Logo />
        </div>

        {state === 'sent' ? (
          // The confirmation NEVER says whether that address has an account —
          // the server answers identically either way on purpose, and a message
          // like "no such account" here would hand back the enumeration oracle
          // the API is careful not to give.
          <div role="status" style={{ maxWidth: 420 }}>
            <h2
              style={{
                margin: 0,
                fontFamily: 'var(--display)',
                fontSize: 32,
                fontWeight: 800,
                letterSpacing: '-0.03em',
              }}
            >
              Check your email
            </h2>
            <p style={{ margin: '10px 0 0', fontSize: 15, color: 'var(--ink-2)' }}>
              If <strong>{email.trim()}</strong> has an account, a sign-in link is on its way. It
              works once and expires shortly.
            </p>
            <Button
              variant="outline"
              onClick={() => setState('idle')}
              style={{ marginTop: 24, padding: '13px 24px', borderRadius: 8, fontSize: 15 }}
            >
              Use a different email
            </Button>
          </div>
        ) : (
          <>
            <h2
              style={{
                margin: 0,
                fontFamily: 'var(--display)',
                fontSize: 32,
                fontWeight: 800,
                letterSpacing: '-0.03em',
              }}
            >
              Sign in
            </h2>
            <p style={{ margin: '10px 0 0', fontSize: 15, color: 'var(--ink-2)', maxWidth: 420 }}>
              Account owners and billing admins only. Field staff use the bot.
            </p>

            <form
              style={{ maxWidth: 420, marginTop: 30, display: 'flex', flexDirection: 'column', gap: 16 }}
              onSubmit={(e) => void submit(e)}
            >
              <Field label="Work email">
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.co.uk"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                />
              </Field>

              {state === 'error' && (
                <p role="alert" style={{ margin: 0, fontSize: 13.5, color: 'var(--danger)' }}>
                  {error}
                </p>
              )}

              <Button
                variant="primary"
                type="submit"
                disabled={state === 'sending'}
                style={{ padding: '13px 24px', borderRadius: 8, fontSize: 15, width: '100%' }}
              >
                {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
              </Button>
            </form>

            <p style={{ margin: '26px 0 0', fontSize: 13, color: 'var(--ink-4)' }}>
              No account?{' '}
              <button
                type="button"
                onClick={onBack}
                style={{
                  border: 0,
                  background: 'transparent',
                  padding: 0,
                  color: 'var(--amber-deep)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontFamily: 'var(--sans)',
                  textDecoration: 'underline',
                }}
              >
                Ask us for a walkthrough
              </button>
              {' '}— we set firms up one at a time.
            </p>
          </>
        )}
      </div>

      {/* Pull-quote panel moves from `ink` to `shell-sidebar` so the two-column
          split still reads against the shell. */}
      <div
        style={{
          background: 'var(--shell-sidebar)',
          color: 'var(--shell-ink)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: 'clamp(48px, 6vw, 88px)',
        }}
      >
        <p style={{ margin: 0, fontSize: 24, lineHeight: 1.45, maxWidth: '20em' }}>
          “The lads were already texting me what they’d done. Now it just lands in the record and I
          stop chasing paperwork on a Sunday.”
        </p>
        <p
          style={{
            margin: '28px 0 0',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'oklch(0.7 0.01 250)',
          }}
        >
          Ray Harrow · Harrow Brothers Electrical · 8 seats
        </p>
      </div>
    </div>
  );
}
