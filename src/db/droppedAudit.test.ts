import { describe, expect, test } from 'vitest';
import { senderDomain } from './droppedAudit.js';

// Privacy-critical: the audit row must store only the DOMAIN, never the local part,
// display name, or full address. These assertions lock that down.
describe('senderDomain', () => {
  test('extracts the domain only, dropping local part + display name', () => {
    expect(senderDomain('mike@acme.com')).toBe('acme.com');
    expect(senderDomain('Mike Reyes <mike@acme.com>')).toBe('acme.com');
    expect(senderDomain('deals@Newsletter.COM')).toBe('newsletter.com'); // lowercased
    expect(senderDomain('a.b+tag@sub.example.co.uk')).toBe('sub.example.co.uk');
  });

  test('returns null when there is no parseable domain', () => {
    expect(senderDomain('not-an-email')).toBeNull();
    expect(senderDomain('')).toBeNull();
    expect(senderDomain(null)).toBeNull();
    expect(senderDomain(undefined)).toBeNull();
  });

  test('never returns the local part or full address', () => {
    const out = senderDomain('secret.person@acme.com');
    expect(out).toBe('acme.com');
    expect(out).not.toContain('secret.person');
    expect(out).not.toContain('@');
  });
});
