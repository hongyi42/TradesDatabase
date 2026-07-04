// Test-environment guard: the suite refuses to start unless both DB URLs point
// at the LOCAL Supabase stack. Exists because a test run against the hosted
// project truncated the live roster on 2026-07-03 (see
// thoughts/shared/research/2026-07-03-test-suite-cleanup-and-live-box-safety.md).
// Pure functions so the guard itself is unit-testable (src/testEnvGuard.test.ts).

// Host-based check, not a substring match: `postgresql://localhost:pw@db.x.supabase.co`
// (username literally "localhost") must NOT count as local. Parsing failures are
// non-local (fail closed). Known limit: a loopback tunnel/port-forward to a remote
// DB is indistinguishable from the local stack — don't run one on 127.0.0.1.
export function isLocalDbUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

export function assertLocalTestEnv(env: Record<string, string | undefined>): void {
  for (const name of ['DATABASE_URL', 'SUPABASE_URL'] as const) {
    if (!isLocalDbUrl(env[name] ?? '')) {
      throw new Error(
        `${name} does not point at the LOCAL Supabase stack. Tests only run against ` +
          `127.0.0.1 (copy .env.test.example to .env.test; values come from ` +
          `\`npx supabase start\`). Refusing to start — this guard exists because a ` +
          `test run truncated the live roster on 2026-07-03.`,
      );
    }
  }
  // An empty key in .env.test would CLOBBER the real one (.env.test loads with
  // override:true) and every DB test would fail with opaque auth errors — catch
  // the copied-but-not-filled .env.test.example case here instead.
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY is empty. Fill it in .env.test with the "Secret" ` +
        `key (sb_secret_...) printed by \`npx supabase start\` (or \`npx supabase status\`).`,
    );
  }
}
