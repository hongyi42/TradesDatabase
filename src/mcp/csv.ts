// Rows → CSV for /seat/export (step 2b): the manager seat's export_query writes
// this straight into its sandbox, so the model never retypes rows.
//
// RFC 4180: a field with a comma, a double quote, a CR or an LF is quoted, and
// a quote inside it doubled. The header is every key seen, in first-seen order
// (a later row may carry a key the first did not). null and undefined are empty;
// an object or array is its JSON; everything else is String(value).

function field(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[]): { csv: string; columns: string[] } {
  const columns: string[] = [];
  const seen = new Set<string>();
  const records = rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r }));
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  const lines = [columns.map(field).join(',')];
  for (const r of records) lines.push(columns.map((c) => field(r[c])).join(','));
  return { csv: `${lines.join('\r\n')}\r\n`, columns };
}
