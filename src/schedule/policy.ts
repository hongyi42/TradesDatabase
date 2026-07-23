// Default technician visibility horizon (user decision 2026-07-22): beyond it
// the schedule is fluid (pre-freeze) and unpublished to technicians. The live
// value is per-tenant on tenants.technician_horizon_days (manager-tunable via
// set_technician_horizon; the migration default mirrors this constant, which
// exists for callers holding no tenant row). Decoupled from the freeze
// horizon on purpose — showing SOME fluid future is fine; technicians know
// far-out plans can change. Managers are never clamped.
export const DEFAULT_TECHNICIAN_HORIZON_DAYS = 28;
