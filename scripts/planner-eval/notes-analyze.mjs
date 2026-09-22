// NOTES-DOCTRINE EVAL, STEP 2 — read a run and say what it means. SPENDS NOTHING.
//
//   node scripts/planner-eval/notes-analyze.mjs --dir <run-dir>
//   node scripts/planner-eval/notes-analyze.mjs --dir <run-dir> --notes
//
// Separate from the run for the reason run.mjs/analyze.mjs are separate: a
// grading change must never cost another matrix. Everything here is
// deterministic — there is no judge, because the question is not whether the
// note reads well. It is whether the instruction was written down at all, and a
// regex over the file the planner saved answers that without an opinion.
//
// WHAT THE VERDICT LINE MEANS. The rung this blocks is waiting on one thing:
// is the notes doctrine reliable, or is it the coin flip the two live
// measurements suggested? So the report states the rate AND what that rate
// rules out, as a binomial tail rather than a rule of thumb.
//
// AN EARLIER DRAFT OF THIS FILE RULED THE COIN FLIP OUT ONLY ON A CLEAN SWEEP,
// and that is wrong in the direction that would have mattered: at 29/30 it
// printed "not reliable yet — the rung stays blocked", when 29 passes in 30
// trials is evidence against a 50% mechanism of roughly three in a hundred
// million. A single miss is not a coin flip; it is a rate, and the question a
// rate asks ("is 3% loss of something seen ONCE acceptable?") belongs to the
// operator, not to this script.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};
const dir = flag('dir');
if (!dir) {
  console.error('--dir <run-dir> required');
  process.exit(2);
}
const showNotes = args.includes('--notes');

const rows = readFileSync(join(dir, 'run.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const meta = existsSync(join(dir, 'meta.json'))
  ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  : {};

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const byVariant = new Map();
for (const r of rows) {
  if (!byVariant.has(r.variant)) byVariant.set(r.variant, []);
  byVariant.get(r.variant).push(r);
}

console.log(`\n${B('NOTES DOCTRINE')} — ${meta.model ?? rows[0]?.model ?? '?'}  (${dir})\n`);

let standingPass = 0;
let standingOf = 0;

for (const [variant, rs] of byVariant) {
  // An errored run is not a measurement — see the runner's grading note.
  const measured = rs.filter((r) => r.pass !== null);
  const errs = rs.length - measured.length;
  const passes = measured.filter((r) => r.pass).length;
  const kind = rs[0].kind;
  if (kind === 'standing') {
    standingPass += passes;
    standingOf += measured.length;
  }
  const pct = measured.length ? ((passes / measured.length) * 100).toFixed(0) : '—';
  const what = kind === 'standing' ? 'filed the instruction' : 'correctly filed nothing';
  console.log(
    `${B(variant.padEnd(20))} ${String(passes).padStart(2)}/${measured.length}  ${String(pct).padStart(3)}%  ${what}` +
      `${errs ? `   (${errs} errored, excluded)` : ''}`,
  );

  // THE PLANNER'S ORDINARY JOB, reported beside the doctrine. A look that filed
  // the note and never submitted a plan did half of what a tick is for, and a
  // rate that hid it would read better than the behaviour deserves.
  const planned = measured.filter((r) => r.submitted).length;
  const wrote = measured.filter((r) => r.wroteMemory).length;
  console.log(
    `${' '.repeat(22)}wrote a note in ${wrote}/${measured.length}` +
      ` · submitted a plan in ${planned}/${measured.length}` +
      ` · median ${median(measured.map((r) => r.turns ?? 0))} turns`,
  );

  // EVERY FAILURE, QUOTED. A rate with no failures shown is a number nobody can
  // check: what makes this readable later is seeing what the misses looked like.
  for (const r of measured.filter((x) => !x.pass)) {
    const note = (r.memoryContent ?? []).filter(Boolean).join(' / ').replace(/\s+/g, ' ');
    console.log(
      `${' '.repeat(22)}${B('MISS')} run ${r.run}: ` +
        (r.wroteMemory
          ? `wrote ${r.paths.join(', ')} but it did not carry the instruction — "${note.slice(0, 160)}"`
          : 'no memory write at all') +
        (r.finalText ? `\n${' '.repeat(28)}ended: "${r.finalText.replace(/\s+/g, ' ').slice(0, 200)}"` : ''),
    );
  }

  if (showNotes) {
    for (const r of measured) {
      for (let i = 0; i < (r.paths ?? []).length; i += 1) {
        console.log(`\n${' '.repeat(22)}run ${r.run} → ${B(r.paths[i])}`);
        console.log(
          (r.memoryContent[i] ?? '')
            .split('\n')
            .map((l) => `${' '.repeat(24)}${l}`)
            .join('\n'),
        );
      }
    }
    console.log('');
  }
}

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── THE VERDICT ──────────────────────────────────────────────────────────────
console.log(`\n${B('VERDICT')}`);
if (standingOf === 0) {
  console.log('  no measured standing-instruction runs — nothing to conclude.');
} else {
  const rate = standingPass / standingOf;
  console.log(
    `  standing instructions filed: ${standingPass}/${standingOf} (${(rate * 100).toFixed(0)}%)`,
  );
  // P(this many or more passes | true rate 0.5) — the coin flip this rung waits
  // to rule out. A tail, not a clean-sweep test: see the note at the top.
  const choose = (n, k) => {
    let r = 1;
    for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
    return r;
  };
  let tail = 0;
  for (let k = standingPass; k <= standingOf; k += 1) tail += choose(standingOf, k);
  const p = tail * Math.pow(0.5, standingOf);
  console.log(
    `  If the true rate were the 50% coin flip, ${standingPass}+/${standingOf} would happen ` +
      `with probability ${p < 0.0001 ? p.toExponential(1) : (p * 100).toFixed(2) + '%'}.`,
  );
  if (p < 0.01) {
    console.log('  THE COIN FLIP IS RULED OUT. The doctrine works; what is left is a rate.');
  } else {
    console.log('  The coin flip is NOT ruled out at this sample size — run more.');
  }
  const missed = standingOf - standingPass;
  if (missed > 0) {
    console.log(
      `  But it is not 100%: ${missed} of ${standingOf} standing instruction(s) were lost, and an ` +
        'office message is seen ONCE — nothing re-shows it. Whether that residual is acceptable ' +
        'is the operator\'s call, not this script\'s.',
    );
  }
}
const control = [...byVariant.entries()].filter(([, rs]) => rs[0].kind === 'control');
for (const [id, rs] of control) {
  const measured = rs.filter((r) => r.pass !== null);
  const filed = measured.filter((r) => r.wroteMemory).length;
  console.log(
    `  control (${id}): filed a note in ${filed}/${measured.length} — ` +
      (filed === 0
        ? 'it does not file ordinary traffic.'
        : `it files things that are not standing instructions ${((filed / measured.length) * 100).toFixed(0)}% of the time, ` +
          'which is its own problem: notes that fill with traffic stop being notes.'),
  );
}
if (meta.totalIn !== undefined) {
  const est =
    (meta.totalIn - meta.totalCached) * 0.00000091 +
    meta.totalCached * 0.000000169 +
    meta.totalOut * 0.00000286;
  console.log(
    `\n  ${rows.length} runs · ${meta.totalIn} in (${meta.totalCached} cached) / ${meta.totalOut} out · ≈ $${est.toFixed(2)}`,
  );
}
console.log('');
