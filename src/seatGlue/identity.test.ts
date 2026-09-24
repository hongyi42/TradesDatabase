import { describe, expect, it } from 'vitest';
import { seatTokenOf } from '../mcp/identity.js';
import { seatHeaders } from './identity.js';

// The glue sends what Render recognises as a seat token; Render's own
// recogniser is the judge (the lookup itself: src/db/seats.test.ts, and the
// whole mint → whoami → /mcp path: src/mcp/httpServer.test.ts).
describe('seatHeaders', () => {
  const TOKEN = `st_${'ab'.repeat(32)}`;

  it("is read by Render's seatTokenOf as this exact token", () => {
    expect(seatTokenOf({ ...seatHeaders(TOKEN) })).toBe(TOKEN);
  });

  it('carries nothing but the bearer — no identity headers to forge', () => {
    expect(Object.keys(seatHeaders(TOKEN))).toEqual(['authorization']);
  });

  it('refuses an empty token', () => {
    expect(() => seatHeaders('')).toThrow();
  });
});
