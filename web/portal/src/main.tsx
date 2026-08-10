import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted, per the handoff ("Fonts load from Google Fonts — self-host in
// production"). Bundled from @fontsource so there is no CDN request at runtime.
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './tokens.css';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('portal: #root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
