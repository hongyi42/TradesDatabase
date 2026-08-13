import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildToolCases, confirmIdOf, toolsCovered, type CaseContext, type ToolOutcome } from './toolCases.js';

const cases = buildToolCases();

/**
 * The spine's tool names, read out of the server source at test time.
 *
 * Deliberately derived rather than hardcoded: a hardcoded list would have to be
 * edited by the same person adding a tool, which is exactly when it stops being a
 * check. Read this way, adding a 43rd tool FAILS this test until the eval covers
 * it — the coverage gate maintains itself.
 */
function spineToolNames(): string[] {
  const src = readFileSync('src/mcp/server.ts', 'utf8');
  const slice = src.slice(src.indexOf('const TOOLS = ['), src.indexOf('const MANAGER_TOOLS'));
  return [...slice.matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
}

describe('tool cases — the corpus covers the surface', () => {
  it('reads a plausible tool surface out of the server', () => {
    const names = spineToolNames();
    // 14 technician + 28 admin. If this number moves, the surface moved.
    expect(names.length).toBe(42);
    expect(new Set(names).size).toBe(names.length);
  });

  it('touches EVERY spine tool at least once', () => {
    const covered = new Set(toolsCovered(cases));
    const uncovered = spineToolNames().filter((n) => !covered.has(n));
    expect(uncovered, `tools with no tier-1 case: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('names only real tools', () => {
    const real = new Set([...spineToolNames(), 'tools/list']);
    const invented = toolsCovered(cases).filter((n) => !real.has(n));
    expect(invented, `cases referencing non-existent tools: ${invented.join(', ')}`).toEqual([]);
  });

  it('has unique case ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the gating and isolation families, not just happy paths', () => {
    const families = new Set(cases.map((c) => c.family));
    for (const need of ['reads', 'gating', 'writes', 'config', 'failure', 'external']) {
      expect(families, `missing family '${need}'`).toContain(need);
    }
    // The cross-tenant canary probe is the one case whose absence would be
    // invisible and expensive, so it is named explicitly.
    expect(cases.some((c) => c.family === 'gating' && /cannot find another firm/.test(c.title))).toBe(true);
  });

  it('marks external dependencies rather than letting them fail as bugs', () => {
    const allowed = new Set(['model', 'network', 'composio', 'maps']);
    for (const c of cases) {
      if (c.requires) expect(allowed, `${c.id} has unknown requirement`).toContain(c.requires);
    }
    // Every tool that reaches a model or a third party must be marked, or a run
    // without keys reports real failures that are really just absent capability.
    const externalTools = [
      'brief_customer',
      'answer_customer_question',
      'web_search',
      'read_webpage',
      'send_email',
      'get_connect_link',
      'run_freeze',
      'run_resolve',
    ];
    for (const tool of externalTools) {
      const owning = cases.filter((c) => c.tool === tool);
      expect(owning.length, `${tool} has no case`).toBeGreaterThan(0);
      for (const c of owning) expect(c.requires, `${c.id} (${tool}) is not marked`).toBeTruthy();
    }
  });

  it('runs local-only cases with no requirement flag', () => {
    const local = cases.filter((c) => !c.requires);
    // The free tier has to be the bulk of it, or "npm run spine-eval:tools" is
    // not something anyone will run often.
    expect(local.length).toBeGreaterThan(30);
  });
});

describe('tool cases — no step can fire with a missing confirmId', () => {
  // A confirm step whose guard is missing would call the tool with
  // `confirmId: null`, get a refusal, and report a FAILURE that is really a
  // harness bug. Cheap to prevent, expensive to debug.
  const fakeCtx = (): CaseContext =>
    ({
      world: {
        anchor: '2026-08-12',
        edges: { crossTenantCanary: 'Zylatha Pemberton-Quist' },
        tenants: [{ key: 'other', jobs: { 'canary-job': { id: 'x', title: 't' } } }],
      },
      tenant: {
        key: 'main',
        id: 't',
        customers: Object.fromEntries(
          ['edge-rich', 'edge-no-address', 'edge-silent', 'fx-t1-cap-01', 'fx-t1-cap-02', 'fx-t1-ext-01'].map((k) => [
            k,
            { id: 'c', name: `Name ${k}` },
          ]),
        ),
        jobs: Object.fromEntries(
          [
            'job-rich-1',
            'job-durationless',
            'job-loose-2',
            'job-t1-bk-01',
            'job-t1-bk-02',
            'job-t1-bk-08',
            'job-t1-rs-02',
            'job-t1-rs-03',
            'job-t1-rs-04',
            'job-t1-rs-05',
            'job-t1-rs-06',
          ].map((k) => [k, { id: 'j', title: 't' }]),
        ),
        visits: Object.fromEntries(
          ['visit-t1-rs-01', 'visit-t1-rs-02', 'visit-t1-rs-03', 'visit-t1-rs-05', 'visit-t1-rs-06'].map((k) => [
            k,
            { id: 'v', date: '2026-08-20' },
          ]),
        ),
        captures: { 'cap-rich-intake': 'cap' },
        technicians: { 'tech-jane': 'tj' },
      },
      anchor: '2026-08-12',
      prior: [],
      sql: async () => [],
    }) as unknown as CaseContext;

  it('every unguarded step builds valid arguments with no prior results', () => {
    for (const c of cases) {
      for (const [i, step] of c.steps.entries()) {
        if (step.when) continue; // guarded — not expected to run without a prior
        const args = step.args(fakeCtx());
        for (const [k, v] of Object.entries(args)) {
          expect(v, `${c.id} step ${i} (${step.label}) passes ${k}=${String(v)} with no prior step`).not.toBeNull();
          expect(v, `${c.id} step ${i} (${step.label}) passes ${k}=undefined`).not.toBeUndefined();
        }
      }
    }
  });

  it('every step that needs a confirmId is guarded', () => {
    for (const c of cases) {
      for (const step of c.steps) {
        if (step.when) continue;
        const args = step.args(fakeCtx());
        expect(
          'confirmId' in args,
          `${c.id} step '${step.label}' sends a confirmId but has no when-guard`,
        ).toBe(false);
      }
    }
  });
});

describe('confirmIdOf', () => {
  const out = (over: Partial<ToolOutcome>): ToolOutcome => ({
    ok: true,
    isError: false,
    timedOut: false,
    httpStatus: 200,
    text: '',
    json: null,
    ms: 1,
    ...over,
  });

  it('reads the id from parsed JSON', () => {
    expect(confirmIdOf(out({ json: { confirmId: 'abc-123' } }))).toBe('abc-123');
  });

  it('falls back to the raw text when the reply is not pure JSON', () => {
    expect(confirmIdOf(out({ text: 'Nothing booked. "confirmId": "xyz-9" — show the preview.' }))).toBe('xyz-9');
  });

  it('is null when nothing staged — the signal the guards read', () => {
    expect(confirmIdOf(out({ text: 'Booked for Thursday.' }))).toBeNull();
    expect(confirmIdOf(undefined)).toBeNull();
  });
});
