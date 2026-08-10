/// <reference types="vite/client" />

// Side-effect CSS imports (tokens.css, the @fontsource faces) carry no types.
// Without this, `tsc --noEmit` fails on every one of them with TS2882.
declare module '*.css';
