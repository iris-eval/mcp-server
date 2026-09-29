import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
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

/*
 * A .br and a .gz beside every text file this build emits, compressed once
 * at the strongest settings, so the server sends the smallest bytes without
 * spending CPU per request (src/dashboard/compression.ts serves them). A
 * variant is written only where it is smaller than the file; any variant
 * left from an earlier build is removed first, so none can outlive the file
 * it was made from. Dot-paths (.vite/manifest.json) are never served, so
 * they get none.
 */
const PRECOMPRESS = /\.(?:js|mjs|css|html|svg|json|txt)$/;
function precompress(): Plugin {
  return {
    name: 'iris-precompress',
    apply: 'build',
    writeBundle(options, bundle) {
      const dir = options.dir ?? '../dist/dashboard';
      for (const [fileName, output] of Object.entries(bundle)) {
        if (!PRECOMPRESS.test(fileName) || fileName.split('/').some((part) => part.startsWith('.'))) continue;
        const file = join(dir, fileName);
        for (const ext of ['.br', '.gz']) rmSync(file + ext, { force: true });
        const bytes = Buffer.from(output.type === 'chunk' ? output.code : output.source);
        if (bytes.length < 1024) continue;
        const br = brotliCompressSync(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
        });
        const gz = gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
        if (br.length < bytes.length) writeFileSync(`${file}.br`, br);
        if (gz.length < bytes.length) writeFileSync(`${file}.gz`, gz);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), claimsHtml(), precompress()],
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
    // Read by scripts/check-bundle-size.mjs to tell the first load from the
    // chunks loaded on demand (#662). Written to .vite/, which the dashboard
    // server does not serve.
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            /*
             * The d3 modules the Health and Drift charts are drawn with,
             * under one stable name, so the bundle budget can name the
             * chunk rather than whichever chart component Rolldown would
             * otherwise name it after.
             */
            { name: 'd3', test: /[\\/]node_modules[\\/](d3-[^\\/]+|internmap)[\\/]/ },
          ],
        },
      },
    },
  },
});
