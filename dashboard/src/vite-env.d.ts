/// <reference types="vite/client" />

// Injected by vite.config.ts / vitest.config.ts `define` from the root
// package.json / .claims.json — the server version + claim counts the
// dashboard chrome displays.
declare const __IRIS_VERSION__: string;
declare const __IRIS_RULE_COUNT__: number;
