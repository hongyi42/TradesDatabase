// Suggest the closest roster ref for a sheet value that matched nothing — turns
// a dead-matching typo into a one-tap manager fix ("row says 'tehc-jane', did
// you mean 'tech-jane'?"). Case-insensitive Levenshtein; a suggestion requires
// distance ≤ 2 — beyond that a guess is likelier to mislead than help (and a
// genuinely ambiguous short name like 'jane' vs jane-doe/jane-smith stays
// unsuggested rather than silently picking a Jane).

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

export function closestRef(bad: string, refs: string[]): string | null {
  const target = bad.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  let tied = false;
  for (const ref of refs) {
    const d = levenshtein(target, ref.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = ref;
      tied = false;
    } else if (d === bestDistance) {
      tied = true;
    }
  }
  // A tie within the threshold is genuinely ambiguous (two refs equally close):
  // suggesting the first-encountered one would one-tap the manager into the
  // wrong person — return no suggestion instead.
  return bestDistance <= 2 && !tied ? best : null;
}
