// The model writes Markdown; Telegram renders its own HTML subset
// (core.telegram.org/bots/api, "HTML style": b, i, code, a href). The seat's
// doctrine relies on this — "[See it on the board](…)" must arrive as a
// tappable link, as it did through openclaw — so replies go out as HTML.
//
// Only the forms the seats actually write are converted: links, **bold**,
// *italic*, `code`, # headings, and "* " / "- " bullets. Everything else is
// escaped text. If Telegram still rejects a message (a 400 on malformed HTML),
// telegram.ts resends that chunk as plain text rather than losing the reply.

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

export function toTelegramHtml(md: string): string {
  // Links first, parked behind placeholders, so their URLs are escaped once
  // and no later rule rewrites them.
  const links: string[] = [];
  let s = md.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => {
    links.push(`<a href="${escAttr(url)}">${esc(text)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^([ \t]*)[*-][ \t]+/gm, '$1• ');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? '');
}
