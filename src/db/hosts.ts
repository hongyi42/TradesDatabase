import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type Host = Database['public']['Tables']['hosts']['Row'];

// A host is one machine running a doorman + sandboxes. It authenticates its
// badge pull with a bearer token we store only as a sha256 fingerprint —
// same no-plaintext-at-rest rule as technician badges.
export async function createHost(name: string, tokenHash: string): Promise<Host> {
  const { data, error } = await getClient()
    .from('hosts')
    .insert({ name, token_hash: tokenHash })
    .select()
    .single();
  if (error || !data) throw new Error(`createHost failed: ${error?.message ?? 'no row returned'}`);
  return data;
}

// Point read by token fingerprint: the pull endpoint hashes the presented
// bearer token and looks it up here. Unknown hash → null → 401 upstream.
export async function getHostByTokenHash(tokenHash: string): Promise<Host | null> {
  const { data, error } = await getClient()
    .from('hosts')
    .select()
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new Error(`getHostByTokenHash failed: ${error.message}`);
  return data;
}

export async function getHostByName(name: string): Promise<Host | null> {
  const { data, error } = await getClient()
    .from('hosts')
    .select()
    .eq('name', name)
    .maybeSingle();
  if (error) throw new Error(`getHostByName failed: ${error.message}`);
  return data;
}
