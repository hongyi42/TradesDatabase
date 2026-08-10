import { describe, expect, test } from 'vitest';
import {
  CALL_INTENTS,
  CLASSIFY_CALL_TOOL,
  isCallIntent,
  defaultCallClassifier,
} from './classifyCall.js';
import { hasModelCredentials } from '../model/forcedTool.js';

// Always-on SHAPE test — the tool contract is what the router validates against,
// so a drift in the enum or the required fields must fail keyless (no model call).
describe('CLASSIFY_CALL_TOOL shape', () => {
  test('intents is an enum of the 6 labels; both fields required', () => {
    const props = CLASSIFY_CALL_TOOL.inputSchema.properties as
      | Record<string, { type?: string; items?: { type?: string; enum?: unknown } }>
      | undefined;
    expect(props?.intents.type).toBe('array');
    expect(props?.intents.items?.enum).toEqual([...CALL_INTENTS]);
    expect(CLASSIFY_CALL_TOOL.inputSchema.required).toEqual(['intents', 'reason']);
    expect(CLASSIFY_CALL_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  test('isCallIntent accepts the vocabulary and rejects anything else', () => {
    for (const label of CALL_INTENTS) expect(isCallIntent(label)).toBe(true);
    expect(isCallIntent('made_up_label')).toBe(false);
    expect(isCallIntent(42)).toBe(false);
    expect(isCallIntent(null)).toBe(false);
  });
});

// LIVE test: exercises the real router against whichever provider MODEL_PROVIDER
// selects. Gated on the ACTIVE provider's key so it follows the provider switch.
// 120s, not vitest's 30s default — GLM-5.2 on DeepInfra is slow (mirrors
// email/classify.test.ts). Kept to clear-cut fixtures to avoid model flakiness.
describe.skipIf(!hasModelCredentials())('defaultCallClassifier (live)', () => {
  test('a new-work call includes new_job', async () => {
    const r = await defaultCallClassifier(
      'Speaker A: Thanks for calling, front desk. Speaker B: Hi, my furnace stopped heating last ' +
        'night and I need someone to come take a look. My address is 22 Oak Street.',
    );
    expect(r.intents).toContain('new_job');
  }, 120_000);

  test('a cancel call includes cancel', async () => {
    const r = await defaultCallClassifier(
      'Speaker A: Front desk, how can I help. Speaker B: I need to cancel my appointment for ' +
        'tomorrow morning, something came up and I won\'t be home.',
    );
    expect(r.intents).toContain('cancel');
  }, 120_000);

  test('a two-request call returns both labels', async () => {
    const r = await defaultCallClassifier(
      'Speaker A: Front desk. Speaker B: Two things — please cancel my visit on Tuesday, and can ' +
        'you also send someone out for a new leak under my kitchen sink?',
    );
    expect(r.intents).toContain('cancel');
    expect(r.intents).toContain('new_job');
  }, 120_000);
});
