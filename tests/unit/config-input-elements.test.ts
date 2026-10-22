/*
 * The element limit is set by security.maxInputElements in config.json or
 * IRIS_MAX_INPUT_ELEMENTS: 100,000 unless set, the environment wins over
 * the file, and a value that is not a whole number of at least 1 refuses
 * startup naming the setting, so a typo cannot quietly mean "no limit".
 * Its names before 0.21.0, when it bounded tool calls only
 * (maxToolInputElements, IRIS_MAX_TOOL_INPUT_ELEMENTS), are still read.
 * What the limit does is held in tests/integration/tool-input-elements.test.ts
 * (tool calls) and tests/integration/bounded-validation-errors.test.ts
 * (request bodies).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { DEFAULT_MAX_INPUT_ELEMENTS, defaultConfig, maxInputElementsOf, PROTOBUF_BYTES_PER_ELEMENT, protobufElementCeiling } from '../../src/config/defaults.js';

const VARS = ['IRIS_HOME', 'IRIS_DB_PATH', 'IRIS_MAX_INPUT_ELEMENTS', 'IRIS_MAX_TOOL_INPUT_ELEMENTS'] as const;
let scratch: string;
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  scratch = mkdtempSync(join(tmpdir(), 'iris-config-input-elements-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  process.env.IRIS_HOME = home;
  delete process.env.IRIS_DB_PATH;
  delete process.env.IRIS_MAX_INPUT_ELEMENTS;
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

describe('the element limit setting', () => {
  it('is 100,000 unless set', () => {
    expect(DEFAULT_MAX_INPUT_ELEMENTS).toBe(100_000);
    expect(defaultConfig.security.maxInputElements).toBe(100_000);
    expect(loadConfig().security.maxInputElements).toBe(100_000);
  });

  it('reads config.json, and the environment over it', () => {
    writeConfig({ security: { maxInputElements: 10_000 } });
    expect(loadConfig().security.maxInputElements).toBe(10_000);
    process.env.IRIS_MAX_INPUT_ELEMENTS = '250000';
    expect(loadConfig().security.maxInputElements).toBe(250_000);
  });

  it('refuses a value that is not a whole number of at least 1, naming the setting', () => {
    for (const bad of ['0', '-1', '1.5', '1e5', 'lots', '10,000']) {
      process.env.IRIS_MAX_INPUT_ELEMENTS = bad;
      expect(() => loadConfig(), bad).toThrow(
        `IRIS_MAX_INPUT_ELEMENTS=${JSON.stringify(bad)} is not valid (must be a whole number of at least 1, e.g. 100000)`,
      );
    }
    delete process.env.IRIS_MAX_INPUT_ELEMENTS;
    for (const bad of [0, -5, 2.5, '100000', null]) {
      writeConfig({ security: { maxInputElements: bad } });
      expect(() => loadConfig(), String(bad)).toThrow(/security\.maxInputElements/);
    }
    for (const good of ['1', ' 50000 ']) {
      process.env.IRIS_MAX_INPUT_ELEMENTS = good;
      writeConfig({});
      expect(loadConfig().security.maxInputElements).toBe(Number(good));
    }
  });
});

describe('its names before 0.21.0', () => {
  it('maxToolInputElements in config.json is read as maxInputElements', () => {
    writeConfig({ security: { maxToolInputElements: 20_000 } });
    const security = loadConfig().security as typeof defaultConfig.security & { maxToolInputElements?: number };
    expect(security.maxInputElements).toBe(20_000);
    expect(security.maxToolInputElements).toBeUndefined();
  });

  it('a config.json with both names is refused, naming them', () => {
    writeConfig({ security: { maxInputElements: 1_000, maxToolInputElements: 2_000 } });
    expect(() => loadConfig()).toThrow(/maxToolInputElements.*set maxInputElements only/);
  });

  it('IRIS_MAX_TOOL_INPUT_ELEMENTS is read when IRIS_MAX_INPUT_ELEMENTS is unset, and validated under its own name', () => {
    process.env.IRIS_MAX_TOOL_INPUT_ELEMENTS = '30000';
    expect(loadConfig().security.maxInputElements).toBe(30_000);
    process.env.IRIS_MAX_INPUT_ELEMENTS = '40000';
    expect(loadConfig().security.maxInputElements).toBe(40_000);
    delete process.env.IRIS_MAX_INPUT_ELEMENTS;
    process.env.IRIS_MAX_TOOL_INPUT_ELEMENTS = 'lots';
    expect(() => loadConfig()).toThrow('IRIS_MAX_TOOL_INPUT_ELEMENTS="lots" is not valid');
  });

  it('a config object built in code with the old name still sets the limit', () => {
    expect(maxInputElementsOf({ maxToolInputElements: 7 })).toBe(7);
    expect(maxInputElementsOf({ maxInputElements: 9, maxToolInputElements: 7 })).toBe(9);
    expect(maxInputElementsOf(undefined)).toBe(DEFAULT_MAX_INPUT_ELEMENTS);
  });
});

describe('the protobuf ceiling', () => {
  it('is one element per 5 bytes of the request size limit, or the shared limit when that is higher', () => {
    expect(PROTOBUF_BYTES_PER_ELEMENT).toBe(5);
    // The default 1 MB: above the 139,641 per MB of the densest real exporter body measured (python-plain.pb).
    expect(protobufElementCeiling(DEFAULT_MAX_INPUT_ELEMENTS, 1024 ** 2)).toBe(209_716);
    // It rises with the byte limit, so a larger request size keeps taking whole batches.
    expect(protobufElementCeiling(DEFAULT_MAX_INPUT_ELEMENTS, 10 * 1024 ** 2)).toBe(2_097_152);
    // And never falls below the shared limit.
    expect(protobufElementCeiling(500_000, 1024 ** 2)).toBe(500_000);
    expect(protobufElementCeiling(10_000, 1024 ** 2)).toBe(209_716);
  });
});
