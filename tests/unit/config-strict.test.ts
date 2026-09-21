/*
 * config.json is strict (arc 8, R-6).
 *
 * Until 0.15.0 loadConfig deep-merged whatever the file held, so a typo —
 * `eval.critcalRules` — merged in silently and did nothing while the file
 * said the deploy gate existed. Verified against main's loader before the
 * change (the PR body carries the run): the same file booted with
 * `criticalRules: []` and `retention.days` as the string "30". Now a key
 * Iris does not read, or a value of the wrong type, refuses startup naming
 * it — every problem in one sentence, the closest key Iris does read for a
 * typo, the keys it reads at that level otherwise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { closestKey, knownKeysAt, RESERVED_CONFIG_KEYS, validateConfigFile } from '../../src/config/schema.js';

let scratch: string;
let home: string;
let savedHome: string | undefined;
let savedDbPath: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'iris-config-strict-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  savedHome = process.env.IRIS_HOME;
  savedDbPath = process.env.IRIS_DB_PATH;
  delete process.env.IRIS_DB_PATH;
  process.env.IRIS_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.IRIS_HOME;
  else process.env.IRIS_HOME = savedHome;
  if (savedDbPath === undefined) delete process.env.IRIS_DB_PATH;
  else process.env.IRIS_DB_PATH = savedDbPath;
  rmSync(scratch, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(home, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

function refusal(): string {
  try {
    loadConfig();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('loadConfig accepted the file');
}

describe('config.json is strict', () => {
  it('a misspelled key refuses startup naming it and the key it meant', () => {
    writeConfig({ eval: { critcalRules: ['no_pii'] } });
    const message = refusal();
    expect(message).toMatch(/^Invalid config file .*config\.json — Iris refuses to start on a key it does not read/);
    expect(message).toContain('unknown key "eval.critcalRules" — did you mean "eval.criticalRules"?');
  });

  it('a key Iris does not read at all names the keys it does read at that level', () => {
    writeConfig({ eval: { judge: { provider: 'openai' } } });
    expect(refusal()).toMatch(/unknown key "eval\.judge" — the keys Iris reads under "eval": defaultThreshold, ruleThresholds, criticalRules/);
  });

  it('a top-level key from another tool is named with the top-level keys', () => {
    writeConfig({ mcpServers: {} });
    expect(refusal()).toMatch(/unknown key "mcpServers" — the keys Iris reads at the top level: storage, server, transport, dashboard, eval, otel, logging, retention, notify, security/);
  });

  it('a value of the wrong type is named with the type it wanted', () => {
    writeConfig({ retention: { days: '30' } });
    expect(refusal()).toContain('"retention.days": expected number, received string');
  });

  it('a value outside its range is named', () => {
    writeConfig({ dashboard: { port: 70000 }, eval: { onCriticalSkipped: 'maybe' } });
    const message = refusal();
    expect(message).toMatch(/"dashboard\.port": /);
    expect(message).toMatch(/"eval\.onCriticalSkipped": /);
  });

  it('every problem is named in one sentence, not only the first found', () => {
    writeConfig({ securty: { apiKey: 'x' }, retention: { days: '30' }, eval: { ruleThresholds: { max_step: 5 } } });
    const message = refusal();
    expect(message).toContain('unknown key "securty" — did you mean "security"?');
    expect(message).toContain('"retention.days": expected number, received string');
    expect(message).toContain('unknown key "eval.ruleThresholds.max_step" — did you mean "eval.ruleThresholds.max_steps"?');
  });

  it('a reserved key Iris writes itself is refused by name', () => {
    writeConfig({ eval: { priorConfigured: true, configuredThresholdKeys: [] } });
    const message = refusal();
    expect(message).toContain('"eval.priorConfigured" is reserved — Iris sets it at startup');
    expect(message).toContain('"eval.configuredThresholdKeys" is reserved');
    expect([...RESERVED_CONFIG_KEYS]).toEqual(['eval.configuredThresholdKeys', 'eval.priorConfigured']);
  });

  it('a top level that is not an object is refused', () => {
    writeConfig('[]');
    expect(refusal()).toMatch(/top level must be a JSON object with the keys Iris reads \(storage, server/);
  });

  it('composer "legacy" still gets the composer sentence, not a schema sentence', () => {
    writeConfig({ eval: { composer: 'legacy' } });
    expect(refusal()).toMatch(/^eval\.composer: "legacy" was removed in 0\.12\.0/);
  });

  it('a file that sets every documented key loads with the values it set', () => {
    const dbPath = join(scratch, 'elsewhere', 'iris.db');
    writeConfig({
      storage: { type: 'sqlite', path: dbPath, redact: 'critical_spans' },
      server: { name: 'iris-eval', version: '0.0.0-test' },
      transport: { type: 'http', port: 3123, host: '127.0.0.1' },
      dashboard: { enabled: true, port: 6123, host: '127.0.0.1' },
      eval: {
        defaultThreshold: 0.6,
        ruleThresholds: { min_output_length: 10, max_steps: 12 },
        criticalRules: ['no_pii'],
        nonCriticalRules: [],
        composer: 'risk',
        falsePassCost: 3,
        onCriticalSkipped: 'fail',
        requiredEvidence: [],
        defaultsGate: true,
        validateToolArguments: false,
        plugins: [{ path: './rules/no-competitor.mjs', sha256: 'a'.repeat(64) }],
        prior: 0.2,
        priorMode: 'per-class',
      },
      otel: { evaluateOnIngest: true },
      logging: { level: 'warn' },
      retention: { days: 7, sweepIntervalHours: 0 },
      security: {
        apiKey: 'k',
        allowUnauthenticated: false,
        allowedOrigins: ['http://localhost:*'],
        rateLimit: { api: 100, mcp: 40 },
        requestSizeLimit: '2mb',
      },
    });
    const config = loadConfig();
    expect(config.storage.path).toBe(dbPath);
    expect(config.storage.redact).toBe('critical_spans');
    expect(config.eval.criticalRules).toEqual(['no_pii']);
    expect(config.eval.ruleThresholds?.max_steps).toBe(12);
    // The defaults the file did not name survive the merge.
    expect(config.eval.ruleThresholds?.min_sentences).toBe(2);
    expect(config.eval.configuredThresholdKeys).toEqual(['min_output_length', 'max_steps']);
    expect(config.eval.priorConfigured).toBe(true);
    expect(config.retention.days).toBe(7);
    expect(config.security.rateLimit.mcp).toBe(40);
    expect(config.logging.level).toBe('warn');
    expect(config.otel.evaluateOnIngest).toBe(true);
    expect(config.eval.plugins).toEqual([{ path: './rules/no-competitor.mjs', sha256: 'a'.repeat(64) }]);
  });

  it('the key ring and the rate-limit keying are documented keys; a wrong keying value names the two allowed', () => {
    writeConfig({ security: { apiKeys: [{ id: 'ci', keyHash: 'a'.repeat(64), expiresAt: '2027-01-01T00:00:00Z' }], rateLimit: { mcpKeyBy: 'apiKey' } } });
    const config = loadConfig();
    expect(config.security.apiKeys?.[0]?.id).toBe('ci');
    expect(config.security.rateLimit.mcpKeyBy).toBe('apiKey');
    writeConfig({ security: { rateLimit: { mcpKeyBy: 'user' } } });
    expect(refusal()).toMatch(/"security\.rateLimit\.mcpKeyBy": .*"ip"|"apiKey"/);
    writeConfig({ security: { apiKeys: [{ id: 'ci', keyHash: 'a'.repeat(64), expires: 'x' }] } });
    expect(refusal()).toContain('unknown key "security.apiKeys.0.expires" — did you mean "security.apiKeys.0.expiresAt"?');
  });

  it('an empty object and a missing file both load the defaults', () => {
    writeConfig({});
    expect(loadConfig().retention.days).toBe(30);
    rmSync(join(home, 'config.json'));
    expect(loadConfig().retention.days).toBe(30);
    expect(loadConfig().eval.priorConfigured).toBe(false);
  });
});

describe('the did-you-mean', () => {
  it('names the closest key within a couple of edits, case-insensitively, and nothing when far', () => {
    const evalKeys = knownKeysAt(['eval']);
    expect(closestKey('critcalRules', evalKeys)).toBe('criticalRules');
    expect(closestKey('CriticalRules', evalKeys)).toBe('criticalRules');
    expect(closestKey('judge', evalKeys)).toBeNull();
    expect(closestKey('anything', [])).toBeNull();
  });

  it('knownKeysAt walks optional objects and answers [] off the schema', () => {
    expect(knownKeysAt([])).toEqual(['storage', 'server', 'transport', 'dashboard', 'eval', 'otel', 'logging', 'retention', 'notify', 'security']);
    expect(knownKeysAt(['security', 'rateLimit'])).toEqual(['api', 'mcp', 'mcpKeyBy']);
    expect(knownKeysAt(['security', 'apiKeys', 0])).toEqual(['id', 'keyFile', 'keyHash', 'expiresAt']);
    expect(knownKeysAt(['nope'])).toEqual([]);
    expect(knownKeysAt(['eval', 'criticalRules'])).toEqual([]);
  });

  it('validateConfigFile returns the parsed object when it is clean', () => {
    expect(validateConfigFile({ retention: { days: 3 } }, 'x.json')).toEqual({ retention: { days: 3 } });
  });
});
