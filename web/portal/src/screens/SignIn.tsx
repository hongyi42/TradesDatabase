import { useState } from 'react';
import { Button, Field, Logo, inputStyle } from '../components/ui.js';

// The handoff draws email + password with a magic link underneath. The order is
// swapped here: magic link is the primary path and password is the fallback,
// because a password field is credential custody we do not otherwise have
// anywhere in this system. Both still lead to Billing.
export function SignIn({ onContinue }: { onContinue: () => void }) {
  const [showPassword, setShowPassword] = useState(false);

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

        <h2 style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em' }}>Sign in</h2>
        <p style={{ margin: '10px 0 0', fontSize: 15, color: 'var(--ink-2)', maxWidth: 420 }}>
          Account owners and billing admins only. Field staff use the bot.
        </p>

        <form
          style={{ maxWidth: 420, marginTop: 30, display: 'flex', flexDirection: 'column', gap: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            onContinue();
          }}
        >
          <Field label="Work email">
            <input type="email" autoComplete="email" placeholder="you@company.co.uk" style={inputStyle} />
          </Field>

          {showPassword && (
            <Field label="Password">
              <input type="password" autoComplete="current-password" style={inputStyle} />
            </Field>
          )}

          <Button
            variant="primary"
            type="submit"
            style={{ padding: '13px 24px', borderRadius: 8, fontSize: 15, width: '100%' }}
          >
            {showPassword ? 'Continue' : 'Email me a sign-in link'}
          </Button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            <span style={{ fontSize: 12, color: 'var(--ink-5)' }}>or</span>
            <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          </div>

          <Button
            variant="outline"
            onClick={() => (showPassword ? onContinue() : setShowPassword(true))}
            style={{ padding: '13px 24px', borderRadius: 8, fontSize: 15, width: '100%' }}
          >
            {showPassword ? 'Send me a magic link instead' : 'Use a password'}
          </Button>
        </form>

        <p style={{ margin: '26px 0 0', fontSize: 13, color: 'var(--ink-4)' }}>
          Locked out? <a href="#help">Contact your account owner</a>
        </p>
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
