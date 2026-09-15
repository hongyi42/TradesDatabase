import { describe, expect, it } from 'vitest';
import { BADGE_TOOLS } from '../mcp/tools/surface.expected.js';
import {
  SPINE_TOOL_NAMES,
  TEAM_LEAD_ONLY_TOOL_NAMES,
  TEAM_LEAD_TOOL_SCHEMAS,
} from '../mcp/server.js';
import { buildToolCases, confirmIdOf, toolsCovered, type CaseContext, type ToolOutcome } from './toolCases.js';

const cases = buildToolCases();

/**
 * The spine's BADGE-reachable tool names, and the team lead's own, read from the
 * server's REAL tool tables.
 *
 * Deliberately derived rather than hardcoded: a hardcoded list would have to be
 * edited by the same person adding a tool, which is exactly when it stops being a
 * check. Derived this way, adding a 44th tool FAILS the coverage test below until
 * the eval covers it — the coverage gate maintains itself.
 *
 * Until 2026-09-12 these were scraped out of src/mcp/server.ts with a regex over
 * its source text. That broke when the tool registry was split by domain: the
 * definitions now live in src/mcp/tools/<domain>.ts and the hub only aggregates,
 * so the regex found an almost empty file. Importing the aggregates is both the
 * fix and what the scrape was approximating — and it cannot silently under-report
 * a tool contributed through a spread.
 *
 * TEAM_LEAD_TOOLS is deliberately OUTSIDE the badge slice (plan 2026-08-19,
 * Phase 1): those names dispatch only for the `spine:` namespace and are refused
 * to every badge, so a tier-1 agent case for one could not be written.
 */
function spineToolNames(): string[] {
  return [...SPINE_TOOL_NAMES];
}

/**
 * The team lead's own tools, in the order the planner is handed them. Reachable
 * by no badge EXCEPT the names shared with the manager seat (rung 10b.2) —
 * `record_caller` is dispatchable by an active manager, so "no badge can call
 * these" is no longer true of the whole array.
 */
function teamLeadToolNames(): string[] {
  return TEAM_LEAD_TOOL_SCHEMAS.map((t) => t.name);
}

/**
 * Team-lead names an active MANAGER badge may also dispatch (rung 10b.2), derived
 * the way every other surface here is — the team-lead array minus the names the
 * gate keeps `spine:`-only. An earlier version compared a hand-written literal to
 * itself and would have passed while the real set grew: decorative, and exactly
 * the drift this file exists to catch.
 */
function seatSharedToolNames(): string[] {
  return teamLeadToolNames().filter((n) => !TEAM_LEAD_ONLY_TOOL_NAMES.has(n));
}

describe('tool cases — the corpus covers the surface', () => {
  it('reads a plausible tool surface out of the server', () => {
    const names = spineToolNames();
    // By NAME, not by count (2026-09-12): this was `toBe(43)`, one of five counts
    // every tool-adding feature had to move — see src/mcp/tools/surface.expected.ts.
    // BADGE_TOOLS is the expectation, written independently of the tool tables.
    expect([...names].sort()).toEqual([...BADGE_TOOLS].sort());
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

  it('the team-lead surface is real, and disjoint from the badge surface', () => {
    const teamLead = teamLeadToolNames();
    // Pinned by NAME, not by count: adding a team-lead tool must be a decision
    // somebody made on purpose, because the same array feeds the dispatch gate.
    expect(teamLead).toEqual([
      'spine_read',
      'recall_decisions',
      'read_memory',
      'write_memory',
      'read_job_note',
      'write_job_note',
      'record_caller',
    ]);
    // A name in both ARRAYS would mean one tool declared twice — in practice the
    // sign that spine_read drifted into TOOLS/ADMIN_TOOLS. Still disjoint by
    // declaration; sharing happens at the GATE, not by re-declaring a schema.
    const badge = new Set(spineToolNames());
    expect(teamLead.filter((n) => badge.has(n))).toEqual([]);
    // …and what IS shared is pinned by name, because the eval's coverage gate
    // reads `spineToolNames()` only: a shared tool is badge-reachable but will
    // never be REQUIRED to have a tier-1 case by the gate above. Any name added
    // here needs its eval case written by hand until that scrape widens.
    expect(seatSharedToolNames()).toEqual(['record_caller']);
    // Every shared name must be a real team-lead tool, or the gate in server.ts
    // is guarding a name nothing declares.
    expect(seatSharedToolNames().filter((n) => !teamLead.includes(n))).toEqual([]);
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
      'web_search',
      'read_webpage',
      'send_email',
      'get_connect_link',
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
