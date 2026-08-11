import { describe, expect, test } from 'vitest';
import { formatDiarized } from './transcribe.js';

// formatDiarized is the pure shaping step over an AssemblyAI multichannel result;
// tested directly (the network call around it is not unit-tested).
describe('formatDiarized', () => {
  test('two-channel utterances → role-labeled, time-ordered dialog', () => {
    const out = formatDiarized({
      status: 'completed',
      audio_channels: 2,
      utterances: [
        { speaker: '2', channel: '2', text: 'Hi,' },
        { speaker: '1', channel: '1', text: 'I need to cancel my appointment tomorrow.' },
        { speaker: '2', channel: '2', text: 'No problem, I will take care of that.' },
      ],
      text: 'ignored when utterances exist',
    });
    expect(out).toBe(
      ['Business: Hi,', 'Caller: I need to cancel my appointment tomorrow.', 'Business: No problem, I will take care of that.'].join('\n'),
    );
  });

  test('falls back to `speaker` when `channel` is absent', () => {
    const out = formatDiarized({
      status: 'completed',
      audio_channels: 2,
      utterances: [
        { speaker: '1', text: 'caller line' },
        { speaker: '2', text: 'business line' },
      ],
    });
    expect(out).toBe('Caller: caller line\nBusiness: business line');
  });

  test('a single distinct channel (mono / one speaker) → plain text, NOT a faked dialog', () => {
    const out = formatDiarized({
      status: 'completed',
      audio_channels: 1,
      utterances: [
        { speaker: '1', channel: '1', text: 'all one side' },
        { speaker: '1', channel: '1', text: 'still one side' },
      ],
      text: 'all one side still one side',
    });
    expect(out).toBe('all one side still one side');
  });

  test('no utterances → plain text', () => {
    expect(formatDiarized({ status: 'completed', text: 'just the raw text' })).toBe('just the raw text');
  });

  test('an unexpected channel number → generic Channel label, still separated', () => {
    const out = formatDiarized({
      status: 'completed',
      audio_channels: 3,
      utterances: [
        { channel: '1', text: 'a' },
        { channel: '3', text: 'b' },
      ],
    });
    expect(out).toBe('Caller: a\nChannel 3: b');
  });
});
