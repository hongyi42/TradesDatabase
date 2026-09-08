import { describe, expect, test } from 'vitest';
import { emailAddressOf, formatEmailRawText } from './format.js';

describe('formatEmailRawText', () => {
  test('prepends the headers to the clean body', () => {
    expect(formatEmailRawText({ from: 'Mike <mike@acme.com>', subject: 'Leak', body: 'hi' })).toBe(
      'Subject: Leak\nFrom: Mike <mike@acme.com>\n\nhi',
    );
  });
});

describe('emailAddressOf', () => {
  test('pulls the address out of a display-name header', () => {
    expect(emailAddressOf('Mike Becker <Mike@Acme.com>')).toBe('mike@acme.com');
  });

  test('accepts a bare address, trimmed and lower-cased', () => {
    expect(emailAddressOf('  Mike@ACME.com ')).toBe('mike@acme.com');
  });

  test('a display name with no address is not an address', () => {
    expect(emailAddressOf('nobody')).toBeNull();
    expect(emailAddressOf('Mike Becker <nobody>')).toBeNull();
  });

  test('absent input stays absent', () => {
    expect(emailAddressOf(null)).toBeNull();
    expect(emailAddressOf(undefined)).toBeNull();
    expect(emailAddressOf('')).toBeNull();
  });
});
