import { execFile, execSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Locks in Box_Setup_Stuff/nemoclaw-inference-medic.sh's decision table.
//
// Three generations of blind spot, each pinned here so it cannot come back:
//  - v2 probed with `openshell inference set`, which validates endpoint
//    REGISTRATION, not a completion. It reported "route OK" through a 12-minute
//    stall (2026-07-28).
//  - v3 added a completion gate but asked for `"hi"` with max_tokens:1. A
//    provider that 400s every real turn served that happily, so the medic logged
//    "FAILOVER active — COMPLETION-VERIFIED" over a hard outage (2026-08-06,
//    and six more times on 2026-08-12).
//  - v5 removed the fallback entirely. It was never a product decision: nvidia
//    was the ORIGINAL provider, kept as a manual rollback at the 07-06 DeepInfra
//    swap, then wired up as an automatic failover target by v2 on 07-11 without
//    anyone verifying it still served. An unverified fallback is worse than
//    none — it fails exactly when depended on, and reports success doing it.
//
// 2026-08-15: the primary flipped to fireworks-prod (GLM-5.2 fast router);
// deepinfra-prod is now the lingering MANUAL rollback, exactly the position
// nvidia-prod held in July — so the no-fallback test below bans it from the
// medic's output the same way.
//
//   registration ok + completion ok       -> serving (exit 0)
//   registration ok + completion FAIL     -> exit 1 LOUD, route HELD on primary
//   registration FAIL                     -> exit 1 LOUD
//   no container to probe from            -> registration only, exit 0 + WARN
//   ...and the route is NEVER set to anything but the primary.
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

describe.skipIf(!haveBash)('nemoclaw-inference-medic.sh decision table', () => {
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
  fireworks-prod) ok="\${REG_FIREWORKS:-1}" ;;
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
  fireworks-prod) healthy="\${COMPLETION_FIREWORKS:-1}" ;;
  deepinfra-prod) healthy="\${COMPLETION_DEEPINFRA:-1}" ;;
  nvidia-prod)    healthy="\${COMPLETION_NVIDIA:-1}" ;;
  *) healthy=0 ;;
esac

# "flaky" = miss once, then serve. Proves the v4 retry absorbs a single slow
# probe instead of flapping the whole fleet to the fallback.
if [ "$healthy" = "flaky" ]; then
  n="\${MEDIC_TEST_STATE}.attempts-$current"
  count="$(cat "$n" 2>/dev/null || echo 0)"
  echo $((count + 1)) > "$n"
  [ "$count" = "0" ] && { echo '400 (no body)'; exit 0; }
  healthy=1
fi

if [ "$healthy" = "1" ]; then
  # v4 shape: a streamed completion that ENDS IN A TOOL CALL. Anything less is
  # not evidence the provider can serve an agent turn.
  printf '%s\\n' 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}'
  printf '%s\\n' 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","type":"function","function":{"name":"resolve_date","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}'
  printf '%s\\n' 'data: [DONE]'
  exit 0
fi

# "prose" = a perfectly valid completion that never calls a tool. This is the
# v3 blind spot: "choices" is present, so v3 called it healthy. A provider whose
# model will not emit tool calls cannot serve this product.
if [ "$healthy" = "prose" ]; then
  printf '%s\\n' 'data: {"choices":[{"index":0,"delta":{"content":"This coming Friday is the 14th."},"finish_reason":null}]}'
  printf '%s\\n' 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
  printf '%s\\n' 'data: [DONE]'
  exit 0
fi

