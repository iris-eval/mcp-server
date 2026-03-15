import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IrisConfig } from '../types/index.js';

const irisHome = join(homedir(), '.iris');

export const defaultConfig: IrisConfig = {
  storage: {
    type: 'sqlite',
    path: join(irisHome, 'iris.db'),
  },
  server: {
    name: 'iris-eval',
    version: '0.1.0',
  },
  transport: {
    type: 'stdio',
    port: 3000,
    host: '0.0.0.0',
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
