// Step 2c gate: seed 100 realistic email captures into the LOCAL rig (plan
// 2026-09-28-step-2c-batching, phase 4). LOCAL ONLY — refuses any SUPABASE_URL
// that is not 127.0.0.1 (L1 is append-only; never seed the pilot).
//
//   set -a; . ./.env.test; set +a; node scripts/seat-eval/batching/seed-emails.mjs <out.json>
//
// NO TELLS (the spike's fixtures leaked three ways — subjects, sender shapes,
// unique surnames): every sender comes from ONE pool and writes several times,
// subjects come from ONE pool, and urgency is only mid-body. 12 need someone
// sent. Every body carries a unique `ref E-###` so the gate can trace which
// emails a run read. Writes <out.json> = { tenantId, urgent: [{name, ref}] }.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: seed-emails.mjs <out.json>');
if (!/^http:\/\/127\.0\.0\.1:/.test(process.env.SUPABASE_URL ?? '')) throw new Error('refusing: not the local stack');
const WT = process.cwd();
const { appendRawCapture } = await import(join(WT, 'dist/db/rawCaptures.js'));
const { formatEmailRawText } = await import(join(WT, 'dist/email/format.js'));
const pg = (await import(join(WT, 'node_modules/pg/lib/index.js'))).default;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const tenantId = (await c.query("select tenant_id from technicians where ref = 'manager-sam'")).rows[0]?.tenant_id;
await c.end();
if (!tenantId) throw new Error('manager-sam missing: npm run seed:local + setup-local-seat.mjs first');

// 30 households, each writing ~3 times; 12 of them write ONE urgent email.
const NAMES = ['Alvarez', 'Bennett', 'Chowdhury', 'Dubois', 'Eriksen', 'Fitzgerald', 'Gallagher', 'Hartmann', 'Iverson', 'Jovanovic',
  'Kaplan', 'Lindqvist', 'Mbeki', 'Novak', "O'Brien", 'Petrovic', 'Quinlan', 'Rasmussen', 'Sandoval', 'Takahashi',
  'Underwood', 'Vasquez', 'Whitfield', 'Xu', 'Yilmaz', 'Zimmerman', 'Abernathy', 'Castellano', 'Delacroix', 'Engstrom'];
const SUBJECTS = ['Question about our appointment', 'Following up', 'Re: your visit', 'Quick question', 'Checking in',
  'About last week', 'Our service', 'Hello from us', 'Re: estimate', 'A note for the team'];
const ROUTINE = [
  'We wanted to say thanks for the visit last month. Everything has been running fine since.',
  'Could you send over a copy of the last invoice for our records? No rush at all.',
  'Just confirming we are still on for the seasonal check next month. Any morning works.',
  'We moved the dog to the back room, so the tech can use the side gate next time.',
  'Is there a discount if we book the annual maintenance for both properties together?',
  'Our neighbour asked who did our install, so we passed on your number. Hope that is ok.',
  'We paid the balance online yesterday, just letting you know in case it has not shown up.',
  'Can you tell us which filter size the unit takes? We would like to keep a spare.',
];
const URGENT = [
  'Last night the water heater started leaking and there is now water spreading across the garage floor towards the storage boxes.',
  'The furnace stopped overnight and the house is down to 55 degrees; we have a newborn and an elderly parent staying with us.',
  'The breaker for the kitchen keeps tripping every hour and this morning we noticed a burning smell near the panel.',
  'There is a gas smell near the outdoor unit that was not there yesterday, and it is getting stronger by the afternoon.',
];

const rows = [];
let k = 0;
for (let round = 0; round < 4 && rows.length < 100; round += 1) {
  for (let i = 0; i < NAMES.length && rows.length < 100; i += 1) rows.push({ name: NAMES[i], urgent: false });
}
// The 12 urgent: one email each from 12 households, spread through the list (not every 8th).
const urgentAt = [3, 11, 19, 26, 34, 41, 49, 57, 64, 72, 83, 95];
const usedNames = new Set();
for (const at of urgentAt) {
  let j = at;
  while (usedNames.has(rows[j].name)) j = (j + 1) % rows.length;
  usedNames.add(rows[j].name);
  rows[j].urgent = true;
}

const urgent = [];
for (const [i, r] of rows.entries()) {
  k += 1;
  const ref = `E-${String(k).padStart(3, '0')}`;
  const first = ROUTINE[(i * 3) % ROUTINE.length];
  const middle = r.urgent ? URGENT[i % URGENT.length] + ' Please send someone out today if you can.' : ROUTINE[(i * 5 + 1) % ROUTINE.length];
  const last = 'Best, the ' + r.name + ' household. (ref ' + ref + ')';
  const body = `Hi there,\n\n${first}\n\n${middle}\n\n${ROUTINE[(i * 7 + 2) % ROUTINE.length]}\n\n${last}`;
  const from = `${r.name} household <${r.name.toLowerCase().replace(/[^a-z]/g, '')}${(i % 3) + 1}@mail.example>`;
  await appendRawCapture({
    tenantId,
    channel: 'email',
    rawText: formatEmailRawText({ from, subject: SUBJECTS[(i * 3 + 1) % SUBJECTS.length], body }),
    externalId: `seed-2c-${ref}-${Date.now()}`,
    technicianRef: 'connector:gmail',
  });
  if (r.urgent) urgent.push({ name: r.name, ref });
  // Distinct captured_at order for "newest first".
  await new Promise((res) => setTimeout(res, 5));
}
writeFileSync(out, JSON.stringify({ tenantId, count: rows.length, urgent }, null, 2));
console.log(`seeded ${rows.length} emails (${urgent.length} urgent) into tenant ${tenantId}`);
