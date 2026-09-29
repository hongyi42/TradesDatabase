import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import * as prompt from './plannerPrompt.js';
import { OFFICE_SYSTEM, officeSystemFor, type OfficeDoor } from './officePrompt.js';

// THE SPLIT CHANGED NO BYTE (plan 2026-09-22, the office one agent). PLANNER_SYSTEM
// was cut into named sections so the office can share them; the planner's
// behaviour was measured on the whole string, so the whole string must survive.
// The one deliberate edit is the ACCESS paragraph (the office no longer opens
// anything): put the old wording back and the hash must be the pre-split one.
const OLD_ACCESS_HEAD = [
  'ACCESS. A technician can ask to open part of the record they cannot see. That ask is answered',
  'the moment it is made — either the office opens it there and then, or every manager is texted',
  'and one of them decides. It never reaches this list and there is nothing here for you to do',
].join('\n');
const NEW_ACCESS_HEAD = [
  'ACCESS. A technician can ask to open part of the record they cannot see. That ask is handled',
  'the moment it is made: the office puts it to the manager who looks after them, and only a',
  'manager can open anything. It never reaches this list and there is nothing here for you to do',
].join('\n');
// Step 3 (plan 2026-09-23-step-3-office-reaches-glue-seats): the quiet note may
// wait for the person's next message, and the office READS an assistant's
// conversation instead of asking it. Remove these lines and the hash must hold.
const OLD_SEND_HOW_TAIL = "           itself whether its person ever hears about it, so it may never arrive at all.";
const NEW_SEND_HOW_TAIL = [
  OLD_SEND_HOW_TAIL,
  '           It may not even be read until that person next writes to their assistant. To',
  '           learn what someone already told their assistant, or what it was told, read it',
  '           with `read_conversation` rather than sending their assistant a question.',
].join('\n');
// Step 2e phase 4: the `outbound_invoice` paragraph in CALLS. Remove it and the
// hash must hold.
const OUTBOUND_INVOICE_PARAGRAPH = [
  '  ONE MORE KIND RIDES THIS LOOP, AND NOBODY GOT IN TOUCH. `outbound_invoice` is a manager\'s own',
  '  sent work email that looks like an invoice — a PDF on it, or the word "invoice". If it is an',
  '  invoice the firm issued and THE RECORD line does not say it is on the ledger, send a note to',
  '  the assistant of the manager whose mailbox sent it (`as:"assistant"`, `to` that manager,',
  '  naming the item in `nudgeId`) — or, if they are gone, another active manager; never a',
  '  technician. The note names the customer, the job, the amount if the email shows it, and their',
  '  invoice number, asks whether to record it, and says to cite capture <the capture id> as',
  '  sourceCaptureId when recording. That note is the whole ask — no text goes with it, and one',
  '  note per email, ever. A yes records it and the ledger closes this item; a no comes back to you',
  '  from their assistant, and you dismiss it. Anything else — a supplier\'s bill, a question about',
  '  a payment, an invoice already on the ledger — dismiss it and say why in one line. Everything',
  '  below about calls, texts and quiet notes is about the other three kinds, not this one.',
  '',
  '',
].join('\n');
// sha256 of PLANNER_SYSTEM at 532720f, before the split.
const PRE_SPLIT_SHA256 = '4b5fda2b3abfce787f0c692ec2f0d167ccd46398e405fd74fc5d4b6e4c4f75bb';

describe('PLANNER_SYSTEM — split into sections without changing it', () => {
  test('only the ACCESS paragraph, the step 3 SEND lines and the step 2e outbound_invoice paragraph differ from the pre-split prompt', () => {
    expect(prompt.PLANNER_SYSTEM).toContain(NEW_ACCESS_HEAD);
    expect(prompt.PLANNER_SYSTEM).toContain(NEW_SEND_HOW_TAIL);
    expect(prompt.PLANNER_SYSTEM).toContain(OUTBOUND_INVOICE_PARAGRAPH);
    const restored = prompt.PLANNER_SYSTEM.replace(NEW_ACCESS_HEAD, OLD_ACCESS_HEAD)
      .replace(NEW_SEND_HOW_TAIL, OLD_SEND_HOW_TAIL)
      .replace(OUTBOUND_INVOICE_PARAGRAPH, '');
    expect(createHash('sha256').update(restored).digest('hex')).toBe(PRE_SPLIT_SHA256);
  });

  test('the planner no longer says the office opens anything', () => {
    expect(prompt.PLANNER_SYSTEM).not.toContain('the office opens it');
  });
});

