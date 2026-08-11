import { execFile, execSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Locks in Box_Setup_Stuff/nemoclaw-inference-medic.sh v3's decision table.
//
// v2's probe (`openshell inference set`) validates endpoint REGISTRATION, not a
// completion — it reported "route OK" through a 12-minute stall (2026-07-28)
// and "FAILOVER active" onto a provider 400-ing every real request
// (2026-08-06). v3 adds a 1-token completion gate through the managed route;
// these tests run the REAL script against PATH shims for `openshell` and
// `docker`, so the table that distinguishes v3 from v2 cannot silently regress:
//
//   registration ok + completion ok       -> healthy (verified, exit 0)
//   registration ok + completion FAIL     -> that provider is DEAD  <- v3's fix
//   both providers dead                   -> exit 1 LOUD            <- v3's fix
//   no container to probe from            -> degrade to v2, exit 0, loud WARN
//
// The shims keep route state in a file: `openshell inference set` records the
// provider (mirroring the real switch), and the fake `docker exec curl` answers
// according to per-provider health flags in env — so the probe genuinely tests
// "whatever route is currently set", exactly like inference.local does.

const SCRIPT = join(process.cwd(), 'Box_Setup_Stuff', 'nemoclaw-inference-medic.sh');

const haveBash = (() => {
  try {
    execSync('command -v bash', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!haveBash)('nemoclaw-inference-medic.sh v3 decision table', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'medic-'));

    // openshell shim: `inference set` succeeds/fails per REG_<PROVIDER> env and
    // records the active route — the completion shim keys off that record.
    await writeFile(
      join(dir, 'openshell'),
      `#!/usr/bin/env bash
provider=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--provider" ]; then provider="$2"; shift; fi
  shift
done
case "$provider" in
  deepinfra-prod) ok="\${REG_DEEPINFRA:-1}" ;;
  nvidia-prod)    ok="\${REG_NVIDIA:-1}" ;;
  *) ok=1 ;;
esac
[ "$ok" = "1" ] || exit 1
echo "$provider" > "\${MEDIC_TEST_STATE}"
exit 0
`,
    );

    // docker shim: `ps` lists a container (or none); `exec ... curl` answers
    // for whichever provider the openshell shim recorded as current — but ONLY
    // when invoked as `-u sandbox` with a LOGIN shell. On the real box the
    // sandbox's egress env is assembled in the sandbox user's login profile;
    // a bare root `docker exec curl` gets an empty reply from a healthy
    // provider (medic v3's first live run declared a false BOTH-DEAD this way,
    // 2026-08-11). The shim reproduces that so the invocation shape is pinned.
    await writeFile(
      join(dir, 'docker'),
      `#!/usr/bin/env bash
if [ "$1" = "ps" ]; then
  [ "\${HAVE_CONTAINER:-1}" = "1" ] && echo "openshell-s6-test"
  exit 0
fi
# docker exec ... — refuse to answer unless run as the sandbox user with a
# login shell, exactly like the real container's egress environment does.
args="$*"
case "$args" in
  *"-u sandbox"*) : ;;
  *) exit 0 ;;   # empty reply, like root's curl on the real box
esac
case "$args" in
  *"sh -lc"*) : ;;
  *) exit 0 ;;   # non-login shell: no egress env, empty reply
esac
current="$(cat "\${MEDIC_TEST_STATE}" 2>/dev/null)"
case "$current" in
  deepinfra-prod) healthy="\${COMPLETION_DEEPINFRA:-1}" ;;
  nvidia-prod)    healthy="\${COMPLETION_NVIDIA:-1}" ;;
  *) healthy=0 ;;
esac
if [ "$healthy" = "1" ]; then
  echo '{"choices":[{"message":{"content":""}}]}'
  exit 0
fi
# The 2026-08-06 shape: a body with no "choices" (e.g. "400 (no body)").
echo '400 (no body)'
exit 0
`,
    );
    await chmod(join(dir, 'openshell'), 0o755);
    await chmod(join(dir, 'docker'), 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(env: Record<string, string>): Promise<RunResult> {
    return new Promise((resolve) => {
      execFile(
        'bash',
        [SCRIPT],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            MEDIC_TEST_STATE: join(dir, 'route-state'),
            MEDIC_PROBE_TIMEOUT: '2',
            ...env,
          },
        },
        (err, stdout, stderr) => {
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
        },
      );
    });
  }

  async function activeRoute(): Promise<string> {
    return (await readFile(join(dir, 'route-state'), 'utf8')).trim();
  }

  it('healthy primary: registration + completion both pass -> verified, exit 0', async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('route OK on primary');
    expect(r.stdout).toContain('completion verified');
    expect(await activeRoute()).toBe('deepinfra-prod');
  });

  it('THE 07-28 STALL: primary registers but completions fail -> fail over (v2 said "route OK")', async () => {
    const r = await run({ COMPLETION_DEEPINFRA: '0' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('failed the 1-token completion probe');
    expect(r.stderr).toContain('FAILOVER active');
    expect(r.stderr).toContain('COMPLETION-VERIFIED');
    expect(await activeRoute()).toBe('nvidia-prod');
  });

  it('THE 08-06 BROKEN FAILOVER: primary dead, fallback registers but 400s -> exit 1 LOUD (v2 claimed success)', async () => {
    const r = await run({ REG_DEEPINFRA: '0', COMPLETION_NVIDIA: '0' });
    expect(r.code).toBe(1);
    // Must NOT claim a working failover — that is the exact lie v3 exists to stop.
    expect(r.stderr).not.toContain('COMPLETION-VERIFIED');
    expect(r.stderr).toContain('BOTH providers failed');
    expect(r.stderr).toContain('DOWN');
  });

  it('402/outage class: primary fails registration, fallback fully healthy -> verified failover', async () => {
    const r = await run({ REG_DEEPINFRA: '0' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('FAILOVER active');
    expect(r.stderr).toContain('COMPLETION-VERIFIED');
    expect(await activeRoute()).toBe('nvidia-prod');
  });

  it('both dead but primary still registers -> route parked on primary, exit 1', async () => {
    const r = await run({ COMPLETION_DEEPINFRA: '0', COMPLETION_NVIDIA: '0' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('route restored to deepinfra-prod');
    expect(await activeRoute()).toBe('deepinfra-prod');
  });

  it('no sandbox container: degrades to v2 semantics (registration only), exit 0 with a WARN', async () => {
    const r = await run({ HAVE_CONTAINER: '0' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('REGISTRATION ONLY');
    expect(r.stderr).toContain('completion gate SKIPPED');
    expect(await activeRoute()).toBe('deepinfra-prod');
  });
});
