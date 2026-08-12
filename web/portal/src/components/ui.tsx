import type { CSSProperties, ReactNode } from 'react';

// Shared primitives. Styles are inline objects rather than CSS modules to keep
// the handoff's exact px values readable next to the markup they apply to —
// the design is specified as a table of literal sizes, and indirection through
// class names would make divergence from it harder to spot in review.

export const S = {
  // Slate shell: cards stay white, but their OUTER border becomes shell-line so
  // they read against the dark frame, and shadows are dropped entirely — a
  // shadow under a white card on a dark ground is invisible, and the theme note
  // says to drop them rather than try to tune them.
  card: {
    background: 'var(--surface)',
    // MUST reset colour. `body` now carries shell-ink (near-white) for the dark
    // frame, so any text inside a white card that doesn't set its own colour
    // inherits white-on-white. Resetting here means every container "keeps the
    // light tokens it already uses inside", which is what the theme asks for,
    // without touching a single child.
    color: 'var(--ink)',
    border: '1px solid var(--shell-line)',
    borderRadius: 'var(--r-card)',
  } as CSSProperties,
  mono: { fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' } as CSSProperties,
  // Headings and sub-lines sit directly on the shell, so they take shell ink.
  // Display face, not the UI face. Everything used to be Inter Tight 600,
  // which is what flattened the whole app -- see the type note in tokens.css.
  h1: {
    margin: 0,
    fontFamily: 'var(--display)',
    fontSize: 27,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    color: 'var(--shell-ink)',
  } as CSSProperties,
  sub: { margin: '6px 0 0', fontSize: 14, color: 'var(--shell-ink-2)' } as CSSProperties,
  // Column headers live INSIDE white cards — unchanged light tokens.
  colHead: {
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: 'var(--ink-4)',
  } as CSSProperties,
  label: { fontSize: 12, color: 'var(--ink-4)' } as CSSProperties,
  /** Body copy that sits on the shell rather than inside a card. */
  onShell: { color: 'var(--shell-ink-2)' } as CSSProperties,
};

export function Logo({ size = 26, label = true }: { size?: number; label?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.19,
          background: 'var(--amber)',
          flex: 'none',
        }}
      />
      {label && (
        <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: '-0.01em' }}>
          TradesDatabase
        </span>
      )}
    </div>
  );
}

type PillTone = 'teal' | 'amber' | 'muted' | 'danger';

const PILL_TONES: Record<PillTone, CSSProperties> = {
  teal: { background: 'var(--teal-bg)', color: 'var(--teal-fg)', fontWeight: 500 },
  // Solid amber, per the handoff: provisioning is "attention required".
  amber: { background: 'var(--amber)', color: 'var(--amber-on)', fontWeight: 600 },
  muted: { background: 'var(--suspended-bg)', color: 'var(--ink-3)', fontWeight: 500 },
  danger: { background: 'var(--suspended-bg)', color: 'var(--danger)', fontWeight: 500 },
};

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 8px',
        borderRadius: 'var(--r-pill)',
        fontSize: 11.5,
        whiteSpace: 'nowrap',
        ...PILL_TONES[tone],
      }}
    >
      {children}
    </span>
  );
}

type ButtonVariant =
  | 'primary'
  | 'outline'
  | 'dark'
  | 'danger'
  | 'dashed'
  | 'ghost'
  // Variants for controls that sit ON the dark shell rather than inside a white
  // card: transparent fill, shell-line border, shell ink label. Buttons inside
  // cards keep the light variants above and do not change.
  | 'shell-outline'
  | 'shell-danger';

const BUTTON_VARIANTS: Record<ButtonVariant, CSSProperties> = {
  primary: { background: 'var(--amber)', color: 'var(--amber-on)', border: 0, fontWeight: 500 },
  outline: {
    background: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--input-border)',
    fontWeight: 500,
  },
  dark: { background: 'var(--ink)', color: 'var(--surface)', border: 0, fontWeight: 500 },
  danger: {
    background: 'var(--surface)',
    color: 'var(--danger)',
    border: '1px solid var(--danger-line)',
    fontWeight: 500,
  },
  'shell-outline': {
    background: 'transparent',
    color: 'var(--shell-ink)',
    border: '1px solid var(--shell-line)',
    fontWeight: 500,
  },
  'shell-danger': {
    background: 'transparent',
    color: 'var(--danger-on-shell)',
    border: '1px solid var(--shell-line)',
    fontWeight: 500,
  },
  dashed: {
    background: 'transparent',
    color: 'var(--ink-3)',
    border: '1px dashed var(--input-border)',
    fontWeight: 500,
  },
  ghost: { background: 'none', color: 'var(--ink-2)', border: 0, fontWeight: 500 },
};

export function Button({
  variant = 'outline',
  onClick,
  children,
  style,
  disabled,
  title,
  type = 'button',
}: {
  variant?: ButtonVariant;
  onClick?: () => void;
  children: ReactNode;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '9px 16px',
        borderRadius: 'var(--r-btn)',
        fontSize: 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...BUTTON_VARIANTS[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/**
 * Small mono outlined button — "Export CSV" and friends. These sit on the dark
 * shell (next to a section heading), so they take the shell treatment.
 */
export function MonoButton({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        padding: '6px 11px',
        borderRadius: 'var(--r-btn-sm)',
        border: '1px solid var(--shell-line)',
        background: 'transparent',
        color: 'var(--shell-ink)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  helper,
}: {
  label: string;
  children: ReactNode;
  helper?: ReactNode;
}) {
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--ink)' }}
      >
        {label}
      </span>
      {children}
      {helper && (
        <span style={{ display: 'block', marginTop: 6, fontSize: 12, lineHeight: 1.55, color: 'var(--ink-5)' }}>
          {helper}
        </span>
      )}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 'var(--r-input)',
  border: '1px solid var(--input-border)',
  background: 'var(--surface)',
  color: 'var(--ink)',
  fontSize: 15,
};

export const selectStyle: CSSProperties = {
  ...inputStyle,
  padding: '11px 12px',
  fontSize: 14,
};

/** Teal dot — healthy / settled. Never amber; amber means attention required. */
export function Dot({ tone = 'teal' }: { tone?: 'teal' | 'amber' | 'danger' }) {
  const color = tone === 'teal' ? 'var(--teal)' : tone === 'amber' ? 'var(--amber)' : 'var(--danger)';
  return (
    <span
      style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flex: 'none' }}
    />
  );
}

export function SectionHeading({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        margin: '30px 0 12px',
      }}
    >
      <h2 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em', color: 'var(--shell-ink)' }}>{title}</h2>
      {right}
    </div>
  );
}
