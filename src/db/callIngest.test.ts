import { describe, expect, test, vi } from 'vitest';

// Mock the Supabase client so claimNextPendingCall's normalization is testable
// without a DB. h.rpcResult is what getClient().rpc('claim_next_call') resolves to.
const h = vi.hoisted(() => ({ rpcResult: { data: null as unknown, error: null as unknown } }));
vi.mock('./client.js', () => ({
  getClient: () => ({ rpc: async () => h.rpcResult }),
}));

import { claimNextPendingCall } from './callIngest.js';

// Regression lock for the live 2026-08-06 pilot crash: the LOCAL stack returns a
// NULL composite as JSON null, but the HOSTED PostgREST returns it as an all-null
// ROW ({id:null,…}). claimNextPendingCall must treat BOTH as "empty" — otherwise
// an idle worker processes a phantom null-id row and crashes in markCallError.
describe('claimNextPendingCall — empty-queue normalization', () => {
  const realRow = { id: 'ci-1', tenant_id: 'T1', external_id: 'RE1', status: 'processing' };

  test('local empty (JSON null) → null', async () => {
    h.rpcResult = { data: null, error: null };
    expect(await claimNextPendingCall()).toBeNull();
  });
  test('hosted empty (all-null composite ROW) → null', async () => {
    h.rpcResult = { data: { id: null, tenant_id: null, external_id: null }, error: null };
    expect(await claimNextPendingCall()).toBeNull();
  });
  test('hosted empty as array-of-all-null → null', async () => {
    h.rpcResult = { data: [{ id: null, tenant_id: null }], error: null };
    expect(await claimNextPendingCall()).toBeNull();
  });
  test('a real claimed row → returned', async () => {
    h.rpcResult = { data: realRow, error: null };
    expect(await claimNextPendingCall()).toMatchObject({ id: 'ci-1' });
  });
  test('a real row as array → returned', async () => {
    h.rpcResult = { data: [realRow], error: null };
    expect(await claimNextPendingCall()).toMatchObject({ id: 'ci-1' });
  });
  test('rpc error → throws', async () => {
    h.rpcResult = { data: null, error: { message: 'boom' } };
    await expect(claimNextPendingCall()).rejects.toThrow('boom');
  });
});
