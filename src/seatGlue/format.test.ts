import { describe, expect, it } from 'vitest';
import { toTelegramHtml } from './format.js';

describe('toTelegramHtml', () => {
  it('turns the board link into a tappable link', () => {
    expect(toTelegramHtml('[See it on the board](https://board.example/day?d=2026-09-23&t=1)')).toBe(
      '<a href="https://board.example/day?d=2026-09-23&amp;t=1">See it on the board</a>',
    );
  });

  it('renders bold, italic, code, headings and bullets', () => {
    expect(toTelegramHtml('**16:00** – Tom Becker')).toBe('<b>16:00</b> – Tom Becker');
    expect(toTelegramHtml('it is *probably* fine')).toBe('it is <i>probably</i> fine');
    expect(toTelegramHtml('serial `7Q4-88213`')).toBe('serial <code>7Q4-88213</code>');
    expect(toTelegramHtml('## Tomorrow')).toBe('<b>Tomorrow</b>');
    expect(toTelegramHtml('* one\n- two')).toBe('• one\n• two');
  });

  it('escapes everything else, so stray symbols cannot break the markup', () => {
    expect(toTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    expect(toTelegramHtml('2*3*4 and snake_case_name')).toBe('2*3*4 and snake_case_name');
  });

  it('leaves a non-http link as text', () => {
    expect(toTelegramHtml('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });
});
