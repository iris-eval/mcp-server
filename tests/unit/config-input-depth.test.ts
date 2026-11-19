/*
 * The nesting limit is set by security.maxInputDepth in config.json or
 * IRIS_MAX_INPUT_DEPTH: 256 unless set, the environment wins over the file,
 * and a value that is not a whole number from 1 to 512 refuses startup
 * naming the setting, so a typo cannot quietly mean "no limit" and the door
 * cannot be set past what the engine evaluates. What the limit does is held
 * in tests/integration/input-depth-limit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { DEFAULT_MAX_INPUT_DEPTH, defaultConfig, maxInputDepthOf } from '../../src/config/defaults.js';
import type { IrisConfig } from '../../src/types/config.js';
import { MAX_EVALUATED_DEPTH } from '../../src/utils/element-count.js';

const VARS = ['IRIS_HOME', 'IRIS_DB_PATH', 'IRIS_MAX_INPUT_DEPTH'] as const;
let scratch: string;
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  scratch = mkdtempSync(join(tmpdir(), 'iris-config-input-depth-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  process.env.IRIS_HOME = home;
  delete process.env.IRIS_DB_PATH;
  delete process.env.IRIS_MAX_INPUT_DEPTH;
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const writeConfig = (value: unknown) => writeFileSync(join(home, 'config.json'), JSON.stringify(value));

describe('the nesting limit setting', () => {
  it('is 256 unless set', () => {
    expect(DEFAULT_MAX_INPUT_DEPTH).toBe(256);
    expect(defaultConfig.security.maxInputDepth).toBe(256);
    expect(loadConfig().security.maxInputDepth).toBe(256);
  });

  it('reads config.json, and the environment over it', () => {
    writeConfig({ security: { maxInputDepth: 64 } });
    expect(loadConfig().security.maxInputDepth).toBe(64);
    process.env.IRIS_MAX_INPUT_DEPTH = '500';
    expect(loadConfig().security.maxInputDepth).toBe(500);
  });

  it('refuses a value that is not a whole number from 1 to the deepest the engine evaluates, naming the setting', () => {
    // The engine refuses an input nested deeper than MAX_EVALUATED_DEPTH whatever the door let in, so the door cannot be set past it.
    expect(MAX_EVALUATED_DEPTH).toBe(512);
    for (const bad of ['0', '-1', '1.5', '1e2', 'deep', '1,000', '513', '100000']) {
      process.env.IRIS_MAX_INPUT_DEPTH = bad;
      expect(() => loadConfig(), bad).toThrow(`IRIS_MAX_INPUT_DEPTH=${JSON.stringify(bad)} is not valid (must be a whole number from 1 to 512, e.g. 256)`);
    }
    delete process.env.IRIS_MAX_INPUT_DEPTH;
    for (const bad of [0, -5, 2.5, '256', null, 513]) {
      writeConfig({ security: { maxInputDepth: bad } });
      expect(() => loadConfig(), String(bad)).toThrow(/security\.maxInputDepth/);
    }
    for (const good of ['1', ' 500 ', '512']) {
      process.env.IRIS_MAX_INPUT_DEPTH = good;
      writeConfig({});
      expect(loadConfig().security.maxInputDepth).toBe(Number(good));
    }
  });

  it('leaves the element limit as it was, and is left by it', () => {
    writeConfig({ security: { maxInputDepth: 32, maxInputElements: 5_000 } });
    const { security } = loadConfig();
    expect(security.maxInputDepth).toBe(32);
    expect(security.maxInputElements).toBe(5_000);
  });

  it('is the default for a config object built without the key', () => {
    // An embedder's config, made before the key existed.
    const security: IrisConfig['security'] = { ...defaultConfig.security };
    delete security.maxInputDepth;
    expect('maxInputDepth' in security).toBe(false);
    expect(maxInputDepthOf(security)).toBe(256);
    expect(maxInputDepthOf(undefined)).toBe(256);
    expect(maxInputDepthOf({ maxInputDepth: 12 })).toBe(12);
  });
});
