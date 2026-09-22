// The seat glue's settings, read once at startup from the unit's env file
// (/etc/seat-glue/<seat>.env on trades-box-1). Every required value is checked
// here so a missing key stops the process before it polls Telegram or signs a
// single header — fail closed, the doorman's posture.
//
// SELF-CONTAINED: nothing under src/seatGlue imports another src/ module (only
// node:* and the Copilot SDK), because only dist/seatGlue/ ships to the box.
// selfContained.test.ts enforces it.

export interface SeatConfig {
  botToken: string;
  seatRef: string;
  tenantId: string;
  technicianRef: string;
  telegramUserId: number;
  /** The firm's IANA timezone. Hand-set for step 1; retire when step 4 has Render send it. */
  tz: string;
  secret: string;
  spineUrl: string;
  openrouterKey: string;
  model: string;
  stateDir: string;
  mediaRetentionDays: number;
  costCheckUsd: number;
}

const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'SEAT_REF',
  'SEAT_TENANT_ID',
  'SEAT_TECHNICIAN_REF',
  'SEAT_TELEGRAM_USER_ID',
  'SEAT_TZ',
  'GATEWAY_IDENTITY_SECRET',
  'SPINE_MCP_URL',
  'OPENROUTER_API_KEY',
] as const;

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

export function loadConfig(env: NodeJS.ProcessEnv): SeatConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  // Names only — never a value — so the message is safe for the journal.
  if (missing.length) throw new Error(`seat-glue: missing ${missing.join(', ')}`);
  const get = (k: (typeof REQUIRED)[number]) => (env[k] as string).trim();

  // Same shape the roster's bind_telegram accepts (src/mcp/tools/roster.ts).
  const idText = get('SEAT_TELEGRAM_USER_ID');
  if (!/^[1-9][0-9]{4,19}$/.test(idText)) {
    throw new Error('seat-glue: SEAT_TELEGRAM_USER_ID must be a Telegram user id (digits)');
  }

  const tz = get('SEAT_TZ');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`seat-glue: SEAT_TZ "${tz}" is not a valid IANA timezone`);
  }

  // The doorman's rule: a real upstream is https; plain http only toward loopback
  // (the local E2E), so a typo cannot send signed identities in plaintext.
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
    tenantId: get('SEAT_TENANT_ID'),
    technicianRef: get('SEAT_TECHNICIAN_REF'),
    telegramUserId: Number(idText),
    tz,
    secret: get('GATEWAY_IDENTITY_SECRET'),
    spineUrl,
    openrouterKey: get('OPENROUTER_API_KEY'),
    model: env.SEAT_MODEL?.trim() || '@preset/trades-seats',
    stateDir: env.SEAT_STATE_DIR?.trim() || '/var/lib/seat-glue',
    mediaRetentionDays: positive(env.MEDIA_RETENTION_DAYS, 7, 'MEDIA_RETENTION_DAYS'),
    costCheckUsd: positive(env.COST_CHECK_USD, 0.02, 'COST_CHECK_USD'),
  };
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`seat-glue: ${name} must be a positive number`);
  return n;
}
