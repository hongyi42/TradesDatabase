// Client-side CSV generation for the prototype's "download records" action.
//
// The REAL export is asynchronous and server-side: a full spine export will not
// finish inside an HTTP request, the file is a new copy of customer PII that has
// to expire, and it must run through the typed db accessors so tenant scoping
// and sensitivity filtering are the same code the chat surfaces use. This
// module exists so the button in the prototype does something honest and
// testable against mock data — it is not the shipping implementation.

/** RFC 4180 quoting: wrap in quotes and double any embedded quote. */
function cell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  // CRLF line endings, because the person opening this is opening it in Excel.
  return [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
