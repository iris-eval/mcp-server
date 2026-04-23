import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { IrisConfig } from '../types/index.js';

const irisHome = join(homedir(), '.iris');

// Read version from package.json to avoid hardcoded drift
let pkgVersion = '0.1.8';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  pkgVersion = pkg.version;
} catch {
  // Fallback if package.json isn't resolvable at runtime
}

export const defaultConfig: IrisConfig = {
  storage: {
    type: 'sqlite',
    path: join(irisHome, 'iris.db'),
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
  },
  eval: {
    defaultThreshold: 0.7,
    ruleThresholds: {
      min_output_length: 50,
      min_sentences: 2,
      keyword_overlap: 0.35,
      topic_consistency: 0.10,
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
