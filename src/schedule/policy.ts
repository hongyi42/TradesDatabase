// Technician visibility horizon (user decision 2026-07-22): beyond it the
// schedule is fluid (pre-freeze) and unpublished to technicians. The live
// value is per-tenant on tenants.technician_horizon_days (manager-tunable via
// set_technician_horizon; the migration default mirrors the constant below).
// Decoupled from the freeze horizon on purpose — showing SOME fluid future is
// fine; technicians know far-out plans can change. Managers are never clamped.
//
// This module is the policy's ONE home (final-review finding: the clamp was
// first encoded twice, in boardRead and the get_schedule handler, sharing a
// character-identical user-facing sentence — a copy-edit or boundary fix to
// one would silently diverge what chat and board tell the same technician).
// Any future surface that publishes schedule data to technicians (e.g. 4b's
// push gating) calls THESE, never re-derives.

import type { Tenant } from '../db/index.js';
import { addDaysISO } from './fit.js';

export const DEFAULT_TECHNICIAN_HORIZON_DAYS = 28;

// The tenant's horizon in days; DEFAULT when no row is at hand. Never falsy-
// zero-trippable: the DB CHECK bounds the column to 7-84.
export const horizonDaysFor = (tenant: Tenant | null): number =>
  tenant?.technician_horizon_days ?? DEFAULT_TECHNICIAN_HORIZON_DAYS;

export interface HorizonClamp {
  beyond: boolean; // the ENTIRE requested window is past the horizon
  to: string; // the effective end day (trimmed when the window straddled)
  horizonEnd: string; // the LAST visible day (inclusive: today + horizonDays)
  horizonNote?: string; // present whenever the clamp changed the answer
}

// Clamp a validated [from, to] day window to the technician horizon. Callers
// run their own validation FIRST (garbage stays an error, never a quiet
// clamp). Boundary convention, deliberate and inclusive: horizonEnd =
// today + horizonDays is the last VISIBLE day — "at most N weeks ahead"
// counts days ahead of today, so today+28 is exactly 4 weeks ahead.
export function clampToTechnicianHorizon(
  today: string,
  from: string,
  to: string,
  horizonDays: number,
): HorizonClamp {
  const horizonEnd = addDaysISO(today, horizonDays);
  const horizonNote =
    `the schedule past ${horizonEnd} isn't published yet — check back closer to the date`;
  if (from > horizonEnd) return { beyond: true, to, horizonEnd, horizonNote };
  if (to > horizonEnd) return { beyond: false, to: horizonEnd, horizonEnd, horizonNote };
  return { beyond: false, to, horizonEnd };
}
