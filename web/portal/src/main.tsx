import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted, per both handoffs ("the prototype loads them from Google Fonts
// for preview only — self-host woff2 from your own origin before this ships").
// Bundled from @fontsource so there is no CDN request at runtime, which is also
// the reason the landing has no video embed and no trackers.
//
// Two type systems on one origin, on purpose. The signed-in app runs Archivo /
// Inter Tight / JetBrains Mono; the landing runs IBM Plex Sans /
// IBM Plex Mono (Carbon; Chivo was dropped in the 2026-08-21 migration), which it rebinds onto the same three role
// variables inside `.landing`. The landing deliberately does not match the app.
//
// Latin subsets only — the landing handoff budgets ~180 KB for its three
// families and nothing on either surface is set in Cyrillic, Greek or
// Vietnamese.
import '@fontsource/archivo/latin-600.css';
import '@fontsource/archivo/latin-700.css';
import '@fontsource/archivo/latin-800.css';
import '@fontsource/inter-tight/latin-400.css';
import '@fontsource/inter-tight/latin-500.css';
import '@fontsource/inter-tight/latin-600.css';
import '@fontsource/inter-tight/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
// 300 is Carbon's display weight and the landing's h1/h2/prices all use it.
// Without this import the browser synthesises it from 400 and the signature
// light display treatment silently disappears.
import '@fontsource/ibm-plex-sans/latin-300.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './tokens.css';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('portal: #root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
