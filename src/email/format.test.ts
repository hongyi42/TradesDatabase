import { describe, expect, test } from 'vitest';
import {
  emailAddressOf,
  formatEmailRawText,
  isOwnMailbox,
  soleRecipientOf,
} from './format.js';

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

  // RUNG 10B.3. An '@' anywhere used to be enough, so a header this parser
  // cannot handle came back as one long "address" that matches nothing — the
  // message silently LOSING its identity key instead of saying it has none.
  test('a string that merely contains an @ is not an address', () => {
    expect(emailAddressOf('Team: jane@x.com;')).toBeNull(); // group syntax
    expect(emailAddressOf('a@x.com; b@y.com')).toBeNull(); // semicolon list
    expect(emailAddressOf('jane @ x.com')).toBeNull();
    expect(emailAddressOf('@x.com')).toBeNull();
    expect(emailAddressOf('jane@')).toBeNull();
    // …and the shapes our own producer really emits still pass.
    expect(emailAddressOf('jane@x.com')).toBe('jane@x.com');
    expect(emailAddressOf('"Doe, Jane" <jane@x.com>')).toBe('jane@x.com');
  });
});

// RUNG 10B.3 — on the firm's own outbound mail the sender is always us, so the
// address worth matching on is who it went TO. Unique-or-nothing, like every
// other identity key.
describe('soleRecipientOf', () => {
  test('one recipient, however it is written', () => {
    expect(soleRecipientOf('Iris <IRIS@Home.test>')).toBe('iris@home.test');
    expect(soleRecipientOf('  iris@home.test ')).toBe('iris@home.test');
  });

  test('two different people name neither', () => {
    expect(soleRecipientOf('iris@home.test, landlord@example.test')).toBeNull();
  });

  test('the SAME person twice is still one person', () => {
    // A reply-all listing an address under two display names went to one
    // person, and withholding the key there would be withholding one we have.
    expect(soleRecipientOf('Iris <iris@home.test>, iris@home.test')).toBe('iris@home.test');
    expect(soleRecipientOf('IRIS@home.test, Iris Calloway <iris@HOME.test>')).toBe(
      'iris@home.test',
    );
  });

  test('nothing parseable is null, never a guess', () => {
    expect(soleRecipientOf(null)).toBeNull();
    expect(soleRecipientOf('')).toBeNull();
    expect(soleRecipientOf('undisclosed-recipients:;')).toBeNull();
  });
});

describe('isOwnMailbox — is the firm mailing itself?', () => {
  test('the plain self-sent shape', () => {
    expect(isOwnMailbox('Hongyi <office@firm.test>', 'Hongyi <office@firm.test>')).toBe(true);
  });

  test('display name and case are irrelevant — the bare address decides', () => {
    expect(isOwnMailbox('The Office <OFFICE@Firm.test>', 'office@firm.test')).toBe(true);
  });

  test('a CUSTOMER who keeps themselves on the To line keeps their key', () => {
    // The regression the second review round caught. Testing every address on
    // the line turns "is the firm mailing itself" into "is the sender among the
    // recipients" — so a contact form's copy-to-sender, or a reply-all, would
    // strip a real customer's identity key and open a second unmatched item on
    // their next message. Refusing to guess is the whole design.
    expect(isOwnMailbox('ruth@example.test', 'office@firm.test, ruth@example.test')).toBe(false);
    expect(
      isOwnMailbox('Ruth <ruth@example.test>', 'Ruth <ruth@example.test>, Hongyi <office@firm.test>'),
    ).toBe(false);
  });

  test('the PAIRED MAILBOX settles a multi-recipient line outright', () => {
    // What the `to` header alone cannot answer, the roster can: this is the
    // mailbox the message was delivered under.
    expect(
      isOwnMailbox('office@firm.test', 'office@firm.test, ruth@example.test', 'office@firm.test'),
    ).toBe(true);
    // …and it is matched on the bare address too.
    expect(isOwnMailbox('Hongyi <office@firm.test>', null, 'Office <OFFICE@Firm.test>')).toBe(true);
    // A paired mailbox that is NOT the sender proves nothing either way.
    expect(
      isOwnMailbox('ruth@example.test', 'office@firm.test, ruth@example.test', 'office@firm.test'),
    ).toBe(false);
  });

  test('a real customer writing in is never ours', () => {
    expect(isOwnMailbox('ruth@example.test', 'office@firm.test')).toBe(false);
    expect(
      isOwnMailbox('Ruth <ruth@example.test>', 'office@firm.test, dispatch@firm.test'),
    ).toBe(false);
  });

  test('a missing side is not a match — never guess the firm is writing to itself', () => {
    expect(isOwnMailbox('office@firm.test', null)).toBe(false);
    expect(isOwnMailbox('office@firm.test', undefined)).toBe(false);
    expect(isOwnMailbox('office@firm.test', '')).toBe(false);
    expect(isOwnMailbox(null, 'office@firm.test')).toBe(false);
    expect(isOwnMailbox('office@firm.test', null, null)).toBe(false);
    // A display name on its own is not an address on either side.
    expect(isOwnMailbox('The Office', 'The Office')).toBe(false);
  });
});
