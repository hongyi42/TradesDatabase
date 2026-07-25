import { describe, expect, test } from 'vitest';
import { coerceBySchema, parseOpenAiToolArgs, type JsonSchemaObject } from './forcedTool.js';

// Pure tests — no network. These cover the two things that differ between the
// Anthropic and OpenAI-compatible wire formats and can therefore break silently:
// where the tool arguments live in the reply, and what TYPE they arrive as.

const okReply = (name: string, args: unknown) => ({
  choices: [{ message: { content: null, tool_calls: [{ function: { name, arguments: args } }] } }],
});

describe('parseOpenAiToolArgs', () => {
  test('parses the arguments JSON string into an object', () => {
    const body = okReply('classify_email', '{"isWork":true,"reason":"quote request"}');
    expect(parseOpenAiToolArgs(body, 'classify_email', 'test')).toEqual({
      isWork: true,
      reason: 'quote request',
    });
  });

  test('accepts arguments already given as an object', () => {
    // Not all OpenAI-compatible gateways stringify; both shapes must work.
    const body = okReply('classify_email', { isWork: false, reason: 'newsletter' });
    expect(parseOpenAiToolArgs(body, 'classify_email', 'test')).toEqual({
      isWork: false,
      reason: 'newsletter',
    });
  });

  test('picks the call matching the tool name, ignoring others', () => {
    const body = {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'something_else', arguments: '{"x":1}' } },
              { function: { name: 'record_answer', arguments: '{"answer":"yes"}' } },
            ],
          },
        },
      ],
    };
    expect(parseOpenAiToolArgs(body, 'record_answer', 'test')).toEqual({ answer: 'yes' });
  });

  test('throws when the model answered with prose instead of the forced tool call', () => {
    const body = { choices: [{ message: { content: 'Sure, that email looks work related.' } }] };
    expect(() => parseOpenAiToolArgs(body, 'classify_email', 'defaultClassifier')).toThrow(
      'defaultClassifier: model returned no classify_email tool call',
    );
  });

  test('throws on a malformed arguments string rather than returning a partial object', () => {
    const body = okReply('classify_email', '{"isWork":true,');
    expect(() => parseOpenAiToolArgs(body, 'classify_email', 'defaultClassifier')).toThrow(
      'not valid JSON',
    );
  });

  test('throws when arguments decode to a non-object', () => {
    const body = okReply('classify_email', '"just a string"');
    expect(() => parseOpenAiToolArgs(body, 'classify_email', 'defaultClassifier')).toThrow(
      'not valid JSON',
    );
  });

  test('throws on an empty reply body', () => {
    expect(() => parseOpenAiToolArgs({}, 'classify_email', 'defaultClassifier')).toThrow(
      'no classify_email tool call',
    );
  });
});

describe('coerceBySchema', () => {
  const classifySchema: JsonSchemaObject = {
    type: 'object',
    properties: { isWork: { type: 'boolean' }, reason: { type: 'string' } },
  };

  test('coerces a quoted boolean — the classify-before-L1 gate depends on it', () => {
    // "false" is truthy as a string: without this, a personal email would be
    // appended to the append-only L1 log and could never be removed.
    expect(coerceBySchema({ isWork: 'false', reason: 'newsletter' }, classifySchema)).toEqual({
      isWork: false,
      reason: 'newsletter',
    });
    expect(coerceBySchema({ isWork: 'true', reason: 'quote' }, classifySchema)).toEqual({
      isWork: true,
      reason: 'quote',
    });
  });

  test('leaves correctly-typed values untouched', () => {
    expect(coerceBySchema({ isWork: true, reason: 'quote' }, classifySchema)).toEqual({
      isWork: true,
      reason: 'quote',
    });
  });

  const extractSchema: JsonSchemaObject = {
    type: 'object',
    properties: {
      laborHours: { type: 'number' },
      customerName: { type: 'string' },
      attributes: { type: 'object', additionalProperties: true },
    },
  };

  test('coerces a quoted number into a numeric L2 field', () => {
    // Documented GLM quirk — see scripts/eval-date-reliability.mjs:88-92.
    expect(coerceBySchema({ laborHours: '4', customerName: 'Ada' }, extractSchema)).toEqual({
      laborHours: 4,
      customerName: 'Ada',
    });
    expect(coerceBySchema({ laborHours: '2.5' }, extractSchema)).toEqual({ laborHours: 2.5 });
    expect(coerceBySchema({ laborHours: '0' }, extractSchema)).toEqual({ laborHours: 0 });
  });

  test('does NOT coerce inside a free-form attributes bag', () => {
    // A gate code of "0412" must stay a string — attributes has no declared
    // property types, so nothing inside it is schema-typed.
    const out = coerceBySchema(
      { attributes: { gateCode: '0412', petCount: '2' } },
      extractSchema,
    ) as { attributes: Record<string, unknown> };
    expect(out.attributes.gateCode).toBe('0412');
    expect(out.attributes.petCount).toBe('2');
  });

  test('leaves a non-numeric string alone rather than producing NaN', () => {
    expect(coerceBySchema({ laborHours: 'about four' }, extractSchema)).toEqual({
      laborHours: 'about four',
    });
  });

  test('does not touch keys the schema does not declare', () => {
    expect(coerceBySchema({ unknownField: '7' }, extractSchema)).toEqual({ unknownField: '7' });
  });

  const answerSchema: JsonSchemaObject = {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: { claim: { type: 'string' }, captureId: { type: 'string' } },
        },
      },
    },
  };

  test('recurses into arrays of objects without altering citation ids', () => {
    const input = {
      answer: 'Capacitor was replaced.',
      citations: [{ claim: 'Capacitor replaced', captureId: '0e9c1f2a-1111-2222-3333-444455556666' }],
    };
    expect(coerceBySchema(input, answerSchema)).toEqual(input);
  });

  test('tolerates a missing optional field', () => {
    expect(coerceBySchema({ answer: 'Unknown.' }, answerSchema)).toEqual({ answer: 'Unknown.' });
  });
});
