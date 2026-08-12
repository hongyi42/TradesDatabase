import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted, per both handoffs ("the prototype loads them from Google Fonts
// for preview only — self-host woff2 from your own origin before this ships").
// Bundled from @fontsource so there is no CDN request at runtime, which is also
// the reason the landing has no video embed and no trackers.
//
// Two type systems on one origin, on purpose. The signed-in app runs Archivo /
// Inter Tight / JetBrains Mono; the landing runs the landing handoff's Chivo /
// IBM Plex Sans / IBM Plex Mono, which it rebinds onto the same three role
// variables inside `.landing`. The landing deliberately does not match the app.
//
// Latin subsets only — the landing handoff budgets ~180 KB for its three
// families and nothing on either surface is set in Cyrillic, Greek or
// Vietnamese.
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo/800.css';
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/chivo/latin-600.css';
import '@fontsource/chivo/latin-700.css';
import '@fontsource/chivo/latin-900.css';
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
