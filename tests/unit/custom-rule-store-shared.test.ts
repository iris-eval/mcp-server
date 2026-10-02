/*
 * One rules file, several stores.
 *
 * Each store here stands for one server process: `install` gives every MCP
 * client its own, and they share the home. A store used to read the file
 * once and write its own copy back, so it never saw a rule another store
 * deployed and its next write deleted that rule.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCustomRuleStore, type CustomRuleStore } from '../../src/custom-rule-store.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { deployedRulesInStep } from '../../src/eval/shared-state.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { CustomRuleDefinition } from '../../src/types/eval.js';

let dir: string;
let rulesPath: string;
let auditPath: string;
const store = (): CustomRuleStore => createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
const rule = (name: string, pattern = name): { name: string; evalType: 'custom'; severity: 'high'; definition: CustomRuleDefinition } => ({
  name,
  evalType: 'custom',
  severity: 'high',
  definition: { name, type: 'regex_no_match', config: { pattern } },
});
const names = (s: CustomRuleStore): string[] => s.list(LOCAL_TENANT).map((r) => r.name).sort();
const onDisk = (): string[] => (JSON.parse(readFileSync(rulesPath, 'utf8')) as { rules: Array<{ name: string }> }).rules.map((r) => r.name).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-shared-rules-'));
  rulesPath = join(dir, 'custom-rules.json');
  auditPath = join(dir, 'audit.log');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a rules file shared by several stores', () => {
  it('a store sees what another deployed, deleted and switched off, without being restarted', () => {
    const a = store();
    const b = store();
    expect(names(a)).toEqual([]);
    expect(names(b)).toEqual([]);

    const first = a.deploy(LOCAL_TENANT, rule('from-a'));
    expect(names(b)).toEqual(['from-a']);
    expect(b.get(LOCAL_TENANT, first.id)?.enabled).toBe(true);

    a.setEnabled(LOCAL_TENANT, first.id, false);
    expect(b.enabledRules(LOCAL_TENANT)).toEqual([]);

    a.delete(LOCAL_TENANT, first.id);
    expect(names(b)).toEqual([]);
  });

  it('a change is made on what the file holds now, so it never deletes a rule another store deployed', () => {
    const a = store();
    const b = store();
    // Both read the empty file before either writes: the order that used to lose a rule.
    expect(names(a)).toEqual([]);
    expect(names(b)).toEqual([]);

    a.deploy(LOCAL_TENANT, rule('from-a'));
    b.deploy(LOCAL_TENANT, rule('from-b'));
    a.deploy(LOCAL_TENANT, rule('from-a-again'));

    expect(onDisk()).toEqual(['from-a', 'from-a-again', 'from-b']);
    expect(names(a)).toEqual(['from-a', 'from-a-again', 'from-b']);
    expect(names(b)).toEqual(['from-a', 'from-a-again', 'from-b']);
  });

  it('deleting or switching off a rule another store deployed works, and one already deleted elsewhere is reported as not found', () => {
    const a = store();
    const b = store();
    names(b);
    const made = a.deploy(LOCAL_TENANT, rule('from-a'));
    expect(b.setEnabled(LOCAL_TENANT, made.id, false)?.enabled).toBe(false);
    expect(a.get(LOCAL_TENANT, made.id)?.enabled).toBe(false);
    expect(b.delete(LOCAL_TENANT, made.id)).toBe(true);
    expect(a.delete(LOCAL_TENANT, made.id)).toBe(false);
    expect(a.setEnabled(LOCAL_TENANT, made.id, true)).toBeUndefined();
  });

  it('the revision moves on every change, its own or another store\'s, and only then', () => {
    const a = store();
    const b = store();
    const start = b.revision(LOCAL_TENANT);
    expect(b.revision(LOCAL_TENANT)).toBe(start);
    const made = a.deploy(LOCAL_TENANT, rule('from-a'));
    const seen = b.revision(LOCAL_TENANT);
    expect(seen).toBeGreaterThan(start);
    expect(b.revision(LOCAL_TENANT)).toBe(seen);
    b.setEnabled(LOCAL_TENANT, made.id, false);
    expect(b.revision(LOCAL_TENANT)).toBeGreaterThan(seen);
  });

  it('counts a change another store made, once per rule that differs, and its own once each', () => {
    const a = store();
    const b = store();
    expect(b.changesSinceStart(LOCAL_TENANT)).toBeNull();
    const one = a.deploy(LOCAL_TENANT, rule('one'));
    a.deploy(LOCAL_TENANT, rule('two'));
    // Two deploys through A, read by B in one look at the file.
    expect(b.changesSinceStart(LOCAL_TENANT)?.count).toBe(2);
    expect(a.changesSinceStart(LOCAL_TENANT)?.count).toBe(2);
    b.setEnabled(LOCAL_TENANT, one.id, false);
    expect(b.changesSinceStart(LOCAL_TENANT)?.count).toBe(3);
    expect(a.changesSinceStart(LOCAL_TENANT)?.count).toBe(3);
    // Reading again changes nothing.
    expect(a.changesSinceStart(LOCAL_TENANT)?.count).toBe(3);
  });

  it('a file that could not be parsed is read again once it is fixed, with no restart', () => {
    writeFileSync(rulesPath, '{ not json');
    const a = store();
    expect(names(a)).toEqual([]);
    expect(() => a.deploy(LOCAL_TENANT, rule('refused'))).toThrow(/could not be parsed/);
    writeFileSync(rulesPath, JSON.stringify({ version: 1, rules: [] }));
    expect(a.deploy(LOCAL_TENANT, rule('accepted')).name).toBe('accepted');
    expect(onDisk()).toEqual(['accepted']);
  });
});

describe('the lock a change is made under', () => {
  it('a change waits out a lock that is held, and says so when it stays held', () => {
    const a = store();
    names(a);
    writeFileSync(`${rulesPath}.lock`, '99999 held\n');
    const started = Date.now();
    expect(() => a.deploy(LOCAL_TENANT, rule('blocked'))).toThrow(/is being changed by another Iris process and stayed locked for 5 seconds .*Nothing was changed/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(existsSync(rulesPath)).toBe(false);
    // The refused change left no audit entry: nothing was recorded as done.
    expect(existsSync(auditPath)).toBe(false);
  }, 20_000);

  it('a lock left by a process that died is taken over', () => {
    const a = store();
    names(a);
    const lock = `${rulesPath}.lock`;
    writeFileSync(lock, '99999 dead\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(a.deploy(LOCAL_TENANT, rule('after-a-crash')).name).toBe('after-a-crash');
    expect(existsSync(lock)).toBe(false);
  });

  it('the lock is released after a change, and after a change that failed', () => {
    const a = store();
    a.deploy(LOCAL_TENANT, rule('one'));
    expect(existsSync(`${rulesPath}.lock`)).toBe(false);
    writeFileSync(rulesPath, '{ not json');
    expect(() => a.deploy(LOCAL_TENANT, rule('two'))).toThrow();
    expect(existsSync(`${rulesPath}.lock`)).toBe(false);
  });

  it('three processes deploying at once lose nothing', async () => {
    const fixture = resolve(import.meta.dirname, '../fixtures/deploy-many.ts');
    const each = 12;
    const run = (prefix: string): Promise<number | null> =>
      new Promise((done, fail) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fixture, rulesPath, auditPath, prefix, String(each)], { stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('error', fail);
        child.on('exit', (code) => done(code));
      });
    expect(await Promise.all([run('p'), run('q'), run('r')])).toEqual([0, 0, 0]);
    const stored = onDisk();
    expect(stored).toHaveLength(3 * each);
    expect(new Set(stored).size).toBe(3 * each);
    // Every deploy is in the audit log, each line whole.
    const audit = readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { action: string; ruleName: string });
    expect(audit.filter((e) => e.action === 'rule.deploy').map((e) => e.ruleName).sort()).toEqual(stored);
  }, 120_000);
});

describe('the engine follows the file', () => {
  const output = { output: 'We recommend Acme.' };
  const ran = async (engine: EvalEngine): Promise<string[]> => (await engine.evaluate('custom', output)).rule_results.map((r) => r.ruleName).sort();

  function engineOn(s: CustomRuleStore): EvalEngine {
    const engine = new EvalEngine(0.7);
    const rules = deployedRulesInStep(engine, s, LOCAL_TENANT);
    engine.setSharedState({ rules });
    rules();
    return engine;
  }

  it('a rule another process deployed, switched off, switched on or deleted applies to the next evaluation', async () => {
    const a = store();
    const b = store();
    const engine = engineOn(b);
    expect(await ran(engine)).toEqual([]);

    const made = a.deploy(LOCAL_TENANT, rule('no-competitor', 'Acme'));
    const judged = await engine.evaluate('custom', output);
    expect(judged.rule_results.map((r) => r.ruleName)).toEqual(['no-competitor']);
    expect(judged.passed).toBe(false);

    a.setEnabled(LOCAL_TENANT, made.id, false);
    expect(await ran(engine)).toEqual([]);
    a.setEnabled(LOCAL_TENANT, made.id, true);
    expect(await ran(engine)).toEqual(['no-competitor']);
    a.delete(LOCAL_TENANT, made.id);
    expect(await ran(engine)).toEqual([]);
    expect(engine.hasRule(made.id)).toBe(false);
  });

  it('two engines on one file stamp one ruleset hash', async () => {
    const a = store();
    const b = store();
    const [ea, eb] = [engineOn(a), engineOn(b)];
    a.deploy(LOCAL_TENANT, rule('no-competitor', 'Acme'));
    expect(eb.rulesetHashForAll()).toBe(ea.rulesetHashForAll());
    b.deploy(LOCAL_TENANT, rule('no-other', 'Globex'));
    expect(ea.rulesetHashForAll()).toBe(eb.rulesetHashForAll());
    expect((await ea.evaluate('custom', output)).provenance?.rulesetHash).toBe((await eb.evaluate('custom', output)).provenance?.rulesetHash);
  });

  it('a rule rewritten under the same id is registered again, and a rule the store never held is left alone', async () => {
    const a = store();
    const engine = engineOn(a);
    const made = a.deploy(LOCAL_TENANT, rule('no-competitor', 'Globex'));
    engine.registerRule('custom', { name: 'a-plugin-rule', description: '', evalType: 'custom', weight: 1, evaluate: () => ({ ruleName: 'a-plugin-rule', passed: true, score: 1, message: 'ok' }) } as never, 'plugin-1');
    expect((await engine.evaluate('custom', output)).passed).toBe(true);

    // The file edited by hand: same id, a pattern that now matches.
    const file = JSON.parse(readFileSync(rulesPath, 'utf8')) as { rules: Array<{ id: string; definition: { config: { pattern: string } } }> };
    file.rules.find((r) => r.id === made.id)!.definition.config.pattern = 'Acme';
    writeFileSync(rulesPath, JSON.stringify(file));

    const judged = await engine.evaluate('custom', output);
    expect(judged.passed).toBe(false);
    expect(judged.rule_results.map((r) => r.ruleName).sort()).toEqual(['a-plugin-rule', 'no-competitor']);

    a.delete(LOCAL_TENANT, made.id);
    expect(await ran(engine)).toEqual(['a-plugin-rule']);
  });

  it('a rules file that cannot be read keeps the evaluation working', async () => {
    const a = store();
    const engine = engineOn(a);
    a.deploy(LOCAL_TENANT, rule('no-competitor', 'Acme'));
    expect(await ran(engine)).toEqual(['no-competitor']);
    writeFileSync(rulesPath, '{ not json');
    // The file now holds no rule this process can read; it evaluates and does not throw.
    await expect(engine.evaluate('custom', output)).resolves.toBeDefined();
  });
});
