import type { ExportJob, Invoice, JobRecord, QueueItem, Seat, Tier } from './model.js';

// Mock data only. Nothing here is wired to Supabase or Stripe yet — the
// handoff's first pass is UI against hardcoded state so the screens can be
// judged before the data work lands.

export const ACCOUNT = {
  name: 'Harrow Brothers Electrical',
  plan: 'Team plan',
  billingCycle: 'billed monthly',
  dueDate: '1 Sep 2026',
  host: 'td-prod-1',
  region: 'eu-west-2',
};

export const USER = {
  name: 'Ray Harrow',
  role: 'Account owner',
  email: 'ray@harrowbrothers.co.uk',
};

/** Purchased capacity per tier — `tenants.manager_seats` / `.technician_seats`. */
export const PURCHASED: Record<Tier, number> = {
  manager: 2,
  technician: 6,
};

export const SEATS: Seat[] = [
  {
    ref: 'ray-harrow',
    name: 'Ray Harrow',
    trade: 'Electrician',
    tier: 'manager',
    state: 'active',
    seatExempt: false,
    telegramUserId: '418902733',
    botUsername: '@harrow_ray_bot',
    sandboxRef: 's2',
    seatSince: 'Mar 2026',
  },
  {
    ref: 'nadia-okafor',
    name: 'Nadia Okafor',
    trade: 'Electrician',
    tier: 'manager',
    state: 'active',
    seatExempt: false,
    telegramUserId: '502114876',
    botUsername: '@harrow_nadia_bot',
    sandboxRef: 's3',
    seatSince: 'Mar 2026',
  },
  {
    ref: 'pete-rowan',
    name: 'Pete Rowan',
    trade: 'Plumber',
    tier: 'technician',
    state: 'active',
    seatExempt: false,
    telegramUserId: '618223401',
    botUsername: '@harrow_pr_bot',
    sandboxRef: 's5',
    seatSince: 'Apr 2026',
  },
  {
    ref: 'dev-singh',
    name: 'Dev Singh',
    trade: 'HVAC',
    tier: 'technician',
    state: 'active',
    seatExempt: false,
    telegramUserId: '733901254',
    botUsername: '@harrow_dev_bot',
    sandboxRef: 's7',
    seatSince: 'Apr 2026',
  },
  {
    ref: 'marnie-boyd',
    name: 'Marnie Boyd',
    trade: 'Roofer',
    tier: 'technician',
    state: 'active',
    seatExempt: false,
    telegramUserId: '811457309',
    botUsername: '@harrow_marnie_bot',
    sandboxRef: 's8',
    seatSince: 'May 2026',
  },
  {
    // Bot created, sandbox still building on the box (~10 min).
    ref: 'josh-kelleher',
    name: 'Josh Kelleher',
    trade: 'Carpenter',
    tier: 'technician',
    state: 'pending_verification',
    seatExempt: false,
    telegramUserId: '904118762',
    botUsername: '@harrow_josh_bot',
    sandboxRef: 's9',
    seatSince: 'Aug 2026',
  },
  {
    // Deactivated: inside the grace period, sandbox retirement requested.
    ref: 'colin-webb',
    name: 'Colin Webb',
    trade: 'Plumber',
    tier: 'technician',
    state: 'offboarding',
    seatExempt: false,
    telegramUserId: '655230198',
    botUsername: '@harrow_colin_bot',
    sandboxRef: 's4',
    seatSince: 'Feb 2026',
  },
  {
    // Seat-exempt: on the schedule, occupies no purchased seat, never gets a
    // sandbox or a bot. Present so the UI has to handle the case honestly.
    ref: 'tess-arnold',
    name: 'Tess Arnold',
    trade: 'Apprentice',
    tier: 'technician',
    state: 'active',
    seatExempt: true,
    telegramUserId: null,
    botUsername: null,
    sandboxRef: null,
    seatSince: 'Jun 2026',
  },
];

