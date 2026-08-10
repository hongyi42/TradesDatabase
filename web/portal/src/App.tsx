import { useMemo, useState } from 'react';
import { AppShell, type AppScreen } from './components/AppShell.js';
import { AddSeatModal } from './components/AddSeatModal.js';
import { Landing } from './screens/Landing.js';
import { SignIn } from './screens/SignIn.js';
import { Billing } from './screens/Billing.js';
import { Seats } from './screens/Seats.js';
import { SeatDetail } from './screens/SeatDetail.js';
import { DataExports } from './screens/DataExports.js';
import { AdminQueue } from './screens/AdminQueue.js';
import { PURCHASED, SEATS } from './data/mock.js';
import { PRICE_CENTS, prorate, tierLines, type Seat, type Tier } from './data/model.js';

type Screen = 'landing' | 'login' | AppScreen;

export function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const [seats, setSeats] = useState<Seat[]>(SEATS);
  const [purchased, setPurchased] = useState<Record<Tier, number>>(PURCHASED);
  const [addOpen, setAddOpen] = useState(false);

  const lines = useMemo(() => tierLines(seats, purchased), [seats, purchased]);
  const prorationCents = prorate(PRICE_CENTS.technician, 11, 31);
  const totalCents = lines.reduce((sum, l) => sum + l.subtotalCents, 0) + prorationCents;

  function addSeat({ name, trade, tier }: { name: string; trade: string; tier: Tier }) {
    // A confirmed purchase raises purchased capacity AND adds the roster row.
    // The row starts at `invited` — it has no sandbox until the box reports the
    // claim back, which is what the "Provisioning" pill represents.
    setPurchased((p) => ({ ...p, [tier]: p[tier] + 1 }));
    setSeats((list) => [
      ...list,
      {
        ref: name.trim().toLowerCase().replace(/\s+/g, '-'),
        name: name.trim(),
        trade,
        tier,
        state: 'invited',
        seatExempt: false,
        telegramUserId: null,
        botUsername: `@harrow_${name.trim().toLowerCase().split(/\s+/)[0]}_bot`,
        sandboxRef: null,
        seatSince: 'Aug 2026',
      },
    ]);
    setAddOpen(false);
  }

  function deleteSeat(ref: string) {
    // Deactivation, not deletion: the row moves to `offboarding` and serves out
    // its grace period. Refs are never reused, so the row is never removed.
    setSeats((list) => list.map((s) => (s.ref === ref ? { ...s, state: 'offboarding' as const } : s)));
    setPurchased((p) => {
      const seat = seats.find((s) => s.ref === ref);
      if (!seat || seat.seatExempt) return p;
      return { ...p, [seat.tier]: Math.max(0, p[seat.tier] - 1) };
    });
    if (screen === 'detail') setScreen('seats');
  }

  if (screen === 'landing') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Landing onSignIn={() => setScreen('login')} />
      </div>
    );
  }

  if (screen === 'login') {
    return <SignIn onContinue={() => setScreen('billing')} />;
  }

  const detailSeat = seats.find((s) => s.ref === detailRef) ?? null;

  return (
    <>
      <AppShell screen={screen} onNavigate={setScreen} cycleTotalCents={totalCents}>
        {screen === 'billing' && (
          <Billing lines={lines} prorationCents={prorationCents} totalCents={totalCents} />
        )}
        {screen === 'seats' && (
          <Seats
            seats={seats}
            purchased={purchased}
            onOpenSeat={(ref) => {
              setDetailRef(ref);
              setScreen('detail');
            }}
            onAddSeat={() => setAddOpen(true)}
            onDeleteSeat={deleteSeat}
          />
        )}
        {screen === 'detail' && detailSeat && (
          <SeatDetail
            seat={detailSeat}
            onBack={() => setScreen('seats')}
            onDelete={() => deleteSeat(detailSeat.ref)}
          />
        )}
        {screen === 'exports' && <DataExports />}
        {screen === 'admin' && <AdminQueue />}
      </AppShell>

      {addOpen && <AddSeatModal onClose={() => setAddOpen(false)} onConfirm={addSeat} />}
    </>
  );
}
