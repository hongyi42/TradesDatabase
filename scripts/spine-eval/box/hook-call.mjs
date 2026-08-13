// Runs INSIDE the sandbox, in the GATEWAY's network namespace.
//
// Why it lives in the sandbox rather than on a laptop: the openclaw gateway
// listens on 18789 inside a NESTED network namespace. `docker exec` does not
// enter it (from there, nothing is listening on 18789 at all) — only
// `nemoclaw <s> exec` lands in the right namespace. So the HTTP call has to
// originate here.
//
// Second reason, equally deliberate: the `hooks` token stays on the box. This
// script reads it out of the on-disk config at call time, so the token never
// crosses an ssh boundary, never appears in a driver's argv, and never lands on
// a developer's machine.
//
//   node hook-call.mjs <base64-of-json-payload>
//
// The payload is base64 so no scenario text can be mangled by the three layers
// of shell quoting between here and a laptop (ssh → nemoclaw exec → bash -lc) —
// the same reason scripts/date-eval/run.mjs base64s its questions.
//
// Prints ONE line of JSON: { status, ms, body }. `status` is the ADMISSION
// result, not the run result — /hooks/agent returns when the runner is admitted
// (15s deadline), so the reply itself is collected later from the session
// transcript. Documented codes: 200 admitted, 400 bad delivery coordinates,
// 409 session admission conflict, 502 preparation failure, 503 admission
// deadline exceeded.
import { readFileSync } from 'node:fs';

const CONFIG = '/sandbox/.openclaw/openclaw.json';

function fail(error, extra = {}) {
  console.log(JSON.stringify({ status: 0, ms: 0, error, ...extra }));
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
} catch (err) {
  fail(`cannot read ${CONFIG}: ${err.message}`);
}

const hooks = cfg.hooks;
if (!hooks || hooks.enabled !== true) {
  fail('hooks is not enabled in openclaw.json — enable it with the gateway-mediated recipe');
}
if (!hooks.token) fail('hooks.enabled is true but hooks.token is empty');

// gateway.port has DRIFTED before (18790/18793 against a real 18789), which sent
// OpenClaw's own loopback fallback at a dead port. Read it rather than assume,
// and say which port was tried when the connection fails.
const port = cfg.gateway?.port ?? 18789;
const base = hooks.path && hooks.path !== '/' ? hooks.path : '/hooks';

const raw = process.argv[2];
if (!raw) fail('usage: node hook-call.mjs <base64-of-json-payload>');

let payload;
try {
  payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
} catch (err) {
  fail(`payload is not base64-encoded JSON: ${err.message}`);
}

const url = `http://127.0.0.1:${port}${base}/agent`;
const started = Date.now();
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Header auth only — query-string tokens are rejected by the gateway.
      authorization: `Bearer ${hooks.token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log(JSON.stringify({ status: res.status, ms: Date.now() - started, body: body.slice(0, 4000) }));
} catch (err) {
  fail(`POST ${url} failed: ${err.message}`, { ms: Date.now() - started });
}
