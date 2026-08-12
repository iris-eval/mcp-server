import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { IrisConfig } from '../types/index.js';
import { defaultConfig } from './defaults.js';
import { irisHome } from '../utils/iris-home.js';

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    if (
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof result[key] === 'object' &&
      result[key] !== null
    ) {
      result[key] = deepMerge(result[key], sourceVal);
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result;
}

function loadConfigFile(path: string): Partial<IrisConfig> {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(content) as Partial<IrisConfig>;
  } catch (err: unknown) {
    throw new Error(`Invalid JSON in config file ${path}: ${(err as Error).message}`);
  }
}

function parsePortEnv(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`${name}=${JSON.stringify(value)} is not a valid port (must be an integer 1-65535)`);
  }
  return n;
}

/*
 * IRIS_DASHBOARD used to be `value === 'true'`, which silently read every
 * other spelling — 1, yes, on, TRUE — as an explicit DISABLE that then
 * overrode config.json's dashboard.enabled in the layer merge. The user who
 * exported IRIS_DASHBOARD=1 got no dashboard plus a pointer log telling
 * them to set the very variable they believed they had set. Unrecognized
 * values now throw, same contract as parsePortEnv: loud beats silently
 * wrong for a startup switch.
 */
function parseBooleanEnv(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(
    `${name}=${JSON.stringify(value)} is not a valid boolean (use true/1/yes/on or false/0/no/off)`,
  );
}

function loadEnvVars(): Partial<IrisConfig> {
  const config: Record<string, unknown> = {};

  if (process.env.IRIS_TRANSPORT) {
    config.transport = { type: process.env.IRIS_TRANSPORT };
  }
  if (process.env.IRIS_PORT) {
    config.transport = { ...(config.transport as object), port: parsePortEnv(process.env.IRIS_PORT, 'IRIS_PORT') };
  }
  if (process.env.IRIS_HOST) {
    config.transport = { ...(config.transport as object), host: process.env.IRIS_HOST };
  }
  if (process.env.IRIS_DB_PATH) {
    config.storage = { type: 'sqlite', path: process.env.IRIS_DB_PATH };
  }
  if (process.env.IRIS_LOG_LEVEL) {
    config.logging = { level: process.env.IRIS_LOG_LEVEL };
  }
  if (process.env.IRIS_DASHBOARD) {
    config.dashboard = { enabled: parseBooleanEnv(process.env.IRIS_DASHBOARD, 'IRIS_DASHBOARD') };
  }
  if (process.env.IRIS_DASHBOARD_PORT) {
    config.dashboard = {
      ...(config.dashboard as object),
      port: parsePortEnv(process.env.IRIS_DASHBOARD_PORT, 'IRIS_DASHBOARD_PORT'),
    };
  }
  if (process.env.IRIS_DASHBOARD_HOST) {
    config.dashboard = {
      ...(config.dashboard as object),
      host: process.env.IRIS_DASHBOARD_HOST,
    };
  }
  if (process.env.IRIS_API_KEY) {
    config.security = { ...(config.security as object), apiKey: process.env.IRIS_API_KEY };
  }
  if (process.env.IRIS_ALLOWED_ORIGINS) {
    config.security = {
      ...(config.security as object),
      allowedOrigins: process.env.IRIS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
    };
  }

  return config as Partial<IrisConfig>;
}

export interface CliArgs {
  transport?: string;
  port?: number;
  config?: string;
  dbPath?: string;
  dashboard?: boolean;
  dashboardPort?: number;
  dashboardHost?: string;
  apiKey?: string;
}

function cliArgsToConfig(args: CliArgs): Partial<IrisConfig> {
  const config: Record<string, unknown> = {};

  if (args.transport) {
    config.transport = { type: args.transport };
  }
  if (args.port) {
    config.transport = { ...(config.transport as object), port: args.port };
  }
  if (args.dbPath) {
    config.storage = { type: 'sqlite', path: args.dbPath };
  }
  if (args.dashboard !== undefined) {
    config.dashboard = { enabled: args.dashboard };
  }
  if (args.dashboardPort) {
    config.dashboard = { ...(config.dashboard as object), port: args.dashboardPort };
  }
  if (args.dashboardHost) {
    config.dashboard = { ...(config.dashboard as object), host: args.dashboardHost };
  }
  if (args.apiKey) {
    config.security = { ...(config.security as object), apiKey: args.apiKey };
  }

  return config as Partial<IrisConfig>;
}

export function loadConfig(cliArgs?: CliArgs): IrisConfig {
  const home = irisHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }

  const configPath = cliArgs?.config ?? join(home, 'config.json');
  const fileConfig = loadConfigFile(configPath);
  const envConfig = loadEnvVars();
  const argsConfig = cliArgs ? cliArgsToConfig(cliArgs) : {};

  let config = deepMerge(defaultConfig, fileConfig);
  config = deepMerge(config, envConfig);
  config = deepMerge(config, argsConfig);

  const dbDir = dirname(config.storage.path);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  return config;
}
