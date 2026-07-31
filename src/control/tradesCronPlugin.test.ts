import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Locks in Box_Setup_Stuff/plugins/trades-cron/index.js — the flat-schema replacement
// for OpenClaw's built-in `cron` tool (see docs/engineering-memory.md §4, 2026-07-30).
//
// Two things are load-bearing and neither is visible from the sandbox side:
//  1. The parameter schema must stay FLAT. Every request compiles each tool's schema
//     into a constrained-decoding grammar before the first token; nesting is what made
//     the built-in expensive. A future edit that reintroduces a nested object would
//     silently give the latency back, so the shape is asserted here.
//  2. `execute` rebuilds the nested job the Gateway expects. That mapping is the part
//     we reimplemented rather than delegated, so it is the part that can silently drift
//     from the built-in's behaviour.
//
// Loaded via a runtime path (not a static import) because tsconfig pins rootDir to
// src/ — the same reason badgePullScript.test.ts shells out to its script.
const PLUGIN = join(process.cwd(), 'Box_Setup_Stuff', 'plugins', 'trades-cron', 'index.js');

type Params = Record<string, unknown>;
type Ctx = { agentId?: string; sessionKey?: string; deliveryContext?: Record<string, unknown> };
type Plugin = {
  default: (api: { registerTool: (t: unknown) => void }) => void;
  PARAMETERS: {
    type: string;
    properties: Record<string, { type: string; enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };
  ACTIONS: string[];
  buildJob: (params: Params, ctx: Ctx) => Record<string, unknown>;
  buildPatch: (params: Params, ctx: Ctx) => Record<string, unknown>;
  buildSchedule: (params: Params) => Record<string, unknown> | undefined;
  buildDelivery: (params: Params, dc?: Record<string, unknown>) => Record<string, unknown> | undefined;
};

const plugin: Plugin = (await import(pathToFileURL(PLUGIN).href)) as Plugin;

describe('trades-cron parameter schema', () => {
  it('stays flat — no nested object/array property, which is what cost the latency', () => {
    for (const [name, prop] of Object.entries(plugin.PARAMETERS.properties)) {
      expect(prop.type, `property "${name}" must be a scalar`).toMatch(/^(string|number|boolean)$/);
      expect(prop, `property "${name}" must not nest`).not.toHaveProperty('properties');
      expect(prop, `property "${name}" must not nest`).not.toHaveProperty('items');
    }
  });

  it('forbids the gatewayUrl/gatewayToken params the model kept hallucinating', () => {
    // additionalProperties:false means constrained decoding cannot emit them at all.
    expect(plugin.PARAMETERS.additionalProperties).toBe(false);
    expect(plugin.PARAMETERS.properties).not.toHaveProperty('gatewayUrl');
    expect(plugin.PARAMETERS.properties).not.toHaveProperty('gatewayToken');
  });

  it('covers every action the built-in cron tool supported', () => {
    // Dropping one would silently remove capability the agents already use.
    expect(plugin.PARAMETERS.properties.action.enum).toEqual([
      'status', 'list', 'get', 'add', 'update', 'remove', 'run', 'runs', 'wake',
    ]);
    expect(plugin.PARAMETERS.required).toEqual(['action']);
  });

  it('registers a single tool named cron_job', () => {
    let registered: { name: string } | undefined;
    plugin.default({
      registerTool: (t) => {
        registered = (typeof t === 'function' ? (t as (c: Ctx) => { name: string })({}) : t) as { name: string };
      },
    });
    expect(registered?.name).toBe('cron_job');
  });
});

describe('trades-cron job construction', () => {
  const ctx: Ctx = {
    agentId: 'main',
    sessionKey: 'agent:main:main',
    deliveryContext: { channel: 'telegram', to: '12345' },
  };

  it('builds an isolated agentTurn job and inherits the live chat as announce target', () => {
    // This is the "remind me in an hour" path: the reply has to come back HERE.
    const job = plugin.buildJob(
      { at: '2026-08-04T16:30:00Z', message: 'run the freeze', name: 'freeze', deleteAfterRun: true },
      ctx,
    );
    expect(job).toMatchObject({
      name: 'freeze',
      schedule: { kind: 'at', at: '2026-08-04T16:30:00Z' },
      payload: { kind: 'agentTurn', message: 'run the freeze' },
      sessionTarget: 'isolated',
      deleteAfterRun: true,
      delivery: { mode: 'announce', channel: 'telegram', to: '12345' },
      agentId: 'main',
    });
    // Isolated jobs deliberately do NOT carry the caller's sessionKey.
    expect(job).not.toHaveProperty('sessionKey');
  });

  it('defaults a systemEvent job to the main session and binds the session key', () => {
    const job = plugin.buildJob({ at: '2026-08-04T16:30:00Z', text: 'stand-up' }, ctx);
    expect(job).toMatchObject({
      schedule: { kind: 'at' },
      payload: { kind: 'systemEvent', text: 'stand-up' },
      sessionTarget: 'main',
      sessionKey: 'agent:main:main',
    });
    // systemEvent jobs are not agent turns, so they get no delivery block.
    expect(job).not.toHaveProperty('delivery');
  });

  it('maps each schedule flavour to the kind the Gateway expects', () => {
    expect(plugin.buildSchedule({ at: '2026-08-04T16:30:00Z' })).toEqual({
      kind: 'at', at: '2026-08-04T16:30:00Z',
    });
    expect(plugin.buildSchedule({ everyMs: 900_000 })).toEqual({ kind: 'every', everyMs: 900_000 });
    expect(plugin.buildSchedule({ expr: '0 18 * * *', tz: 'America/Los_Angeles' })).toEqual({
      kind: 'cron', expr: '0 18 * * *', tz: 'America/Los_Angeles',
    });
    expect(plugin.buildSchedule({})).toBeUndefined();
  });

  it('honours an explicit delivery target over the ambient chat route', () => {
    expect(plugin.buildDelivery({ deliveryChannel: 'telegram', deliveryTo: '999' }, { channel: 'x', to: 'y' }))
      .toEqual({ mode: 'announce', channel: 'telegram', to: '999' });
    expect(plugin.buildDelivery({ deliveryMode: 'none' }, { channel: 'x', to: 'y' })).toEqual({ mode: 'none' });
    expect(plugin.buildDelivery({}, undefined)).toBeUndefined();
  });

  it('rejects a webhook delivery with no URL', () => {
    expect(() => plugin.buildDelivery({ deliveryMode: 'webhook' }, undefined)).toThrow(/requires deliveryTo/);
  });

  it('enforces the sessionTarget/payload pairing the Gateway requires', () => {
    expect(() =>
      plugin.buildJob({ at: '2026-08-04T16:30:00Z', message: 'x', sessionTarget: 'main' }, ctx),
    ).toThrow(/requires a systemEvent/);
    expect(() =>
      plugin.buildJob({ at: '2026-08-04T16:30:00Z', text: 'x', sessionTarget: 'isolated' }, ctx),
    ).toThrow(/requires an agentTurn/);
  });

  it('requires both a schedule and a payload', () => {
    expect(() => plugin.buildJob({ message: 'x' }, ctx)).toThrow(/schedule is required/);
    expect(() => plugin.buildJob({ at: '2026-08-04T16:30:00Z' }, ctx)).toThrow(/payload is required/);
  });

  it('builds a patch containing only the fields the caller named', () => {
    expect(plugin.buildPatch({ enabled: false }, ctx)).toEqual({ enabled: false });
    expect(plugin.buildPatch({ expr: '0 9 * * 1', tz: 'UTC' }, ctx)).toEqual({
      schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'UTC' },
    });
    // An empty patch would otherwise clear nothing and read as success.
    expect(() => plugin.buildPatch({}, ctx)).toThrow(/nothing to update/);
  });
});
