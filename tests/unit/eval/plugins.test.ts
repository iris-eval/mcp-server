/*
 * Plugin rules: a hash-pinned ES module becomes a rule that
 * fires like a built-in; a wrong hash, a missing file, a module without
 * the contract, or a name that clashes, refuses at load naming the path;
 * a plugin that throws or answers the wrong shape skips the evaluation
 * as config_invalid naming itself; list_rules shows it under plugins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { loadPlugins, registerPlugins, pluginRows, loadedPlugins, __resetPluginsForTests, resolvePluginPath } from '../../../src/eval/plugins.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const GOOD = `export default {
  name: 'no_competitor_mention',
  kind: 'policy',
  mechanism: 'pattern',
  version: 2,
  needs: ['output'],
  description: 'The output never names a competitor.',
  evaluate(ctx) {
    const hit = /\\b(acme|globex)\\b/i.exec(ctx.output);
    return hit
      ? { ruleName: 'no_competitor_mention', passed: false, score: 0, message: 'names ' + hit[0], evidence: [{ type: 'span', source: 'output', start: hit.index, end: hit.index + hit[0].length, text: hit[0] }] }
      : { ruleName: 'no_competitor_mention', passed: true, score: 1, message: 'no competitor named' };
  },
};
`;
const THROWS = `export default { name: 'always_throws', kind: 'policy', mechanism: 'formula', version: 1, needs: ['output'], evaluate() { throw new Error('boom'); } };\n`;
const WRONG_SHAPE = `export default { name: 'wrong_shape', kind: 'policy', mechanism: 'formula', version: 1, needs: ['output'], evaluate() { return { passed: 'yes', score: 7 }; } };\n`;
const NO_CONTRACT = `export default { name: 'nope', kind: 'opinion', evaluate: 42 };\n`;
const CLASHES = `export default { name: 'no_pii', kind: 'detection', mechanism: 'pattern', version: 1, needs: ['output'], evaluate() { return { ruleName: 'no_pii', passed: true, score: 1, message: 'x' }; } };\n`;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-plugins-'));
  mkdirSync(join(home, 'rules'));
  __resetPluginsForTests();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  __resetPluginsForTests();
});

function write(name: string, text: string): { path: string; sha256: string } {
  writeFileSync(join(home, 'rules', name), text);
  return { path: `./rules/${name}`, sha256: sha(text) };
}

const engine = () => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);

describe('loadPlugins', () => {
  it('loads a hash-pinned module into a rule with origin plugin, and the rule fires on the next evaluation with its stamp', async () => {
    const entry = write('no-competitor.mjs', GOOD);
    const e = engine();
    const loaded = await registerPlugins(e, { eval: { ...defaultConfig.eval, plugins: [entry] } }, { home });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('plugin:no_competitor_mention');
    expect(loaded[0].rule).toMatchObject({ name: 'no_competitor_mention', kind: 'policy', mechanism: 'pattern', version: 2, needs: ['output'], origin: 'plugin', evalType: 'custom', critical: false });

    const result = await e.evaluateAll({ output: 'Our plan beats Acme on every axis, and that is the whole of it.' });
    const fired = result.rule_results.find((r) => r.ruleName === 'no_competitor_mention');
    expect(fired).toBeDefined();
    expect(fired?.passed).toBe(false);
    expect(fired?.origin).toBe('plugin');
    expect(fired?.kind).toBe('policy');
    expect(fired?.ruleVersion).toBe(2);
    // A policy rule's basis is 'policy' (a detection or inference plugin would read 'unmeasured' until labelled).
    expect(fired?.uncertainty?.basis).toBe('policy');
    expect(fired?.evidence?.[0]).toMatchObject({ type: 'span', source: 'output', text: 'Acme' });
    // A clean output passes it.
    const clean = await e.evaluateAll({ output: 'Our plan stands on its own merits, and that is the whole of it.' });
    expect(clean.rule_results.find((r) => r.ruleName === 'no_competitor_mention')?.passed).toBe(true);

    expect(loadedPlugins()).toHaveLength(1);
    expect(pluginRows()).toEqual([
      expect.objectContaining({ name: 'no_competitor_mention', kind: 'policy', mechanism: 'pattern', needs: ['output'], version: 2, critical: false, origin: 'plugin', path: './rules/no-competitor.mjs', sha256: entry.sha256 }),
    ]);
    expect(JSON.stringify(pluginRows())).not.toContain('evaluate');
  }, 30_000);

  it('a wrong hash refuses at load naming the path and both hashes; nothing is imported', async () => {
    const entry = write('no-competitor.mjs', GOOD);
    const wrong = { ...entry, sha256: sha('something else') };
    await expect(loadPlugins([wrong], { home })).rejects.toThrow(/Refusing to start: eval\.plugins entry "\.\/rules\/no-competitor\.mjs" \(.*no-competitor\.mjs\) does not match its pinned hash: pinned [0-9a-f]{64}, file [0-9a-f]{64}/);
    expect(loadedPlugins()).toEqual([]);
  }, 30_000);

  it('a missing file, a malformed hash, a module without the contract, and a name that clashes are each refused naming the path and the problem', async () => {
    await expect(loadPlugins([{ path: './rules/missing.mjs', sha256: 'a'.repeat(64) }], { home })).rejects.toThrow(/"\.\/rules\/missing\.mjs" .* cannot be read \(ENOENT\)/);
    await expect(loadPlugins([{ path: './rules/x.mjs', sha256: 'abc' }], { home })).rejects.toThrow(/has a sha256 that is not 64 hex characters/);
    const noContract = write('nope.mjs', NO_CONTRACT);
    await expect(loadPlugins([noContract], { home })).rejects.toThrow(/does not export the plugin contract .* kind: |mechanism: /);
    const clash = write('clash.mjs', CLASHES);
    await expect(loadPlugins([clash], { home })).rejects.toThrow(/is named "no_pii", which is a built-in rule/);
    const good = write('good.mjs', GOOD);
    const twin = write('twin.mjs', GOOD);
    await expect(loadPlugins([good, twin], { home })).rejects.toThrow(/is named "no_competitor_mention", which an earlier plugin already uses/);
  }, 30_000);

  it('a plugin that throws, or answers the wrong shape, skips that evaluation as config_invalid naming itself — the engine still answers', async () => {
    const throws = write('throws.mjs', THROWS);
    const wrong = write('wrong.mjs', WRONG_SHAPE);
    const e = engine();
    await registerPlugins(e, { eval: { ...defaultConfig.eval, plugins: [throws, wrong] } }, { home });
    const result = await e.evaluateAll({ output: 'Four. Two plus two is four, and that is the whole of it.' });
    const t = result.rule_results.find((r) => r.ruleName === 'always_throws');
    expect(t?.skipped).toBe(true);
    expect(t?.skipClass).toBe('config_invalid');
    expect(t?.skipReason).toMatch(/plugin "always_throws" threw: boom/);
    const w = result.rule_results.find((r) => r.ruleName === 'wrong_shape');
    expect(w?.skipped).toBe(true);
    expect(w?.skipReason).toMatch(/without a boolean `passed`/);
    expect(result.verdict).toBeDefined();
  }, 30_000);

  it('an absolute path is taken as given; a relative one resolves against the home; no plugins is no work', async () => {
    expect(resolvePluginPath('./rules/a.mjs', '/iris/home')).toMatch(/[\\/]iris[\\/]home[\\/]rules[\\/]a\.mjs$/);
    const abs = join(home, 'rules', 'abs.mjs');
    expect(resolvePluginPath(abs, '/elsewhere')).toBe(abs);
    expect(await loadPlugins(undefined, { home })).toEqual([]);
    expect(await loadPlugins([], { home })).toEqual([]);
  }, 30_000);
});
