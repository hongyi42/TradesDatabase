import { execFile, execSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Locks in Box_Setup_Stuff/nemoclaw-inference-medic.sh's decision table (v6).
//
// Four generations of blind spot, each pinned here so it cannot come back:
//  - v2 probed with `openshell inference set`, which validates endpoint
//    REGISTRATION, not a completion. It reported "route OK" through a 12-minute
//    stall (2026-07-28).
//  - v3 added a completion gate but asked for `"hi"` with max_tokens:1. A
//    provider that 400s every real turn served that happily (2026-08-06, and
//    six more times on 2026-08-12).
//  - v5 removed the automatic failover — it was never a decision, and its
//    target had never been verified. An unverified fallback is worse than none.
//  - v6 (2026-09-05, the OpenRouter switch): the second lane moved to an
//    OpenRouter PRESET, chained per request by the vendor. The medic still
//    NEVER reroutes; it now also (a) checks the key's balance every tick for
//    free — money is what actually killed the fleet, and no fallback survives
//    it; (b) probes hourly, stamping the cadence ONLY on a pass, so a "skipped"
//    tick can never exit 0 and close an open incident while the fleet is down;
//    (c) logs which lane served, and never mistakes a stripped field for an
//    outage; (d) probes the fallback lane directly, daily, so it stays verified.
//
//   balance low / key 401            -> route held, exit 1 LOUD
//   registration fails               -> exit 1 LOUD
//   probe due, misses twice          -> route held, exit 1 LOUD
//   probe passes (any lane)          -> exit 0 (+ LOUD warn off the primary)
//   probe not due                    -> exit 0, "probe skipped"
//   no container to probe from       -> registration only, exit 0 + WARN
//   fallback probe misses            -> WARN only
//   ...and the route is NEVER set to anything but the primary.
//
// The shims keep route state in a file: `openshell inference set` records the
// provider, the fake `docker exec curl` answers according to that route and
// per-lane health flags in env, and the fake host `curl` answers the OpenRouter
// account calls and the direct fallback probe.

const SCRIPT = join(process.cwd(), 'Box_Setup_Stuff', 'nemoclaw-inference-medic.sh');
const FAKE_KEY = 'sk-or-v1-test-key-that-must-never-appear-in-argv';

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

describe.skipIf(!haveBash)('nemoclaw-inference-medic.sh decision table (v6)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'medic-'));

    // openshell shim: `inference set` succeeds/fails per REG_OPENROUTER and
    // records the active route — the completion shim keys off that record.
    // Every argv is appended to a file so the test can prove --no-verify rides.
    await writeFile(
      join(dir, 'openshell'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${MEDIC_TEST_STATE}.openshell-args"
provider=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--provider" ]; then provider="$2"; shift; fi
  shift
done
case "$provider" in
  openrouter-prod) ok="\${REG_OPENROUTER:-1}" ;;
  *) ok=1 ;;
esac
[ "$ok" = "1" ] || exit 1
echo "$provider" > "\${MEDIC_TEST_STATE}"
exit 0
`,
    );

    // docker shim: `ps` lists a container (or none); `exec ... curl` answers
    // for the route the openshell shim recorded — but ONLY when invoked as
    // `-u sandbox` with a LOGIN shell (the real container's egress env is
    // assembled in the sandbox user's login profile; medic v3's first live
    // run declared a false both-dead this way, 2026-08-11).
    await writeFile(
      join(dir, 'docker'),
      `#!/usr/bin/env bash
if [ "$1" = "ps" ]; then
  [ "\${HAVE_CONTAINER:-1}" = "1" ] && echo "openshell-s6-test"
  exit 0
fi
args="$*"
case "$args" in *"-u sandbox"*) : ;; *) exit 0 ;; esac
case "$args" in *"sh -lc"*) : ;; *) exit 0 ;; esac
case "$args" in *"@-"*) cat >/dev/null 2>&1 || true ;; esac
current="$(cat "\${MEDIC_TEST_STATE}" 2>/dev/null)"
[ "$current" = "openrouter-prod" ] && healthy="\${COMPLETION_PRIMARY:-1}" || healthy=0