# "truncated" = the stream dies mid-flight: tool call started, no [DONE].
if [ "$healthy" = "truncated" ]; then
  printf '%s\\n' 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}'
  printf '%s\\n' 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}'
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
            MEDIC_RETRY_SLEEP: '0', // the retry's real 2s pause would just slow the suite
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
    expect(r.stdout).toContain('route OK on fireworks-prod');
    expect(r.stdout).toContain('serving verified');
    expect(await activeRoute()).toBe('fireworks-prod');
  });

  it('THE 07-28 STALL: registers but completions fail -> exit 1 LOUD (v2 said "route OK")', async () => {
    const r = await run({ COMPLETION_FIREWORKS: '0' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('failed the tool-call completion probe TWICE');
    expect(r.stderr).toContain('IS NOT SERVING');
    expect(r.stderr).toContain('AGENTS ARE DOWN');
    // The route is HELD, not moved — a recovery is then picked up immediately.
    expect(await activeRoute()).toBe('fireworks-prod');
  });

  it('402/outage class: registration itself fails -> exit 1 LOUD', async () => {
    const r = await run({ REG_FIREWORKS: '0' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('failed REGISTRATION');
    expect(r.stderr).toContain('AGENTS ARE DOWN');
  });

  // The v5 invariant. nvidia-prod became a failover target by accident, not by
  // decision, and 400'd every real turn for days while the medic logged success.
  // If a fallback is ever added back it must be a deliberate change that also
  // changes this test — never something that quietly reappears.
  it('NEVER routes anywhere but the primary, whatever fails', async () => {
    const cases: Record<string, string>[] = [
      { COMPLETION_FIREWORKS: '0' },
      { COMPLETION_FIREWORKS: 'prose' },
      { COMPLETION_FIREWORKS: 'truncated' },
      {}, // healthy
    ];
    for (const env of cases) {
      await run(env);
      expect(await activeRoute()).toBe('fireworks-prod');
    }
  });

  it('never claims a failover happened, and never mentions a fallback provider', async () => {
    const r = await run({ COMPLETION_FIREWORKS: '0' });
    expect(r.stderr).not.toContain('FAILOVER');
    expect(r.stderr).not.toContain('COMPLETION-VERIFIED');
    // Both lingering rollback providers: nvidia (July's trap) and now deepinfra
    // (the 08-15 swap's manual rollback). Neither may appear in medic output.
    expect(`${r.stdout}${r.stderr}`).not.toContain('nvidia');
    expect(`${r.stdout}${r.stderr}`).not.toContain('deepinfra');
  });

  // ── v4: the probe has to look like a TURN ──────────────────────────────────
  // v3 probed `"hi"` with max_tokens:1 and passed on any body containing
  // "choices". nvidia-prod served that while 400-ing every real turn, so the
  // medic logged "FAILOVER active — COMPLETION-VERIFIED" over a hard outage
  // (six events on 2026-08-12). These pin the stronger gate.

  it('THE v3 BLIND SPOT: returns prose and never emits a tool call -> NOT serving', async () => {
    const r = await run({ COMPLETION_FIREWORKS: 'prose' });
    expect(r.code).toBe(1);
    // v3's gate ("choices" present) would have called this healthy and green.
    expect(r.stdout).not.toContain('serving verified');
    expect(r.stderr).toContain('failed the tool-call completion probe TWICE');
    expect(r.stderr).toContain('IS NOT SERVING');
  });

  it('stream dies mid-flight (tool call started, no [DONE]) -> NOT serving', async () => {
    const r = await run({ COMPLETION_FIREWORKS: 'truncated' });
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('serving verified');
    expect(r.stderr).toContain('IS NOT SERVING');
  });

  it('ONE slow probe does not raise a false alarm: miss then pass -> healthy', async () => {
    const r = await run({ COMPLETION_FIREWORKS: 'flaky' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('passed the completion probe on retry');
    expect(r.stdout).toContain('serving verified');
    expect(r.stderr).not.toContain('AGENTS ARE DOWN');
    expect(await activeRoute()).toBe('fireworks-prod');
  });

  it('no sandbox container: degrades to v2 semantics (registration only), exit 0 with a WARN', async () => {
    const r = await run({ HAVE_CONTAINER: '0' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('REGISTRATION ONLY');
    expect(r.stderr).toContain('completion gate SKIPPED');
    expect(await activeRoute()).toBe('fireworks-prod');
  });
});
