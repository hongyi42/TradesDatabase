// Vitest does not auto-load .env. Load .env first (ANTHROPIC_API_KEY etc. for the
// key-gated live-model tests), then .env.test with override so the three DB vars
// point at the LOCAL Supabase stack. The guard then hard-fails the whole suite if
// they don't — tests must never reach a hosted database (2026-07-03 incident).
import { config } from 'dotenv';
import { assertLocalTestEnv } from './testEnvGuard.js';

config();
config({ path: '.env.test', override: true });
assertLocalTestEnv(process.env);