export const INVOICES: Invoice[] = [
  { id: 'INV-2026-07', period: 'Jul 2026', managerSeats: 2, technicianSeats: 5, amountCents: 41000, status: 'Paid' },
  { id: 'INV-2026-06', period: 'Jun 2026', managerSeats: 2, technicianSeats: 5, amountCents: 41000, status: 'Paid' },
  { id: 'INV-2026-05', period: 'May 2026', managerSeats: 2, technicianSeats: 4, amountCents: 36000, status: 'Paid' },
  { id: 'INV-2026-04', period: 'Apr 2026', managerSeats: 2, technicianSeats: 3, amountCents: 31000, status: 'Paid' },
  { id: 'INV-2026-03', period: 'Mar 2026', managerSeats: 2, technicianSeats: 1, amountCents: 21000, status: 'Paid' },
];

/** The four failure classes the handoff says are worth designing for. */
export const QUEUE: QueueItem[] = [
  {
    id: 'q1',
    account: 'Harrow Brothers Electrical',
    item: 'sandbox s9 · josh-kelleher',
    reason: 'Stuck provisioning — 41 min, no completion report from td-prod-1',
    action: 'Retry',
  },
  {
    id: 'q2',
    account: 'Kestrel Heating',
    item: 'bot @kestrel_amy_bot',
    reason: 'Token rejected by Telegram (401) — bot deleted at BotFather?',
    action: 'Notify',
  },
  {
    id: 'q3',
    account: 'Delaney Roofing',
    item: 'Telegram ID 418902733',
    reason: 'Duplicate — already bound on Harrow Brothers Electrical',
    action: 'Review',
  },
  {
    id: 'q4',
    account: 'Southgate Plumbing',
    item: 'record JOB-4471 photo',
    reason: 'Held by moderation — flagged on upload, awaiting a human',
    action: 'Approve',
  },
];

export const RECORDS: JobRecord[] = [
  { id: 'JOB-4471', description: 'Consumer unit replacement', site: '14 Bell Lane, N4', date: '06 Aug' },
  { id: 'JOB-4462', description: 'EICR — remedial works', site: 'Unit 3, Colville Est.', date: '04 Aug' },
  { id: 'JOB-4455', description: 'Emergency callout, no power', site: '88 Ridgemount Rd', date: '02 Aug' },
  { id: 'JOB-4441', description: 'EV charger install, 7kW', site: '2 Farrier Close', date: '29 Jul' },
];

export const EXPORTS: ExportJob[] = [
  {
    id: 'exp-0043',
    kind: 'records',
    requestedBy: 'Ray Harrow',
    requestedAt: '06 Aug 2026, 09:12',
    sizeLabel: '1.4 MB',
    status: 'Ready',
    expiresLabel: 'expires 13 Aug',
    rowCount: 1183,
  },
  {
    id: 'exp-0038',
    kind: 'conversations',
    requestedBy: 'Ray Harrow',
    requestedAt: '28 Jul 2026, 16:40',
    sizeLabel: '38.2 MB',
    status: 'Expired',
    expiresLabel: 'expired 04 Aug',
    rowCount: 12904,
  },
  {
    id: 'exp-0031',
    kind: 'logs',
    requestedBy: 'Nadia Okafor',
    requestedAt: '19 Jul 2026, 08:05',
    sizeLabel: '620 KB',
    status: 'Expired',
    expiresLabel: 'expired 26 Jul',
    rowCount: 8422,
  },
];

/** Counts shown next to each export option, so the size is known before clicking. */
export const DATA_COUNTS = {
  customers: 312,
  jobs: 1874,
  visits: 2960,
  conversations: 12904,
  callsTranscribed: 146,
};

export const SANDBOX_LOG = [
  '08:14:02  heartbeat ok · gateway up 6d 04h',
  '08:09:41  message relayed · JOB-4471 attachment 2.1MB',
  '07:52:18  badge refreshed · fingerprint 9c04e2',
];
