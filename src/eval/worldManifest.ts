// The APPLIED world: what world.mjs wrote, with real database ids.
//
// Distinct from WorldSpec (the declarative shape) on purpose — the spec says
// "a customer keyed edge-rich", the manifest says "that customer is this uuid".
// Scenarios reference the manifest, so they never carry a hardcoded id.

import type { EdgeKey } from './worldSpec.js';

export type TenantKey = 'main' | 'freeze' | 'resolve' | 'seats' | 'other';

export interface TenantManifest {
  key: TenantKey;
  name: string;
  id: string;
  purpose: string;
  horizonDays: number;
  /** technician ref -> id */
  technicians: Record<string, string>;
  /** spec key -> { id, name } */
  customers: Record<string, { id: string; name: string }>;
  /** spec key -> { id, title } */
  jobs: Record<string, { id: string; title: string }>;
  /** spec key -> { assignment id, the day it sits on } */
  visits: Record<string, { id: string; date: string | null }>;
  /** spec key -> capture id */
  captures: Record<string, string>;
  counts: {
    technicians: number;
    customers: number;
    jobs: number;
    visits: number;
    captures: number;
  };
}

export interface WorldManifest {
  builtAt: string;
  anchor: string;
  seed: number;
  timezone: string;
  span: { from: string; to: string };
  edges: Record<EdgeKey, string>;
  tenants: TenantManifest[];
}

/**
 * Every lookup throws with the key it wanted rather than returning undefined.
 * A scenario built on a silently-missing fixture does not fail — it passes
 * vacuously, calling a tool with `undefined` and grading whatever comes back.
 * That is the worst failure mode an eval can have, so these are loud.
 */
export function tenantOf(world: WorldManifest, key: TenantKey): TenantManifest {
  const t = world.tenants.find((x) => x.key === key);
  if (!t) throw new Error(`world has no tenant '${key}' (have: ${world.tenants.map((x) => x.key).join(', ')})`);
  return t;
}

export function customerId(t: TenantManifest, key: string): string {
  const c = t.customers[key];
  if (!c) throw new Error(`tenant ${t.key} has no customer '${key}'`);
  return c.id;
}

export function customerName(t: TenantManifest, key: string): string {
  const c = t.customers[key];
  if (!c) throw new Error(`tenant ${t.key} has no customer '${key}'`);
  return c.name;
}

export function jobId(t: TenantManifest, key: string): string {
  const j = t.jobs[key];
  if (!j) throw new Error(`tenant ${t.key} has no job '${key}'`);
  return j.id;
}

export function visitId(t: TenantManifest, key: string): string {
  const v = t.visits[key];
  if (!v) throw new Error(`tenant ${t.key} has no visit '${key}'`);
  return v.id;
}

/** The day a fixture visit sits on — for scenarios that must move it elsewhere. */
export function visitDate(t: TenantManifest, key: string): string {
  const v = t.visits[key];
  if (!v) throw new Error(`tenant ${t.key} has no visit '${key}'`);
  if (!v.date) throw new Error(`visit '${key}' in tenant ${t.key} has no date (it is unplaced)`);
  return v.date;
}

export function captureId(t: TenantManifest, key: string): string {
  const id = t.captures[key];
  if (!id) throw new Error(`tenant ${t.key} has no capture '${key}'`);
  return id;
}

export function technicianId(t: TenantManifest, ref: string): string {
  const id = t.technicians[ref];
  if (!id) throw new Error(`tenant ${t.key} has no technician '${ref}'`);
  return id;
}

/** Find a customer key by the generated display name (fixtures embed their id). */
export function customerKeyByName(t: TenantManifest, name: string): string {
  const hit = Object.entries(t.customers).find(([, c]) => c.name === name);
  if (!hit) throw new Error(`tenant ${t.key} has no customer named '${name}'`);
  return hit[0];
}
