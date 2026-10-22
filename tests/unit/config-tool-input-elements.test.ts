/*
 * The tool-input element limit is set by security.maxToolInputElements in
 * config.json or IRIS_MAX_TOOL_INPUT_ELEMENTS: 100,000 unless set, the
 * environment wins over the file, and a value that is not a whole number of
 * at least 1 refuses startup naming the setting, so a typo cannot quietly
 * mean "no limit". What the limit does to a tool call is held in
 * tests/integration/tool-input-elements.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { DEFAULT_MAX_TOOL_INPUT_ELEMENTS, defaultConfig } from '../../src/config/defaults.js';

const VARS = ['IRIS_HOME', 'IRIS_DB_PATH', 'IRIS_MAX_TOOL_INPUT_ELEMENTS'] as const;
let scratch: string;
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  scratch = mkdtempSync(join(tmpdir(), 'iris-config-tool-input-elements-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  process.env.IRIS_HOME = home;
  delete process.env.IRIS_DB_PATH;
  delete process.env.IRIS_MAX_TOOL_INPUT_ELEMENTS;
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const writeConfig = (value: unknown) => writeFileSync(join(home, 'config.json'), JSON.stringify(value));

describe('the tool-input element limit setting', () => {
  it('is 100,000 unless set', () => {
    expect(DEFAULT_MAX_TOOL_INPUT_ELEMENTS).toBe(100_000);
    expect(defaultConfig.security.maxToolInputElements).toBe(100_000);
    expect(loadConfig().security.maxToolInputElements).toBe(100_000);
  });

  it('reads config.json, and the environment over it', () => {
    writeConfig({ security: { maxToolInputElements: 10_000 } });
    expect(loadConfig().security.maxToolInputElements).toBe(10_000);
    process.env.IRIS_MAX_TOOL_INPUT_ELEMENTS = '250000';
    expect(loadConfig().security.maxToolInputElements).toBe(250_000);
  });

  it('refuses a value that is not a whole number of at least 1, naming the setting', () => {
    for (const bad of ['0', '-1', '1.5', '1e5', 'lots', '10,000']) {
      process.env.IRIS_MAX_TOOL_INPUT_ELEMENTS = bad;
      expect(() => loadConfig(), bad).toThrow(
        `IRIS_MAX_TOOL_INPUT_ELEMENTS=${JSON.stringify(bad)} is not valid (must be a whole number of at least 1, e.g. 100000)`,
      );
    }
    delete process.env.IRIS_MAX_TOOL_INPUT_ELEMENTS;
    for (const bad of [0, -5, 2.5, '100000', null]) {
      writeConfig({ security: { maxToolInputElements: bad } });
      expect(() => loadConfig(), String(bad)).toThrow(/security\.maxToolInputElements/);
    }
    for (const good of ['1', ' 50000 ']) {
      process.env.IRIS_MAX_TOOL_INPUT_ELEMENTS = good;
      writeConfig({});
      expect(loadConfig().security.maxToolInputElements).toBe(Number(good));
    }
  });
});
