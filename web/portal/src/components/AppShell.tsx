import type { ReactNode } from 'react';
import { Logo } from './ui.js';
import { ACCOUNT, USER } from '../data/mock.js';
import { money } from '../data/model.js';

export type AppScreen = 'billing' | 'seats' | 'detail' | 'exports' | 'admin';

// "Data & exports" is a fourth nav item the approved design does not have. The
// handoff has no home for export anywhere — Seats and Billing each carry a
// narrow "Export CSV" for their own table, but downloading the customer's
// records and logs is a different job with its own retention and audit rules,
// and burying it under Billing would misfile it as a finance action.
const NAV: Array<{ key: AppScreen; label: string }> = [
  { key: 'billing', label: 'Billing' },
  { key: 'seats', label: 'Seats' },
  { key: 'exports', label: 'Data & exports' },
  { key: 'admin', label: 'Admin queue' },
];

export function AppShell({
  screen,
  onNavigate,
  cycleTotalCents,
  children,
}: {
  screen: AppScreen;
  onNavigate: (s: AppScreen) => void;
  cycleTotalCents: number;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '236px 1fr', minHeight: '100vh' }}>
      <aside
        style={{
          background: 'var(--shell-sidebar)',
          borderRight: '1px solid var(--shell-line)',
          padding: '22px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 26,
        }}
      >
        <div style={{ paddingLeft: 6 }}>
          <Logo size={22} />
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <p
            style={{
              margin: '0 0 6px 6px',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.1em',
              color: 'var(--shell-ink-2)',
            }}
          >
            ACCOUNT
          </p>
          {NAV.map((item) => {
            // "Seats" stays visually active on a seat detail page — the detail
            // screen is a child of Seats, not a peer of it.
            const active = screen === item.key || (item.key === 'seats' && screen === 'detail');
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.key)}
                aria-current={active ? 'page' : undefined}
                style={{
                  textAlign: 'left',
                  padding: '9px 10px',
                  borderRadius: 'var(--r-nav)',
                  border: 0,
                  background: active ? 'var(--shell-nav-selected)' : 'transparent',
                  color: active ? 'var(--shell-ink)' : 'var(--shell-ink-2)',
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div style={{ flex: 1 }} />

        {/* Transparent fill on the shell, not a white card — the sidebar is a
            dark surface and a white block here would fight the nav. */}
        <div
          style={{
            border: '1px solid var(--shell-line)',
            borderRadius: 9,
            padding: '12px 12px 11px',
            background: 'transparent',
          }}
        >
          <p style={{ margin: 0, fontSize: 12, color: 'var(--shell-ink-2)' }}>This cycle</p>
          <p
            style={{
              margin: '5px 0 0',
              fontFamily: 'var(--display)',
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              color: 'var(--shell-ink)',
            }}
          >
            {money(cycleTotalCents)}
          </p>
          <p
            style={{
              margin: '3px 0 0',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--shell-ink-2)',
            }}
          >
            due {ACCOUNT.dueDate}
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderTop: '1px solid var(--shell-line-soft)',
            paddingTop: 14,
          }}
        >
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: 'var(--shell-nav-selected)',
              flex: 'none',
            }}
          />
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--shell-ink)' }}>
              {USER.name}
            </p>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--shell-ink-2)' }}>{USER.role}</p>
          </div>
        </div>
      </aside>

      <main style={{ padding: '30px 38px', maxWidth: 1280 }}>{children}</main>
    </div>
  );
}
