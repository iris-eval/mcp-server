import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { IrisConfig } from '../types/index.js';
import { defaultConfig } from './defaults.js';

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
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as Partial<IrisConfig>;
  } catch {
    return {};
  }
}

function loadEnvVars(): Partial<IrisConfig> {
  const config: Record<string, unknown> = {};

  if (process.env.IRIS_TRANSPORT) {
    config.transport = { type: process.env.IRIS_TRANSPORT };
  }
  if (process.env.IRIS_PORT) {
    config.transport = { ...(config.transport as object), port: parseInt(process.env.IRIS_PORT) };
  }
  if (process.env.IRIS_DB_PATH) {
    config.storage = { type: 'sqlite', path: process.env.IRIS_DB_PATH };
  }
  if (process.env.IRIS_LOG_LEVEL) {
    config.logging = { level: process.env.IRIS_LOG_LEVEL };
  }
  if (process.env.IRIS_DASHBOARD) {
    config.dashboard = { enabled: process.env.IRIS_DASHBOARD === 'true' };
  }
  if (process.env.IRIS_DASHBOARD_PORT) {
    config.dashboard = {
      ...(config.dashboard as object),
      port: parseInt(process.env.IRIS_DASHBOARD_PORT),
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
  if (args.apiKey) {
    config.security = { ...(config.security as object), apiKey: args.apiKey };
  }

  return config as Partial<IrisConfig>;
}

export function loadConfig(cliArgs?: CliArgs): IrisConfig {
  const irisHome = join(homedir(), '.iris');
  if (!existsSync(irisHome)) {
    mkdirSync(irisHome, { recursive: true });
  }

  const configPath = cliArgs?.config ?? join(irisHome, 'config.json');
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
