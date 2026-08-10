#!/usr/bin/env node
// Fold the built portal into ONE self-contained HTML file.
//
// Why: the portal runs entirely on mock data, so it is a genuine standalone
// demo — but `web/portal/dist` is a directory of hashed assets that only works
// behind a server at the /portal base path. That is awkward to hand to a
// colleague. This produces a single file that opens from a double-click, an
// email attachment, a Slack upload or a static host, with no install, no
// server and no network access at runtime (fonts are embedded, so it renders
// identically offline).
//
// Not a build step for production — `npm run portal:build` remains what the
// server serves. Run this only when you want something shareable.
//
//   npm run portal:build && npm run portal:standalone

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('web/portal/dist');
const OUT = path.join(DIST, 'standalone.html');

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('portal-standalone: no build found. Run `npm run portal:build` first.');
  process.exit(1);
}

const MIME = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const dataUri = (file) => {
  const ext = path.extname(file);
  const type = MIME[ext];
  if (!type) return null;
  return `data:${type};base64,${readFileSync(path.join(DIST, file)).toString('base64')}`;
};

let html = readFileSync(path.join(DIST, 'index.html'), 'utf8');

// ── CSS: inline the stylesheet, embedding every asset it references ─────────
// Only .woff2 is embedded. @fontsource emits a .woff fallback beside each
// .woff2 and inlining both would roughly double the file for browsers that
// have supported woff2 since 2015; the fallback src is dropped instead.
let embedded = 0;
let dropped = 0;

html = html.replace(
  /<link[^>]+rel="stylesheet"[^>]*href="\/portal\/([^"]+)"[^>]*>/g,
  (_m, href) => {
    let css = readFileSync(path.join(DIST, href), 'utf8');
    css = css.replace(/url\(\s*["']?\/portal\/([^"')]+)["']?\s*\)(\s*format\(["'][^"']+["']\))?/g,
      (whole, asset, fmt) => {
        if (asset.endsWith('.woff')) {
          dropped += 1;
          return '/* woff fallback dropped */';
        }
        const uri = dataUri(asset);
        if (!uri) return whole;
        embedded += 1;
        return `url(${uri})${fmt ?? ''}`;
      });
    // Dropping a src leaves stray commas in the src list — tidy them so the
    // declaration stays valid.
    css = css.replace(/,\s*\/\* woff fallback dropped \*\//g, '');
    css = css.replace(/\/\* woff fallback dropped \*\/\s*,\s*/g, '');
    css = css.replace(/\/\* woff fallback dropped \*\//g, '');
    return `<style>\n${css}\n</style>`;
  },
);

// ── JS: inline the module bundle ────────────────────────────────────────────
html = html.replace(
  /<script[^>]*type="module"[^>]*src="\/portal\/([^"]+)"[^>]*><\/script>/g,
  (_m, src) => {
    const js = readFileSync(path.join(DIST, src), 'utf8');
    // </script> inside a string literal would close the tag early.
    return `<script type="module">\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;
  },
);

// A banner so nobody mistakes the demo for the live product.
html = html.replace(
  '</title>',
  '</title>\n<!-- Standalone demo build: mock data only, nothing is wired to an API. -->',
);

const leftovers = [...html.matchAll(/["'(]\/portal\/[^"')]+/g)].map((m) => m[0]);
if (leftovers.length) {
  console.error(`portal-standalone: ${leftovers.length} unresolved reference(s):`);
  for (const l of new Set(leftovers)) console.error('  ' + l);
  process.exit(1);
}

writeFileSync(OUT, html);
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`portal-standalone: ${OUT}`);
console.log(`  ${mb} MB · ${embedded} font(s) embedded · ${dropped} woff fallback(s) dropped`);
