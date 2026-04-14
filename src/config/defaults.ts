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
      api: 100,
      mcp: 20,
    },
    requestSizeLimit: '1mb',
  },
};
