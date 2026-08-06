// Redact sensitive-auth data (SAD) from a call transcript BEFORE it is written to
// the append-only L1 (raw_captures has no delete path — scrub before the insert).
// Targets card / CVV / SSN / bank-routing only; deliberately KEEPS names,
// addresses, phones and job details — those ARE the spine's purpose. Best-effort
// on digit-form data; worded numbers ("four one one one…") are out of scope
// (AssemblyAI's own PII redaction is the complementary layer if enabled).

// Luhn check so a 13–19 digit run is redacted as a card only when it actually
// validates — avoids nuking order numbers / long IDs that merely look card-shaped.
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactSensitive(text: string): string {
  let out = text;
  // SSN: 3-2-4 grouped by a dash or space. A 5-digit ZIP has no groups and a
  // phone is 3-3-4 (middle group of 3), so neither matches this shape.
  out = out.replace(/\b\d{3}[ -]\d{2}[ -]\d{4}\b/g, '[SSN]');
  // CVV/CVC/"security code" in context → mask the trailing 3-4 digit code only.
  out = out.replace(/\b(cvv|cvc|security code)\b(\D{0,10})\d{3,4}\b/gi, '$1$2[CVV]');
  // Bank routing / ABA in context → mask the trailing 9 digits.
  out = out.replace(/\b(routing|aba)\b(\D{0,10})\d{9}\b/gi, '$1$2[BANK]');
  // Card-like: 13-19 digits optionally grouped by single spaces/hyphens, Luhn-valid.
  // (13-digit minimum keeps phone numbers — 10-11 digits — untouched.)
  out = out.replace(/\d(?:[ -]?\d){12,18}/g, (match) => {
    const digits = match.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[CARD]' : match;
  });
  return out;
}
