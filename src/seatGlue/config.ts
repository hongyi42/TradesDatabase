// The seat glue's settings, read once at startup from the unit's env file
// (/etc/seat-glue/<seat>.env on trades-box-1). Every required value is checked
// here so a missing key stops the process before it polls Telegram or sends a
// single request — fail closed, the doorman's posture.
//
// SECRETS AND THE SEAT'S NAME ONLY (step 4). Who the seat is — firm, person,
// Telegram account, timezone — is NOT here: the glue asks Render at start with
// its token (whoami.ts), so the box holds no identity of its own to drift.
//
// SELF-CONTAINED: nothing under src/seatGlue imports another src/ module (only
// node:* and the two SDKs, Copilot and E2B), because only dist/seatGlue/ ships to the box.
// selfContained.test.ts enforces it.

import { fileURLToPath } from 'node:url';

export interface SeatConfig {
  botToken: string;
  seatRef: string;
  /** This seat's bearer token (`st_…`), minted by install.sh. Revocable, one seat only. */
  seatToken: string;
  spineUrl: string;
  openrouterKey: string;
  model: string;
  stateDir: string;
  mediaRetentionDays: number;
  /**
   * Step 2b: the manager's sandbox (E2B). Optional on purpose — absent, a manager
   * seat simply has no file tools (and says so at start); a technician never uses it.
   */
  e2bApiKey?: string;
  /** The E2B template a manager's sandbox starts from (Box_Setup_Stuff/seat-glue/e2b-template.mjs). */
  e2bTemplate: string;
  /**
   * The skill folders (step 2b): SKILL.md files the engine reads, and scripts the
   * glue copies into the sandbox. Default: `skills/` beside `app/` in the box package.
   */
  skillsDir: string;
}

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'SEAT_REF', 'SEAT_TOKEN', 'SPINE_MCP_URL', 'OPENROUTER_API_KEY'] as const;

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

export function loadConfig(env: NodeJS.ProcessEnv): SeatConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  // Names only — never a value — so the message is safe for the journal.
  if (missing.length) throw new Error(`seat-glue: missing ${missing.join(', ')}`);
  const get = (k: (typeof REQUIRED)[number]) => (env[k] as string).trim();

  // Shape only, never echoed: the token is a secret.
  const seatToken = get('SEAT_TOKEN');
  if (!/^st_[0-9a-f]{64}$/.test(seatToken)) {
    throw new Error('seat-glue: SEAT_TOKEN is not a seat token (expected st_ + 64 hex)');
  }

  // The doorman's rule: a real upstream is https; plain http only toward loopback
  // (the local E2E), so a typo cannot send the seat's token in plaintext.
  const spineUrl = get('SPINE_MCP_URL');
  let url: URL;
  try {
    url = new URL(spineUrl);
  } catch {
    throw new Error('seat-glue: SPINE_MCP_URL is not a URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) {
    throw new Error(`seat-glue: SPINE_MCP_URL must be https (got ${url.protocol}//${url.hostname})`);
  }

  return {
    botToken: get('TELEGRAM_BOT_TOKEN'),
    seatRef: get('SEAT_REF'),
    seatToken,
    spineUrl,
    openrouterKey: get('OPENROUTER_API_KEY'),
    model: env.SEAT_MODEL?.trim() || '@preset/trades-seats',
    stateDir: env.SEAT_STATE_DIR?.trim() || '/var/lib/seat-glue',
    mediaRetentionDays: positive(env.MEDIA_RETENTION_DAYS, 7, 'MEDIA_RETENTION_DAYS'),
    ...(env.E2B_API_KEY?.trim() ? { e2bApiKey: env.E2B_API_KEY.trim() } : {}),
    e2bTemplate: env.E2B_TEMPLATE?.trim() || 'trades-manager',
    skillsDir: env.SEAT_SKILLS_DIR?.trim() || fileURLToPath(new URL('../skills', import.meta.url)),
  };
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`seat-glue: ${name} must be a positive number`);
  return n;
}
