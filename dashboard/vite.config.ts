import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard displays the SERVER's version — sourced from the root
// package.json at build time so chrome can never drift from the release
// (two components previously hardcoded '0.4.0' and shipped stale).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
// Same discipline for claim counts: build-time from the truthbase.
const claims = JSON.parse(readFileSync(new URL('../.claims.json', import.meta.url), 'utf-8')) as {
  evalRules: { builtInCount: number };
  brand: { tagline: string };
};

/*
 * index.html cannot import the truthbase, so its <title> carried the
 * pre-rebrand positioning through a rebrand release and into the npm
 * artifact. The placeholder %IRIS_TAGLINE% is filled here from
 * .claims.json brand.tagline — the same source the website and README
 * read — so the tab title moves with the brand instead of being a
 * second place to remember.
 */
function claimsHtml(): Plugin {
  return {
    name: 'iris-claims-html',
    transformIndexHtml(html) {
      return html.replace(/%IRIS_TAGLINE%/g, claims.brand.tagline);
    },
  };
}

export default defineConfig({
  plugins: [react(), claimsHtml()],
  define: {
    __IRIS_VERSION__: JSON.stringify(pkg.version),
    __IRIS_RULE_COUNT__: JSON.stringify(claims.evalRules.builtInCount),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:6920',
    },
  },
  build: {
    outDir: '../dist/dashboard',
    emptyOutDir: false,
  },
});
