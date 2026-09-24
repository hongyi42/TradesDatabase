// The ONLY env the local spine gets: the worktree's LOCAL stack (never the pilot) + the manager identity.
import { readFileSync } from 'node:fs';
const WT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const t = Object.fromEntries(readFileSync(`${WT}/.env.test`, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]));
if (!/^http:\/\/127\.0\.0\.1:/.test(t.SUPABASE_URL)) throw new Error('refusing: SUPABASE_URL is not local');
export const SPINE = { command: process.execPath, args: [`${WT}/dist/mcp/server.js`], cwd: WT };
export const SPINE_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_URL: t.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: t.SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL: t.DATABASE_URL, DEFAULT_TENANT_ID: '90b5cab7-3926-40ce-b5b6-89ca49b41edb', DEFAULT_TECHNICIAN_REF: 'manager-sam', TZ: 'America/Los_Angeles' };
