import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { IrisConfig } from '../types/index.js';
import { irisHome } from '../utils/iris-home.js';

// Read version from package.json to avoid hardcoded drift
let pkgVersion = '0.1.8';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  pkgVersion = pkg.version;
} catch {
  // Fallback if package.json isn't resolvable at runtime
}

// The single runtime source for the server's own version — import this
// instead of hardcoding a literal (OTel resource attrs, health, banners).
export const PKG_VERSION = pkgVersion;

export const defaultConfig: IrisConfig = {
  storage: {
    type: 'sqlite',
    path: join(irisHome(), 'iris.db'),
  },
  server: {
    name: 'iris-eval',
    version: pkgVersion,
  },
  transport: {
    type: 'stdio',
    port: 3000,
    host: '127.0.0.1',
  },
  dashboard: {
    enabled: false,
    port: 6920,
    host: '127.0.0.1',
  },
  eval: {
    defaultThreshold: 0.7,
    ruleThresholds: {
      min_output_length: 50,
      min_sentences: 2,
      keyword_overlap: 0.35,
      // Share of content-bearing sentences that must connect to the input's
      // topic (a third — see topic_consistency in src/eval/rules/relevance.ts).
      topic_consistency: 0.33,
      cost_threshold: 0.10,
      max_token_ratio: 5,
    },
  },
  logging: {
    level: 'info',
  },
  retention: {
    days: 30,
  },
  security: {
    apiKey: undefined,
    allowedOrigins: ['http://localhost:*'],
    rateLimit: {
      /* Dashboard polls ~6 endpoints every 5–10s (Health view alone hits
       * stats + trend + audit + 2× moments + priorStats). At 100/min the
       * dashboard exhausts its own quota and surfaces 429s on /rules etc.
       * 600/min ≈ 10/s — still rejects abusive crawlers, but accommodates
       * a polling-heavy first-party dashboard with headroom for navigation
       * bursts. */
      api: 600,
      mcp: 20,
    },
    requestSizeLimit: '1mb',
  },
};
