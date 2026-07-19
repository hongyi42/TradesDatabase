// Standalone smoke test for the Architecture A central HTTP MCP server.
//
// Two modes:
//   node scripts/smoke-http.mjs
//       In-process: starts the REAL httpServer (createHttpServer) on an ephemeral
//       localhost port and generates a per-run GATEWAY_IDENTITY_SECRET. Proves the
//       server code + write-path without any deploy.
//   node scripts/smoke-http.mjs https://<name>.onrender.com
//       Remote: drives an already-deployed server. Requires GATEWAY_IDENTITY_SECRET
//       in env set to the SAME value as the deployed server (so the signature
//       matches). Proves the deployed server + secret + DB BEFORE wiring the gateway.
//
// Either mode: signs the gateway identity header itself and drives the server with
// the MCP SDK client — Streamable HTTP transport + HMAC identity (valid + tampered)
// + tenant-scoped write-path (L1 → extract → match → L2) + DB read-back.
//
// Writes target the TEST Supabase project only (reads SUPABASE_* from .env). L2 rows
// it creates are cleaned up; the one L1 raw_capture is append-only (left in place).
// Build first: `npm run build`. ANTHROPIC_API_KEY must be set (real extractor runs).

import 'dotenv/config';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../dist/mcp/httpServer.js';
import { getClient } from '../dist/db/index.js';

const TECH = 'tech-smoke';
const remoteUrl = process.argv[2]; // optional: smoke a deployed server instead of in-process
let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  failures++;
};

// Remote mode can't invent a secret — it must match the deployed server's.
if (remoteUrl && !process.env.GATEWAY_IDENTITY_SECRET) {
  console.error(
    'Remote mode needs GATEWAY_IDENTITY_SECRET set to the SAME value as the deployed server.',
  );
  process.exit(1);
}
const secret = process.env.GATEWAY_IDENTITY_SECRET || randomBytes(32).toString('hex');
process.env.GATEWAY_IDENTITY_SECRET = secret;

const sign = (tenantId, tech) =>
  createHmac('sha256', secret).update(`${tenantId}.${tech}`).digest('hex');

const transportFor = (url, headers) =>
  new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });

async function main() {
  const { data: t, error: te } = await getClient()
    .from('tenants')
    .select('id,name')
    .limit(1)
    .single();
  if (te || !t) throw new Error(`could not load seed tenant: ${te?.message ?? 'none'}`);
  const tenantId = t.id;
  console.log(`Tenant: ${t.name} (${tenantId})`);

  let server;
  let url;
  if (remoteUrl) {
    url = remoteUrl.replace(/\/$/, '');
    console.log(`Server: ${url} (remote)\n`);
  } else {
    server = createHttpServer();
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    url = `http://127.0.0.1:${server.address().port}`;
    console.log(`Server: ${url} (in-process)\n`);
  }

  const goodHeaders = {
    'x-tenant-id': tenantId,
    'x-technician-ref': TECH,
    'x-identity-signature': sign(tenantId, TECH),
  };

  let captureId;
  let createdCustomerId;
  const marker = `smoke-${randomBytes(4).toString('hex')}`;

  const c1 = new Client({ name: 'smoke', version: '0.0.0' });
  try {
    // 1. Valid signature → tools/list returns the technician surface
    // (14 since 2026-07-17; an active-manager ref would list 25).
    console.log('1) valid signature → tools/list');
    await c1.connect(transportFor(url, goodHeaders));
    const { tools } = await c1.listTools();
    tools.length === 14
      ? ok(`tools/list returned ${tools.length} tools`)
      : bad(`expected 14 tools, got ${tools.length}: ${tools.map((x) => x.name).join(',')}`);

    // 2. Tampered signature → rejected (401), connection never established.
    console.log('2) tampered signature → rejected');
    let rejected = false;
    try {
      const cBad = new Client({ name: 'smoke-bad', version: '0.0.0' });
      await cBad.connect(
        transportFor(url, { ...goodHeaders, 'x-identity-signature': 'deadbeef'.repeat(8) }),
      );
      await cBad.listTools();
    } catch {
      rejected = true;
    }
    rejected ? ok('tampered signature rejected') : bad('tampered signature was NOT rejected');

    // 3. Write: record a field note (L1 append + real extraction + identity match).
    console.log('3) record_field_note (write → L1)');
    const phone = `555-${String(randomInt(1000, 9999))}`;
    const noteText = `Smoke ${marker} — AC not cooling at 123 Test Street. Replaced capacitor. Phone ${phone}.`;
    const r1 = await c1.callTool({
      name: 'record_field_note',
      arguments: { text: noteText, channel: 'technician_note' },
    });
    if (r1.isError) {
      bad(`record_field_note errored: ${r1.content?.[0]?.text}`);
    } else {
      const d1 = JSON.parse(r1.content[0].text);
      captureId = d1.captureId;
      ok(`first call status=${d1.status}, captureId=${captureId?.slice(0, 8)}…`);

      // 4. Resume with a confirmed address → creates L2 (customer/job/visit).
      console.log('4) resume w/ confirmed address → L2');
      const r2 = await c1.callTool({
        name: 'record_field_note',
        arguments: { captureId, confirmed: { address: '123 Test Street' } },
      });
      if (r2.isError) {
        bad(`resume errored: ${r2.content?.[0]?.text}`);
      } else {
        const d2 = JSON.parse(r2.content[0].text);
        createdCustomerId = d2.customerId;
        d2.status === 'matched' && d2.customerId && d2.jobId && d2.visitId
          ? ok(
              `L2 created: customer=${d2.customerId.slice(0, 8)}… job=${d2.jobId.slice(0, 8)}… visit=${d2.visitId.slice(0, 8)}…`,
            )
          : bad(`resume did not produce full L2: ${JSON.stringify(d2)}`);
      }
    }

    // 5. Cross-channel read-back over the service-role DB client.
    console.log('5) DB read-back');
    const db = getClient();
    const { data: caps } = await db
      .from('raw_captures')
      .select('id,channel,raw_text')
      .eq('tenant_id', tenantId)
      .ilike('raw_text', `%${marker}%`);
    caps?.length >= 1
      ? ok(`L1 raw_capture exists (channel=${caps[0].channel})`)
      : bad('no L1 raw_capture found for marker');

    if (captureId) {
      const { data: visits } = await db
        .from('visits')
        .select('id,technician_name,source_capture_id')
        .eq('tenant_id', tenantId)
        .eq('source_capture_id', captureId);
      const v = visits?.[0];
      v && v.technician_name === TECH
        ? ok(`L2 visit links to L1 via source_capture_id; technician_name='${v.technician_name}' (from signed header, not args)`)
        : bad('no L2 visit linked to the capture, or technician_name mismatch');
    }
  } finally {
    await c1.close().catch(() => {});
    // Cleanup: delete the created customer (cascades to its job + visit; the L1
    // capture's customer_id is set null). L1 is append-only — cannot be deleted.
    if (createdCustomerId) {
      const { error } = await getClient().from('customers').delete().eq('id', createdCustomerId);
      console.log(
        error
          ? `\n  ⚠️ cleanup failed: ${error.message}`
          : `\n  🧹 cleaned up L2 customer ${createdCustomerId.slice(0, 8)}… (cascade); L1 capture left (append-only)`,
      );
    }
    if (server) server.close();
  }

  console.log(`\n${failures === 0 ? '✅ SMOKE PASSED' : `❌ SMOKE FAILED (${failures} check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥', err);
  process.exit(1);
});