# "flaky" = miss once, then serve.
if [ "$healthy" = "flaky" ]; then
  n="\${MEDIC_TEST_STATE}.attempts"
  count="$(cat "$n" 2>/dev/null || echo 0)"
  echo $((count + 1)) > "$n"
  [ "$count" = "0" ] && { echo '400 (no body)'; exit 0; }
  healthy=1
fi

emit_tool_call() { # model-json-fragment ("" for none)
  printf '%s\\n' "data: {$1\\"choices\\":[{\\"index\\":0,\\"delta\\":{\\"role\\":\\"assistant\\"},\\"finish_reason\\":null}]}"
  printf '%s\\n' "data: {$1\\"choices\\":[{\\"index\\":0,\\"delta\\":{\\"tool_calls\\":[{\\"id\\":\\"c1\\",\\"type\\":\\"function\\",\\"function\\":{\\"name\\":\\"resolve_date\\",\\"arguments\\":\\"{}\\"}}]},\\"finish_reason\\":\\"tool_calls\\"}]}"
  printf '%s\\n' 'data: [DONE]'
}
case "$healthy" in
  1)          emit_tool_call "\\"model\\":\\"google/gemini-3.8-flash\\","; exit 0 ;;
  fallback)   emit_tool_call "\\"model\\":\\"meta/muse-spark-1.3\\","; exit 0 ;;
  nomodel)    emit_tool_call ""; exit 0 ;;
  presetslug) emit_tool_call "\\"model\\":\\"@preset/trades-seats\\","; exit 0 ;;
  prose)
    printf '%s\\n' 'data: {"model":"google/gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"This coming Friday is the 14th."},"finish_reason":null}]}'
    printf '%s\\n' 'data: {"model":"google/gemini-3.8-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
    printf '%s\\n' 'data: [DONE]'; exit 0 ;;
  truncated)
    printf '%s\\n' 'data: {"model":"google/gemini-3.8-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}'
    printf '%s\\n' 'data: {"model":"google/gemini-3.8-flash","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}'
    exit 0 ;;
esac
echo '400 (no body)'
exit 0
`,
    );

    // host curl shim: the OpenRouter account calls and the direct fallback
    // probe. Records argv so the test can prove the key never appears in it
    // (the real script passes the Authorization header via -K on a fd).
    await writeFile(
      join(dir, 'curl'),
      `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "\${MEDIC_TEST_STATE}.curl-args"
# Read stdin ONLY when the script pipes a body; the account calls pipe nothing,
# and the test runner's stdin never closes.
case "$args" in *"@-"*) cat >/dev/null 2>&1 || true ;; esac
url=""; for a in "$@"; do case "$a" in http*://*) url="$a" ;; esac; done
want_code=0; case "$args" in *" -w "*) want_code=1 ;; esac
emit() { printf '%s' "$1"; [ "$want_code" = 1 ] && printf '\\n%s' "$2"; echo; }
case "$url" in
  */api/v1/key)
    lr="\${KEY_REMAINING-25}"; [ "$lr" = "null" ] && v=null || v="$lr"
    emit "{\\"data\\":{\\"limit\\":30,\\"limit_remaining\\":$v}}" "\${KEY_HTTP:-200}" ;;
  */api/v1/credits)
    emit "{\\"data\\":{\\"total_credits\\":\${CREDITS_REMAINING:-30},\\"total_usage\\":0}}" "\${CREDITS_HTTP:-200}" ;;
  */chat/completions)
    case "\${COMPLETION_FALLBACK:-1}" in
      1) printf '%s\\n' 'data: {"model":"meta/muse-spark-1.3","choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","type":"function","function":{"name":"resolve_date","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}'
         printf '%s\\n' 'data: [DONE]' ;;
      *) echo '400 (no body)' ;;
    esac ;;
  *) exit 1 ;;
