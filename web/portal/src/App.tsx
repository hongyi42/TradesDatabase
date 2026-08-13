import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, type AppScreen } from './components/AppShell.js';
import { Landing } from './screens/Landing.js';
import { SignIn } from './screens/SignIn.js';
import { Billing } from './screens/Billing.js';
import { Seats } from './screens/Seats.js';
import { SeatDetail } from './screens/SeatDetail.js';
import { DataExports } from './screens/DataExports.js';
import { AdminQueue } from './screens/AdminQueue.js';
import { PRICE_CENTS, prorate, tierLines, type Seat, type Tier } from './data/model.js';
import * as api from './data/api.js';

type Screen = 'landing' | 'login' | AppScreen;

// Phase 3: the signed-in screens read REAL data over /portal/api/*.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md.
//
// Still on mock data, deliberately and visibly:
//   * Billing — there is no Stripe account (owner descoped it 2026-08-12), and
//     deriving an invoice from seats × price would invent a number nobody will
//     be charged, on the one screen whose job is saying what is owed. It renders
//     a "not connected" banner instead (plan D5).
//   * Data & exports — export is Phase 6.5 and has no backend at all.
//   * Add / delete seat — those spend and release money (Phases 3 and 6 of the
//     2026-08-07 plan) and are still local-only. They are disabled rather than
//     left looking functional; see `notWired` below.

export function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [detailRef, setDetailRef] = useState<string | null>(null);

  // Session bootstrap. `undefined` = still asking, `null` = signed out.
  const [me, setMe] = useState<api.Me | null | undefined>(undefined);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [summary, setSummary] = useState<api.Summary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // On first paint, ask who we are. A 401 is the ordinary signed-out answer, not
  // an error — the landing page is the correct destination for it.
  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((who) => !cancelled && setMe(who))
      .catch(() => !cancelled && setMe(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const signedOut = useCallback(() => {
    setMe(null);
    setSeats([]);
    setSummary(null);
    setScreen('landing');
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [nextSeats, nextSummary] = await Promise.all([api.getSeats(), api.getSummary()]);
      setSeats(nextSeats);
      setSummary(nextSummary);
    } catch (err) {
      // A session that expired between page load and this fetch must return the
      // user to the door rather than showing a broken screen.
      if (err instanceof api.Unauthenticated) return signedOut();
      setLoadError(
        err instanceof api.ApiError && err.status === 0
          ? "Couldn't reach the server. Check your connection and try again."
          : 'Something went wrong loading your account.',
      );
    }
  }, [signedOut]);

  // Load the account once we know there is a session.
  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  const purchased: Record<Tier, number> = useMemo(
    () => (summary ? api.purchasedFromSummary(summary) : { manager: 0, technician: 0 }),
    [summary],
  );

  const lines = useMemo(() => tierLines(seats, purchased), [seats, purchased]);
  const prorationCents = prorate(PRICE_CENTS.technician, 11, 31);
  const totalCents = lines.reduce((sum, l) => sum + l.subtotalCents, 0) + prorationCents;

  async function handleSignOut() {
    try {
      await api.signOut();
    } finally {
      signedOut();
    }
  }

  if (screen === 'landing' && !me) {
    // No wrapper: the landing owns its own background and full-height layout,
    // and an outer flex column would fight its sticky header.
    return <Landing onSignIn={() => setScreen('login')} />;
  }

  if (screen === 'login' && !me) {
    return <SignIn onBack={() => setScreen('landing')} />;
  }

  // Signed in but the first fetch has not landed yet.
  if (me && !summary && !loadError) {
    return <Splash>Loading your account…</Splash>;
  }

  if (me && loadError) {
    return (
      <Splash>
        {loadError}
        <button type="button" onClick={() => void load()} style={retryStyle}>
          Try again
        </button>
      </Splash>
    );
  }

  if (!me) {
    // Session ended while a signed-in screen was open.
    return <Landing onSignIn={() => setScreen('login')} />;
  }

  const appScreen: AppScreen = screen === 'landing' || screen === 'login' ? 'billing' : screen;
  const detailSeat = seats.find((s) => s.ref === detailRef) ?? null;

  return (
    <>
      <AppShell
        screen={appScreen}
        onNavigate={setScreen}
        cycleTotalCents={totalCents}
        // D4: the admin queue is a CROSS-TENANT operator surface reached from the
        // same shell customers use. Whether it appears is decided by the role on
        // the server session — never by client state.
        role={me.role}
        accountEmail={me.email}
        onSignOut={() => void handleSignOut()}
      >
        {appScreen === 'billing' && (
          <Billing lines={lines} prorationCents={prorationCents} totalCents={totalCents} notWired />
        )}
        {appScreen === 'seats' && (
          <Seats
            seats={seats}
            purchased={purchased}
            onOpenSeat={(ref) => {
              setDetailRef(ref);
              setScreen('detail');
            }}
            onAddSeat={undefined}
            onDeleteSeat={undefined}
          />
        )}
        {appScreen === 'detail' && detailSeat && (
          <SeatDetail seat={detailSeat} onBack={() => setScreen('seats')} onDelete={undefined} />
        )}
        {appScreen === 'exports' && <DataExports />}
        {appScreen === 'admin' && me.role === 'operator' && <AdminQueue />}
      </AppShell>
    </>
  );
}

const retryStyle = {
  marginTop: 18,
  padding: '10px 18px',
  borderRadius: 8,
  border: '1px solid var(--shell-line)',
  background: 'transparent',
  color: 'var(--shell-ink)',
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
  fontSize: 14,
};

/**
 * The full-screen states the handoff never drew (it lists loading and error as
 * "still not designed"). Kept deliberately plain rather than inventing a
 * spinner vocabulary the rest of the app does not have.
 */
function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        background: 'var(--shell-bg)',
        color: 'var(--shell-ink)',
        fontSize: 15,
        textAlign: 'center',
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}
