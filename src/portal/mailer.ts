import { setMailer, type Mailer } from './auth.js';

// How a sign-in link reaches a customer.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md — "email delivery"
// is still an OPEN QUESTION for the owner, so there is deliberately no real
// sender here yet. Until one exists, `request-link` answers 503 in production
// rather than pretending to send: a deploy that forgot its mailer must not look
// like a working sign-in that silently drops every link.
//
// WHY NOT THE AGENT'S EXISTING GMAIL PATH. It is the obvious reuse and it is the
// wrong one. Per CLAUDE.md, outbound sends via the spine's `send_email` tool are
// captured into L1 CLASSIFIER-FREE, and L1 is append-only with no delete path.
// A magic-link URL is a bearer credential; writing one into an undeletable table
// would be a permanent credential leak by design. Whatever sender we choose must
// bypass that capture entirely.
//
// TO WIRE A REAL SENDER: implement `Mailer` over your SMTP/API client and return
// it from `resolveMailer()`. Nothing else changes.

/**
 * Development only: prints the link to the server log instead of emailing it.
 *
 * Gated on BOTH an explicit opt-in and not-production, because the whole point of
 * a magic link is that it travels privately to one mailbox — logging it hands a
 * session to anyone who can read the log. The double gate means a single
 * mis-set env var in production cannot switch this on.
 */
function consoleMailer(): Mailer {
  return {
    sendMagicLink: async ({ to, url }) => {
      console.warn(
        `[portal][DEV MAIL] sign-in link for ${to}\n` +
          `           ${url}\n` +
          `           (PORTAL_DEV_MAIL=1 — never enabled in production)`,
      );
    },
  };
}

export function resolveMailer(): Mailer | null {
  const devMail = process.env.PORTAL_DEV_MAIL === '1';
  const isProd = process.env.NODE_ENV === 'production';
  if (devMail && !isProd) return consoleMailer();
  if (devMail && isProd) {
    // Loud, because a silent downgrade here is the difference between "sign-in
    // is broken" and "sign-in tokens are in the log".
    console.error('[portal] PORTAL_DEV_MAIL is set in production and is being IGNORED');
  }
  return null;
}

/** Called once at server boot. */
export function configureMailer(): void {
  const m = resolveMailer();
  setMailer(m);
  if (!m) {
    console.warn(
      '[portal] no mailer configured — /portal/api/auth/request-link will answer 503. ' +
        'Set PORTAL_DEV_MAIL=1 locally, or wire a real sender in src/portal/mailer.ts.',
    );
  }
}
