import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';

describe('toCsv', () => {
  it('quotes commas, quotes and newlines; empties null; JSON for objects', () => {
    const { csv, columns } = toCsv([
      { name: 'Acme, Inc.', note: 'said "soon"', addr: 'line 1\nline 2', balance: 0, paid: null },
      { name: 'Chen', note: 'plain', addr: 'x', balance: 12.5, paid: { at: '2026-09-01' } },
    ]);
    expect(columns).toEqual(['name', 'note', 'addr', 'balance', 'paid']);
    expect(csv).toBe(
      'name,note,addr,balance,paid\r\n' +
        '"Acme, Inc.","said ""soon""","line 1\nline 2",0,\r\n' +
        'Chen,plain,x,12.5,"{""at"":""2026-09-01""}"\r\n',
    );
  });

  it('the header is every key seen, first-seen order', () => {
    const { csv, columns } = toCsv([{ a: 1 }, { b: 2, a: 3 }]);
    expect(columns).toEqual(['a', 'b']);
    expect(csv).toBe('a,b\r\n1,\r\n3,2\r\n');
  });

  it('no rows is a lone empty header line', () => {
    expect(toCsv([])).toEqual({ csv: '\r\n', columns: [] });
  });
});
