import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { IrisConfig } from '../types/index.js';
import { defaultConfig } from './defaults.js';
import { assertValidCriticality } from '../eval/criticality.js';
import { irisHome } from '../utils/iris-home.js';

/*
 * Owner-only (0700) for the iris home directory, matching the 0600 the data
 * FILES inside it already get (write-atomic.ts, sqlite-adapter.ts). iris.db
 * holds agent inputs and outputs verbatim — a PII detector necessarily
 * stores the PII it found — and a 0755 directory beside 0600 files still
 * lets every local account list what is there and read anything a library
 * happens to create with the default umask (#372). The mode applies only
 * when THIS process creates the directory; a pre-existing IRIS_HOME keeps
 * whatever permissions its owner chose. No-op on Windows (ACLs govern).
 */
export const IRIS_HOME_DIR_MODE = 0o700;

/**
 * Create a directory Iris needs, or fail with ONE line that names the path
 * and the permission problem (#371). Before this, an unwritable IRIS_HOME
 * surfaced as a raw EPERM stack trace from deep inside mkdirSync — the
 * first thing a new user saw, with nothing telling them which variable to
 * change. Exported so --self-test probes the configured home through the
 * exact same call the server will make.
 */
export function ensureIrisDirectory(path: string, what: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(path, { recursive: true, mode: IRIS_HOME_DIR_MODE });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    throw new Error(
      `Cannot create ${what} "${path}" (${code}). Iris keeps its database, config and rule files there. ` +
        'Point IRIS_HOME at a directory this user can write, or fix the permissions on that path.',
    );
  }
}

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
  ensureIrisDirectory(home, 'IRIS_HOME');

  const configPath = cliArgs?.config ?? join(home, 'config.json');
  const fileConfig = loadConfigFile(configPath);
  const envConfig = loadEnvVars();
  const argsConfig = cliArgs ? cliArgsToConfig(cliArgs) : {};

  let config = deepMerge(defaultConfig, fileConfig);
  config = deepMerge(config, envConfig);
  config = deepMerge(config, argsConfig);

  ensureIrisDirectory(dirname(config.storage.path), 'the database directory (IRIS_DB_PATH / --db-path)');

  /*
   * Fail at STARTUP on a bad rule name, before a single evaluation runs.
   * A typo in eval.criticalRules that quietly did nothing would leave an
   * operator believing their deploy gate exists when it does not — the same
   * "detection that reports an all-clear" failure the veto exists to stop.
   */
  assertValidCriticality(config.eval);

  return config;
}
