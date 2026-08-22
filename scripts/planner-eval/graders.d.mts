export interface GraderCheck { name: string; pass: boolean; detail?: string }
export function deterministicChecks(
  note: string | null,
  opts: {
    dateLabels: string[];
    mustName?: string[];
    mustNotClaim?: string[];
    cleanHandoffNote: (raw: unknown, labels: string[]) => { note: string | null; why?: string };
  },
): GraderCheck[];
export function summarise(checks: GraderCheck[]): {
  passed: number; total: number; failures: GraderCheck[];
};
