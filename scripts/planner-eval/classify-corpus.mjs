// What a seat's message to the office MEANS — a labelled corpus (2026-09-22).
//
// Built to answer one question: can a cheap classifier tell apart the kinds of
// thing that arrive in the office's inbox as `kind: 'inform'`? The code that
// WRITES a message knows some of this for certain (an access decision is written
// by tellThePlanner, and could simply be labelled); what no label at write time
// can say is what a SEAT's own message is about — that takes reading it.
//
// SYNTHETIC, DELIBERATELY. Fictional firm, fictional people (the names the notes
// eval already uses). Nothing here came from the pilot: a new third-party model
// sees these, and seat messages in the pilot carry customer details.
//
// THE LABELS ARE MINE. Ground truth is one person's judgment, written before any
// model saw the messages. `wake` is DERIVED from the category, not judged per
// message: chatter and access news can wait for the half-hourly look; the rest
// are things the office should act on now.
//
// The access-news bodies copy the exact sentence shapes src/mcp/tools/access.ts
// writes (grant :647, decline :727, revoke :903), so the classifier is tested on
// what the code really produces, not on a paraphrase of it.

export const CATEGORIES = {
  standing_instruction:
    'A rule, preference or arrangement that should apply from now on or for a stated period — who handles what, who is away until when, how someone wants to be contacted.',
  operational_report:
    'A report about work: something was done, is delayed, is blocked, or needs parts, money or a follow-up.',
  question:
    'The sender is asking the office something and wants an answer.',
  urgent_problem:
    'Something is going wrong right now — safety, damage, an angry customer, or a person who cannot work — and needs a human quickly.',
  chatter:
    'An acknowledgement, thanks or pleasantry that carries no information and asks for nothing.',
  access_news:
    'A record that a manager opened, refused or revoked a technician\'s access to part of the firm\'s record.',
};

export const WAKE_WHEN = new Set([
  'standing_instruction', 'operational_report', 'question', 'urgent_problem',
]);

const tech = 'a technician\'s assistant';
const mgr = 'a manager\'s assistant';

export const CORPUS = [
  // ── standing instructions ──
  { id: 's1', from: mgr, cat: 'standing_instruction', body: 'From now on route all job and visit messages to Sam, not me. He is taking over scheduling this week.' },
  { id: 's2', from: tech, cat: 'standing_instruction', body: 'Ben is out from Thursday until the 3rd. Anything on his jobs goes to Dani while he is gone.' },
  { id: 's3', from: mgr, cat: 'standing_instruction', body: 'Please stop texting me before 7am, I do not see them and it wakes the house. After 7 is fine.' },
  { id: 's4', from: mgr, cat: 'standing_instruction', body: 'Going forward, any job quoted over $2,000 needs my sign-off before it is booked.' },
  { id: 's5', from: tech, cat: 'standing_instruction', body: 'The Henderson family prefer a phone call, not texts. Always ring them first from now on.' },
  { id: 's6', from: mgr, cat: 'standing_instruction', body: 'Dani does not do gas work until her certificate comes through next month, so do not put gas jobs on her.' },

  // ── operational reports ──
  { id: 'r1', from: tech, cat: 'operational_report', body: 'Ben says the Duarte tankless descale is done, unit running clean, took about two hours.' },
  { id: 'r2', from: tech, cat: 'operational_report', body: 'Henderson boiler is in and firing. Customer paid $500 cash on site.' },
  { id: 'r3', from: tech, cat: 'operational_report', body: 'Ben needs a 3/4 inch pressure relief valve for the Okafor water heater before he can finish. None on the van.' },
  { id: 'r4', from: tech, cat: 'operational_report', body: 'Running about 40 minutes late to the Reyes appointment, traffic on the 101.' },
  { id: 'r5', from: tech, cat: 'operational_report', body: 'Finished the Okafor job. The customer wants a quote for replacing their second heater too.' },
  { id: 'r6', from: tech, cat: 'operational_report', body: 'Could not get into the Duarte property, nobody home and no gate code. Left a card.' },

  // ── questions ──
  { id: 'q1', from: tech, cat: 'question', body: 'Does the Henderson job need a permit pulled, or is that on the customer?' },
  { id: 'q2', from: tech, cat: 'question', body: 'Ben wants to know whether to bill the Okafors for the second trip or eat it.' },
  { id: 'q3', from: tech, cat: 'question', body: 'Is the Reyes visit tomorrow still on? The customer has not confirmed.' },
  { id: 'q4', from: mgr, cat: 'question', body: 'Who is covering the on-call phone this weekend?' },

  // ── urgent problems ──
  { id: 'u1', from: tech, cat: 'urgent_problem', body: 'Smell of gas at the Reyes house when Ben arrived. He shut off the supply and told them to leave. Someone needs to call them now.' },
  { id: 'u2', from: tech, cat: 'urgent_problem', body: 'The customer at the Okafor job is really upset about the bill and is threatening a chargeback.' },
  { id: 'u3', from: tech, cat: 'urgent_problem', body: 'Water pouring from the ceiling at the Henderson place after the install. Ben is there now trying to stop it.' },
  { id: 'u4', from: tech, cat: 'urgent_problem', body: 'Ben\'s van got broken into and his tools were stolen. He cannot do the rest of today\'s jobs.' },

  // ── chatter ──
  { id: 'c1', from: tech, cat: 'chatter', body: 'Thanks for the heads up earlier!' },
  { id: 'c2', from: tech, cat: 'chatter', body: 'Ok, got it.' },
  { id: 'c3', from: tech, cat: 'chatter', body: 'Ben says have a good weekend everyone.' },
  { id: 'c4', from: mgr, cat: 'chatter', body: 'Sounds good.' },

  // ── access news (exact access.ts shapes) ──
  { id: 'a1', from: mgr, cat: 'access_news', body: 'Opened the job they asked about, and that customer\'s details for Ben Shelton until tomorrow 5:00 PM — they had asked: "need the gate code for the Duarte job". Why: he is covering Sam\'s route today.' },
  { id: 'a2', from: mgr, cat: 'access_news', body: 'Said no to opening every note on the "Boiler swap" job for Henderson Family for Ben Shelton. Why: not his job, Sam is handling it.' },
  { id: 'a3', from: mgr, cat: 'access_news', body: 'Opened money figures on everything Dani Ruiz can already open for good. Why: she is doing her own invoicing now.' },
  { id: 'a4', from: mgr, cat: 'access_news', body: 'Revoked Ben Shelton\'s access to the "Tankless descaling" job for Marisol Duarte. Why: the job is finished.' },

  // ── HARD: two things at once. Scored separately; the label is the part that
  //    would be LOST if missed (a report is recoverable from the record, a
  //    standing instruction is not). ──
  { id: 'h1', from: tech, cat: 'standing_instruction', hard: true, body: 'Done at Duarte, all good. Also Marisol says from now on call her before showing up, she works nights.' },
  { id: 'h2', from: tech, cat: 'urgent_problem', hard: true, body: 'Quick update on Henderson: install went fine but I noticed the flue is cracked and it is venting into the garage. Told them not to use it tonight.' },
  { id: 'h3', from: tech, cat: 'question', hard: true, body: 'Reyes visit done. Should I order the replacement part now or wait for the customer to approve the quote?' },
];
