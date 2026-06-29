// Offline check: recompute the Composio signature over a captured request
// (inbound-last.json, written by httpServer when INBOUND_DEBUG=1) and compare to the
// header. Direct HMAC compare so it works regardless of how old the capture is (the
// live verifier's replay window would reject a stale capture even with a valid sig).

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const file = process.env.INBOUND_DEBUG_FILE ?? 'inbound-last.json';
const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
if (!secret) {
  console.error('COMPOSIO_WEBHOOK_SECRET not set');
  process.exit(1);
}
const f = JSON.parse(readFileSync(file, 'utf8'));
const received = (Array.isArray(f.signature) ? f.signature[0] : f.signature) ?? '';

const expected = createHmac('sha256', secret).update(`${f.id}.${f.timestamp}.${f.body}`).digest('base64');
const recvB64 = received.includes(',') ? received.split(',').pop() : received;

console.log('id        :', f.id);
console.log('timestamp :', f.timestamp);
console.log('expected  : v1,' + expected);
console.log('received  :', received);
console.log('MATCH     :', expected === recvB64);
