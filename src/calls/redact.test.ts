import { describe, expect, test } from 'vitest';
import { redactSensitive } from './redact.js';

describe('redactSensitive', () => {
  test('redacts Luhn-valid card numbers (spaced and unspaced)', () => {
    expect(redactSensitive('pay with 4242 4242 4242 4242 today')).toBe('pay with [CARD] today');
    expect(redactSensitive('card 4111111111111111')).toBe('card [CARD]');
    expect(redactSensitive('amex 3782 822463 10005')).toContain('[CARD]');
  });

  test('does NOT redact a card-shaped run that fails Luhn', () => {
    const s = 'ref number 1111 1111 1111 1111 here';
    expect(redactSensitive(s)).toBe(s);
  });

  test('redacts SSN (dash or space grouped)', () => {
    expect(redactSensitive('ssn 123-45-6789')).toBe('ssn [SSN]');
    expect(redactSensitive('ssn 123 45 6789')).toBe('ssn [SSN]');
  });

  test('redacts CVV and routing in context', () => {
    expect(redactSensitive('CVV 123')).toBe('CVV [CVV]');
    expect(redactSensitive('security code is 4821')).toBe('security code is [CVV]');
    expect(redactSensitive('routing number 123456789')).toBe('routing number [BANK]');
  });

  test('KEEPS ZIP, phone, name, and street address', () => {
    expect(redactSensitive('Seattle 98101')).toBe('Seattle 98101');
    expect(redactSensitive('call 206-555-0100')).toBe('call 206-555-0100');
    expect(redactSensitive('John Smith at 123 Main St')).toBe('John Smith at 123 Main St');
  });

  test('handles a realistic mixed transcript', () => {
    const t = 'This is John at 500 Pine St, Seattle 98101, my card is 4242424242424242, ssn 123-45-6789.';
    const r = redactSensitive(t);
    expect(r).toContain('John at 500 Pine St, Seattle 98101');
    expect(r).toContain('[CARD]');
    expect(r).toContain('[SSN]');
    expect(r).not.toContain('4242');
    expect(r).not.toContain('6789');
  });
});
