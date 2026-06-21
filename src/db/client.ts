import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

let cached: SupabaseClient<Database> | undefined;

// Server-side client built from the service-role key. All data-access modules
// in src/db go through this. The service-role key bypasses RLS, so this must
// only ever run server-side, never in a browser.
export function getClient(): SupabaseClient<Database> {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  cached = createClient<Database>(url, key, { auth: { persistSession: false } });
  return cached;
}