esac
exit 0
`,
    );
    for (const f of ['openshell', 'docker', 'curl']) await chmod(join(dir, f), 0o755);
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
            MEDIC_STATE_DIR: join(dir, 'state'),
            MEDIC_PROBE_INTERVAL: '0',
            MEDIC_FALLBACK_INTERVAL: '0',
            MEDIC_PROBE_TIMEOUT: '2',
            MEDIC_RETRY_SLEEP: '0',
            OPENROUTER_API_KEY: FAKE_KEY,
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

  it('healthy: balance ok + registration + tool call from the primary -> verified, exit 0', async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    // The balance line names BOTH sources, so a half-missing watch is visible.
    expect(r.stdout).toMatch(/balance ok — 25\.00 USD remaining \(floor 2\.00; key:25\.00 credits:30\.00\)/);
    expect(r.stdout).toContain('route OK on openrouter-prod / @preset/trades-seats');
    expect(r.stdout).toContain('serving verified');
    expect(r.stdout).toContain('served=google/gemini-3.8-flash');
    expect(r.stderr).not.toContain('PRIMARY NOT SERVING');
    expect(await activeRoute()).toBe('openrouter-prod');
    // --no-verify rides every assertion: a @preset/ id is not a listed model.
    const args = await readFile(join(dir, 'route-state.openshell-args'), 'utf8');
    expect(args).toContain('--no-verify');
  });

  it('the fallback lane is serving -> agents answer (exit 0) but it is said LOUDLY', async () => {
    const r = await run({ COMPLETION_PRIMARY: 'fallback' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('served=meta/muse-spark-1.3');
    expect(r.stderr).toContain('PRIMARY NOT SERVING');
    expect(await activeRoute()).toBe('openrouter-prod');
  });

  it('a stripped model field, or the literal preset slug, is unknown — never an alarm', async () => {
    for (const variant of ['nomodel', 'presetslug']) {
      const r = await run({ COMPLETION_PRIMARY: variant });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('served=unknown');
      expect(r.stdout).toContain('serving verified');
      expect(r.stderr).not.toContain('PRIMARY NOT SERVING');
    }
  }, 20_000);

  it('THE 09-04 SHAPE: balance below the floor -> exit 1 LOUD, route held, no paid probe', async () => {
    const r = await run({ KEY_REMAINING: 'null', CREDITS_REMAINING: '1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('BALANCE');
    expect(r.stderr).toContain('AGENTS ARE DOWN');
    expect(r.stdout).not.toContain('serving verified');
    expect(await activeRoute()).toBe('openrouter-prod');
  });

  it('key limit lifted (null) and the credits call unavailable -> NO BALANCE WATCH, loud, but not an outage', async () => {
    const r = await run({ KEY_REMAINING: 'null', CREDITS_HTTP: '403' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('NO BALANCE WATCH');
    expect(r.stderr).toContain('key:null credits:http403');
    expect(r.stdout).toContain('serving verified');
  });

  it('half a watch is said out loud: credits 403 but the key limit answers -> ok, sources named', async () => {
    const r = await run({ CREDITS_HTTP: '403' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('balance ok — 25.00 USD remaining (floor 2.00; key:25.00 credits:http403)');
  });

  it('key rejected (401) -> exit 1 LOUD', async () => {
    const r = await run({ KEY_HTTP: '401' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('KEY REJECTED');
    expect(r.stderr).toContain('AGENTS ARE DOWN');
  });

  it('registration fails -> exit 1 LOUD', async () => {
    const r = await run({ REG_OPENROUTER: '0' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('failed REGISTRATION');
    expect(r.stderr).toContain('AGENTS ARE DOWN');
  });

  it('THE 07-28 STALL: registers but completions fail twice -> exit 1 LOUD, route HELD', async () => {
    const r = await run({ COMPLETION_PRIMARY: '0' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('failed the tool-call completion probe TWICE');
    expect(r.stderr).toContain('IS NOT SERVING');
    expect(r.stderr).toContain('AGENTS ARE DOWN');
    expect(await activeRoute()).toBe('openrouter-prod');
  });

  it('a MISS is never stamped: the next tick inside the interval probes again (and stays down)', async () => {
    const first = await run({ COMPLETION_PRIMARY: '0', MEDIC_PROBE_INTERVAL: '3600' });
    expect(first.code).toBe(1);
    const second = await run({ COMPLETION_PRIMARY: '0', MEDIC_PROBE_INTERVAL: '3600' });
    expect(second.code).toBe(1);
    expect(second.stdout).not.toContain('probe skipped');
    expect(second.stderr).toContain('IS NOT SERVING');
  }, 20_000);

  it('a PASS is stamped: the next tick inside the interval skips the paid probe, exit 0', async () => {
    const first = await run({ MEDIC_PROBE_INTERVAL: '3600' });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('serving verified');
    const second = await run({ MEDIC_PROBE_INTERVAL: '3600' });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('probe skipped');
    expect(second.stdout).not.toContain('serving verified');
    expect(await activeRoute()).toBe('openrouter-prod');
  }, 20_000);

  it('THE v3 BLIND SPOT: prose with no tool call -> NOT serving', async () => {
    const r = await run({ COMPLETION_PRIMARY: 'prose' });
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('serving verified');
    expect(r.stderr).toContain('IS NOT SERVING');
  });

  it('stream dies mid-flight (tool call started, no [DONE]) -> NOT serving', async () => {
    const r = await run({ COMPLETION_PRIMARY: 'truncated' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('IS NOT SERVING');
  });

  it('ONE slow probe does not raise a false alarm: miss then pass -> healthy', async () => {
    const r = await run({ COMPLETION_PRIMARY: 'flaky' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('passed the completion probe on retry');
    expect(r.stdout).toContain('serving verified');
    expect(r.stderr).not.toContain('AGENTS ARE DOWN');
  });

  it('no sandbox container: registration only, exit 0 with a WARN', async () => {
    const r = await run({ HAVE_CONTAINER: '0' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('REGISTRATION ONLY');
    expect(r.stderr).toContain('completion gate SKIPPED');
    expect(await activeRoute()).toBe('openrouter-prod');
  });

  it('the fallback lane failing its own probe is a WARN, never an outage', async () => {
    const r = await run({ COMPLETION_FALLBACK: '0' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('serving verified');
    expect(r.stderr).toContain('FALLBACK');
    expect(r.stderr).toContain('no verified second lane');
  });

  it('the fallback lane passing is logged with its served model', async () => {
    const r = await run({});
    expect(r.stdout).toContain('fallback lane verified');
    expect(r.stdout).toContain('served=meta/muse-spark-1.3');
  });

  // The v5 invariant, kept: whatever fails, the route is only ever the primary.
  it('NEVER routes anywhere but openrouter-prod, whatever fails', async () => {
    const cases: Record<string, string>[] = [
      { COMPLETION_PRIMARY: '0' },
      { COMPLETION_PRIMARY: 'prose' },
      { COMPLETION_PRIMARY: 'fallback' },
      { KEY_REMAINING: 'null', CREDITS_REMAINING: '1' },
      {},
    ];
    for (const env of cases) {
      await run(env);
      expect(await activeRoute()).toBe('openrouter-prod');
    }
  }, 40_000);

  it('never mentions a retired provider or a failover', async () => {
    const cases: Record<string, string>[] = [{}, { COMPLETION_PRIMARY: '0' }, { COMPLETION_PRIMARY: 'fallback' }];
    for (const env of cases) {
      const r = await run(env);
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/fireworks|deepinfra|nvidia|FAILOVER/i);
    }
  }, 30_000);

  it('the key never appears in any argv or in the journal: the Authorization header rides via -K', async () => {
    const r = await run({});
    expect(`${r.stdout}${r.stderr}`).not.toContain(FAKE_KEY);
    const curlArgs = await readFile(join(dir, 'route-state.curl-args'), 'utf8');
    expect(curlArgs).not.toContain(FAKE_KEY);
    expect(curlArgs).toContain('-K');
    const openshellArgs = await readFile(join(dir, 'route-state.openshell-args'), 'utf8');
    expect(openshellArgs).not.toContain(FAKE_KEY);
  });
});
