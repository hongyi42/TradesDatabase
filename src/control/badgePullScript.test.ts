import { execFile, execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Locks in Box_Setup_Stuff/badge-pull.sh's post-incident guard (2026-07-03):
// an empty badgesFile must never replace an existing badges.json (non-empty OR
// corrupt) unless ALLOW_EMPTY_BADGES=1. Runs the REAL script (bash + curl + jq)
// against a local stub HTTP server, with its paths redirected into a temp dir
// via the env-overridable constants (ENV_FILE/BADGES_FILE/PENDING_FILE). The
// doorman chown skips naturally here — the script keys it off `id doorman`,
// and this machine has no doorman user.

const SCRIPT = join(process.cwd(), 'Box_Setup_Stuff', 'badge-pull.sh');

// Probe via the default /bin/sh (`command -v` is POSIX) — hardcoding a bash
// path here would skip the whole guard suite on hosts where bash lives
// elsewhere, silently un-testing the post-incident guard.
const haveTools = (() => {
  try {
    execSync('command -v bash jq curl', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const NON_EMPTY = {
  badgesFile: { deadbeef: { tenantId: 't1', technicianRef: 'tech-a', revoked: false } },
  newBadges: [],
};
const EMPTY = { badgesFile: {}, newBadges: [] };

describe.skipIf(!haveTools)('badge-pull.sh empty-file guard', () => {
  let server: Server;
  let baseUrl: string;
  let responseBody = '';
  let dir: string;
  let envFile: string;
  let badgesFile: string;
  let pendingFile: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(responseBody);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server port');
    baseUrl = `http://127.0.0.1:${address.port}/control/badges`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'badge-pull-test-'));
    envFile = join(dir, 'badge-pull.env');
    badgesFile = join(dir, 'badges.json');
    pendingFile = join(dir, 'pending-badges.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeEnvFile(extra = ''): Promise<void> {
    await writeFile(envFile, `PULL_URL=${baseUrl}\nHOST_PULL_TOKEN=test-token\n${extra}`);
  }

  function runScript(
    extraEnv: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        'bash',
        [SCRIPT],
        {
          env: {
            ...process.env,
            ENV_FILE: envFile,
            BADGES_FILE: badgesFile,
            PENDING_FILE: pendingFile,
            ...extraEnv,
          },
        },
        (error, stdout, stderr) => {
          resolve({ code: error ? (error.code as number) ?? 1 : 0, stdout, stderr });
        },
      );
    });
  }

  it('refuses an empty badgesFile over an existing non-empty file', async () => {
    responseBody = JSON.stringify(EMPTY);
    await writeEnvFile();
    const before = JSON.stringify(NON_EMPTY.badgesFile);
    await writeFile(badgesFile, before);
    const result = await runScript();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('REFUSING');
    expect(await readFile(badgesFile, 'utf8')).toBe(before); // last good file untouched
  });

  it('allows a deliberate wipe when ALLOW_EMPTY_BADGES=1 is set in the env file', async () => {
    responseBody = JSON.stringify(EMPTY);
    await writeEnvFile('ALLOW_EMPTY_BADGES=1\n');
    await writeFile(badgesFile, JSON.stringify(NON_EMPTY.badgesFile));
    const result = await runScript();
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(badgesFile, 'utf8'))).toEqual({});
  });

  it('replaces the file normally on a non-empty response', async () => {
    responseBody = JSON.stringify(NON_EMPTY);
    await writeEnvFile();
    await writeFile(badgesFile, '{}');
    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('updated (1 entries)');
    expect(JSON.parse(await readFile(badgesFile, 'utf8'))).toEqual(NON_EMPTY.badgesFile);
  });

  it('does not block first boot: empty response with no existing file exits 0', async () => {
    responseBody = JSON.stringify(EMPTY);
    await writeEnvFile();
    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no change');
    expect(existsSync(badgesFile)).toBe(false);
  });

  it('refuses an empty response over a CORRUPT existing file (fails loud, not silent)', async () => {
    responseBody = JSON.stringify(EMPTY);
    await writeEnvFile();
    const before = 'not json {{{';
    await writeFile(badgesFile, before);
    const result = await runScript();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('REFUSING');
    expect(result.stderr).toContain('corrupt');
    expect(await readFile(badgesFile, 'utf8')).toBe(before);
  });

  it('treats a zero-byte existing file as corrupt (refuses an empty response over it)', async () => {
    responseBody = JSON.stringify(EMPTY);
    await writeEnvFile();
    await writeFile(badgesFile, '');
    const result = await runScript();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('corrupt');
    expect(await readFile(badgesFile, 'utf8')).toBe('');
  });

  // Feature A — the bindings reconcile loop. The real two-write apply
  // (apply-binding.sh) is stubbed here via BIND_APPLY_CMD and covered live on a
  // scratch sandbox; these lock in the loop's diff/state/isolation behavior.
  async function writeApplyStub(): Promise<string> {
    const stub = join(dir, 'apply-stub.sh');
    // Records each call; fails only for a ref matching APPLY_FAIL_REF.
    await writeFile(
      stub,
      '#!/usr/bin/env bash\necho "$1 $2" >> "$APPLY_LOG"\n' +
        'if [ "$1" = "${APPLY_FAIL_REF:-}" ]; then exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    return stub;
  }
  const bindEnv = (stub: string, extra: Record<string, string> = {}) => ({
    BINDINGS_FILE: join(dir, 'bindings-applied.json'),
    BIND_APPLY_CMD: stub,
    APPLY_LOG: join(dir, 'apply.log'),
    ...extra,
  });
  // Bindings ride alongside a badgesFile; an empty one over no existing file is a
  // clean no-op for the badge half, so these isolate the binding behavior.
  const withBindings = (bindings: unknown) =>
    JSON.stringify({ badgesFile: {}, newBadges: [], bindings });

  it('applies a shipped binding, records applied-state, and is idempotent on repeat', async () => {
    await writeEnvFile();
    const stub = await writeApplyStub();
    responseBody = withBindings([{ ref: 'jane', sandboxRef: 's-a', telegramUserId: '111' }]);

    const first = await runScript(bindEnv(stub));
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('bound s-a -> 111');
    expect(await readFile(join(dir, 'apply.log'), 'utf8')).toBe('s-a 111\n');
    expect(JSON.parse(await readFile(join(dir, 'bindings-applied.json'), 'utf8'))).toEqual({
      's-a': '111',
    });

    // Second identical pull: already-applied → no apply call, no state churn.
    const second = await runScript(bindEnv(stub));
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain('bound s-a');
    expect(await readFile(join(dir, 'apply.log'), 'utf8')).toBe('s-a 111\n'); // still one call
  });

  it('re-applies when the shipped id changes for a sandbox', async () => {
    await writeEnvFile();
    const stub = await writeApplyStub();
    responseBody = withBindings([{ ref: 'jane', sandboxRef: 's-a', telegramUserId: '111' }]);
    await runScript(bindEnv(stub));
    responseBody = withBindings([{ ref: 'jane', sandboxRef: 's-a', telegramUserId: '222' }]);
    const rebind = await runScript(bindEnv(stub));
    expect(rebind.code).toBe(0);
    expect(rebind.stdout).toContain('bound s-a -> 222');
    expect(await readFile(join(dir, 'apply.log'), 'utf8')).toBe('s-a 111\ns-a 222\n');
    expect(JSON.parse(await readFile(join(dir, 'bindings-applied.json'), 'utf8'))).toEqual({
      's-a': '222',
    });
  });

  it('isolates a failing apply: its entry is not recorded and the unit exits nonzero', async () => {
    await writeEnvFile();
    const stub = await writeApplyStub();
    responseBody = withBindings([
      { ref: 'a', sandboxRef: 's-a', telegramUserId: '111' },
      { ref: 'bad', sandboxRef: 's-bad', telegramUserId: '999' },
    ]);
    const result = await runScript(bindEnv(stub, { APPLY_FAIL_REF: 's-bad' }));
    expect(result.code).not.toBe(0); // failure is visible on the unit
    expect(result.stderr).toContain('FAILED to bind s-bad');
    // The good one persisted; the failed one is absent → it retries next tick.
    expect(JSON.parse(await readFile(join(dir, 'bindings-applied.json'), 'utf8'))).toEqual({
      's-a': '111',
    });
  });

  it('treats an absent bindings key as a no-op (old server, no apply, no state file)', async () => {
    await writeEnvFile();
    const stub = await writeApplyStub();
    responseBody = JSON.stringify(EMPTY); // no `bindings` key at all
    const result = await runScript(bindEnv(stub));
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, 'apply.log'))).toBe(false); // apply never invoked
    expect(existsSync(join(dir, 'bindings-applied.json'))).toBe(false);
  });
});