describe('OFFICE_SYSTEM — the office carries every section a call needs', () => {
  // The inbound-call pass moves onto OFFICE_SYSTEM with submit_plan and every
  // send rail unchanged, so it needs the doctrine those rails assume (review F7).
  const shared = [
    'GAP_IS',
    'SEND_TIMING',
    'VERBS',
    'SEND',
    'SEAT_MESSAGES',
    'MESSAGE_LIMITS',
    'SILENCE',
    'STATES',
    'CLOSING',
    'CALLS',
    'JUDGING',
    'WRITING',
    'MEMORY_DECISIONS',
    'NOTES',
    'CONTEXT',
    'SUBMIT_ONCE',
  ] as const;
  // The message door (rung 10c) is a focused pass on the same rails as a call.
  const acting = shared.flatMap((name) => (['call', 'message'] as const).map((door) => [name, door] as const));
  test.each(acting)('%s is in the %s door prompt, verbatim', (name, door) => {
    const section = (prompt as unknown as Record<string, readonly string[]>)[name];
    expect(section).toBeDefined();
    expect(officeSystemFor(door)).toContain(section.join('\n').replace(/\n+$/, ''));
  });

  test('OFFICE_SYSTEM keeps its meaning: the call door', () => {
    expect(OFFICE_SYSTEM).toBe(officeSystemFor('call'));
  });

  test('the office has its own opening, doors, audience and access rules', () => {
    expect(OFFICE_SYSTEM).toContain('working the OFFICE');
    expect(OFFICE_SYSTEM).toContain('SOMEONE IS USUALLY WAITING');
    expect(OFFICE_SYSTEM).toContain('`answer`');
    expect(OFFICE_SYSTEM).toContain('`route_access`');
    expect(OFFICE_SYSTEM).toContain('ONLY A MANAGER OPENS ANYTHING');
    expect(OFFICE_SYSTEM).toContain('NAMES AND IDS ONLY');
    // The money rule the desk carried (operator 2026-09-15), for any non-manager.
    expect(OFFICE_SYSTEM).toContain('NEVER A MONEY AMOUNT');
    expect(OFFICE_SYSTEM).toContain('invoiced, not yet paid');
    // Notes consulted, never quoted — the 2026-09-01 ruling's wording order.
    expect(OFFICE_SYSTEM).toContain('Consult them freely');
    expect(OFFICE_SYSTEM).toContain('never quote a note');
    // A routing claim from the asker is a claim.
    expect(OFFICE_SYSTEM).toContain('their claim');
    // The shared sections end on submit_plan; the office's last word re-scopes it.
    expect(OFFICE_SYSTEM).toContain('work with the tools you have.');
    // The fourth door is named, and the call doctrine is pointed at.
    expect(OFFICE_SYSTEM).toContain('A MESSAGE a seat sent you');
    expect(OFFICE_SYSTEM).toContain('Everything below about gaps, verbs, sending and closing');
  });

  test("the planner's own sections stay out of the office", () => {
    expect(OFFICE_SYSTEM).not.toContain('WHAT THE LIST IS, AND WHERE IT COMES FROM');
    expect(OFFICE_SYSTEM).not.toContain('HOW TO PACE');
    expect(OFFICE_SYSTEM).not.toContain('THERE IS NO HANDOVER');
  });
});

// EACH DOOR LOADS ONLY WHAT IT USES (operator, 2026-09-23; rung 10c phase 2).
describe('officeSystemFor — the waiting doors carry the office, not the call doctrine', () => {
  const section = (name: string) =>
    (prompt as unknown as Record<string, readonly string[]>)[name].join('\n').replace(/\n+$/, '');
  const waiting = ['question', 'access'] as const;

  test.each(waiting)('the %s door keeps the rules for what may be said', (door) => {
    const sys = officeSystemFor(door);
    expect(sys).toContain('NEVER A MONEY AMOUNT');
    expect(sys).toContain('never quote a note');
    expect(sys).toContain('ONLY A MANAGER OPENS ANYTHING');
    for (const name of ['NOTES', 'CONTEXT', 'WRITING']) expect(sys).toContain(section(name));
  });

  test.each(waiting)('the %s door carries none of the call doctrine', (door) => {
    const sys = officeSystemFor(door);
    for (const name of ['STATES', 'CALLS', 'VERBS', 'SILENCE', 'SEND', 'CLOSING', 'GAP_IS', 'SUBMIT_ONCE']) {
      expect(sys, name).not.toContain(section(name));
    }
    // …nor the pointer at it, which would point at nothing.
    expect(sys).not.toContain('Everything below about gaps, verbs, sending and closing');
  });

  const endings: [OfficeDoor, string][] = [
    ['question', '`answer`.'],
    ['access', '`route_access`.'],
    ['call', '`submit_plan`.'],
    ['message', '`submit_plan`.'],
  ];
  test.each(endings)("the %s door's last word is its own terminal tool", (door, tail) => {
    expect(officeSystemFor(door).trimEnd().endsWith(tail)).toBe(true);
  });

  test.each(waiting)('the %s door is under 4,500 tokens (chars / 3.6; the repo has no estimator)', (door) => {
    expect(officeSystemFor(door).length / 3.6).toBeLessThan(4500);
  });
});
