/*
 * The runtime guard (src/runtime-guard.ts): which engines have the defect
 * that makes two objects share their fractional numbers, what stands in the
 * way in a process, and that every entry point Iris owns applies the guard
 * before anything else.
 *
 * That the flag takes effect when it is set from inside a process is held
 * by tests/integration/runtime-guard-takes-effect.test.ts, which asks the
 * engine which compiler it chose.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyRuntimeGuard,
  guardStateOf,
  runtimeGuardState,
  runtimeLine,
  runtimeReport,
  unguardedWarning,
  v8SharesNumbers,
  warnIfUnguarded,
  SHARED_NUMBERS_REPORT,
  SHARED_NUMBERS_WARNING,
  TIER_OFF_FLAG,
} from '../../src/runtime-guard.js';

const root = resolve(__dirname, '..', '..');
const WARNED = Symbol.for('@iris-eval/mcp-server/runtime-guard.warned');
const marks = globalThis as unknown as Record<symbol, boolean | undefined>;

afterEach(() => {
  vi.restoreAllMocks();
  delete marks[WARNED];
});

describe('which engines can make two objects share their numbers', () => {
  it('by the engine alone, V8 12.5 up to, not including, 15.2', () => {
    const affected = ['12.5.0', '12.9.202.28-node.14', '13.6.233.10-node.28', '13.6.233.17-node.41', '14.6.202.34-node.32', '15.0.1', '15.1.99.2'];
    const clean = ['11.3.244.8-node.33', '12.4.254.21-node.39', '15.2.0', '15.2.50.1-node.3', '15.3.1', '16.0.0', '20.1.0'];
    for (const version of affected) expect(v8SharesNumbers(version, null), version).toBe(true);
    for (const version of clean) expect(v8SharesNumbers(version, null), version).toBe(false);
  });

  it('a version it cannot read is not called affected', () => {
    for (const version of ['', 'unknown', 'v13', '13']) expect(v8SharesNumbers(version, null), version).toBe(false);
  });

  it('a Node release that carries the fix is not affected, and every release of its line before it is', () => {
    const V8_OF_26 = '14.6.202.34-node.32';
    const V8_OF_24 = '13.6.233.10-node.28';
    const rows: Array<[v8: string, node: string, affected: boolean]> = [
      // Node 26: the fix is in 26.12.0.
      [V8_OF_26, '26.0.0', true],
      [V8_OF_26, '26.9.0', true],
      [V8_OF_26, '26.11.1', true],
      [V8_OF_26, '26.12.0', false],
      [V8_OF_26, 'v26.12.0', false],
      [V8_OF_26, '26.12.1', false],
      [V8_OF_26, '26.13.1', false],
      [V8_OF_26, '26.100.0', false],
      // Node 24: no release carries it.
      [V8_OF_24, '24.0.0', true],
      [V8_OF_24, '24.11.0', true],
      [V8_OF_24, '24.22.3', true],
      [V8_OF_24, '24.99.9', true],
      // A Node version it cannot read leaves the engine's line to answer.
      [V8_OF_26, 'unknown', true],
      [V8_OF_26, '26', true],
      // The engine's line answers first: a clean engine is clean whatever the release.
      ['12.4.254.21-node.39', '22.23.5', false],
      ['15.2.50.1-node.3', '27.0.0', false],
    ];
    for (const [v8Version, node, affected] of rows) expect(v8SharesNumbers(v8Version, node), `${v8Version} in Node ${node}`).toBe(affected);
  });

  it('asked of this process, it answers for this process', () => {
    const versions: Readonly<Record<string, string | undefined>> = process.versions;
    const nodeItself = versions['deno'] === undefined && versions['bun'] === undefined && versions['electron'] === undefined;
    expect(v8SharesNumbers()).toBe(v8SharesNumbers(process.versions.v8, nodeItself ? process.versions.node : null));
  });
});

describe('what stands between a process and the defect', () => {
  const AFFECTED = true;
  const CLEAN = false;

  it('an engine without the defect needs nothing, whatever the process was started with', () => {
    expect(guardStateOf(CLEAN, [], false)).toBe('not_needed');
    expect(guardStateOf(CLEAN, [TIER_OFF_FLAG], true)).toBe('not_needed');
  });

  it('an engine with it is unguarded until the guard is applied or the process was started with the tier off', () => {
    expect(guardStateOf(AFFECTED, [], false)).toBe('unguarded');
    expect(guardStateOf(AFFECTED, ['--import', 'tsx'], false)).toBe('unguarded');
    expect(guardStateOf(AFFECTED, [], true)).toBe('applied');
    expect(guardStateOf(AFFECTED, [TIER_OFF_FLAG], false)).toBe('started');
    expect(guardStateOf(AFFECTED, ['--jitless'], false)).toBe('started');
    // Turning off only the tier's swap of a running loop is not the whole tier.
    expect(guardStateOf(AFFECTED, ['--no-maglev-osr'], false)).toBe('unguarded');
  });

  it('this test worker is not unguarded, and applying again changes nothing', () => {
    // tests/setup/runtime-guard.ts applied it before this file loaded.
    const before = runtimeGuardState();
    expect(before).not.toBe('unguarded');
    expect(applyRuntimeGuard()).toBe(before);
    expect(runtimeGuardState()).toBe(before);
    expect(before === 'not_needed').toBe(!v8SharesNumbers());
  });
});

describe('what a process says of its runtime', () => {
  it('the report names the Node, the V8, whether it is affected and what stands in the way', () => {
    const report = runtimeReport();
    expect(report).toEqual({
      node: process.versions.node,
      v8: process.versions.v8,
      sharedNumbers: { affected: v8SharesNumbers(), guard: runtimeGuardState(), see: SHARED_NUMBERS_REPORT },
    });
  });

  it('the line a person reads says each state in words, and names the flag only where the person has to act', () => {
    const at = (guard: 'not_needed' | 'applied' | 'started' | 'unguarded') => runtimeLine({ node: '24.11.0', v8: '13.6.233.10-node.28', sharedNumbers: { affected: guard !== 'not_needed', guard, see: SHARED_NUMBERS_REPORT } });
    expect(at('not_needed')).toBe('Node 24.11.0 (V8 13.6.233.10-node.28)');
    expect(at('applied')).toContain('Iris turned that tier off at start');
    expect(at('started')).toContain('Node was started with that tier off');
    expect(at('unguarded')).toContain(`start Node with ${TIER_OFF_FLAG}`);
    for (const guard of ['applied', 'started', 'unguarded'] as const) expect(at(guard)).toContain(SHARED_NUMBERS_REPORT);
    for (const guard of ['not_needed', 'applied', 'started'] as const) expect(at(guard)).not.toContain(TIER_OFF_FLAG);
  });
});

describe('the library says so once, and only when nothing stands in the way', () => {
  it('unguarded: one warning, with the report, the flag and the call; not again', () => {
    const emitted = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    warnIfUnguarded('unguarded');
    warnIfUnguarded('unguarded');
    expect(emitted).toHaveBeenCalledTimes(1);
    const [text, options] = emitted.mock.calls[0] as unknown as [string, { type: string; code: string }];
    expect(text).toBe(unguardedWarning());
    expect(text).toContain(SHARED_NUMBERS_REPORT);
    expect(text).toContain(TIER_OFF_FLAG);
    expect(text).toContain('applyRuntimeGuard()');
    expect(options).toEqual({ type: 'IrisRuntimeWarning', code: 'IRIS_SHARED_NUMBERS' });
    expect(SHARED_NUMBERS_WARNING).toBe('IRIS_SHARED_NUMBERS');
  });

  it('any other state: no warning', () => {
    const emitted = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    for (const state of ['not_needed', 'applied', 'started'] as const) warnIfUnguarded(state);
    // And as this worker stands, with the guard applied by the setup: an engine is built without a word.
    warnIfUnguarded();
    expect(emitted).not.toHaveBeenCalled();
  });
});

describe('every entry point Iris owns applies the guard before anything else', () => {
  /** The module the first import statement of a file names. */
  const firstImport = (rel: string): string | undefined => /^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/m.exec(readFileSync(join(root, rel), 'utf8'))?.[1];

  const ENTRIES: Array<[file: string, guard: string]> = [
    ['src/index.ts', './apply-runtime-guard.js'],
    ['proof/run.ts', '../src/apply-runtime-guard.js'],
    ['proof/judge/run.ts', '../../src/apply-runtime-guard.js'],
    ['scripts/cusum/render-thresholds.ts', '../../src/apply-runtime-guard.js'],
    ['scripts/seed-demo-data.ts', '../src/apply-runtime-guard.js'],
    ['scripts/read-sessions.ts', '../src/apply-runtime-guard.js'],
    ['tests/setup/runtime-guard.ts', '../../src/apply-runtime-guard.js'],
  ];

  it.each(ENTRIES)('%s imports it first', (file, guard) => {
    expect(firstImport(file)).toBe(guard);
  });

  it('the test workers load that setup before any other', () => {
    const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
    expect(/setupFiles:\s*\[\s*'([^']+)'/.exec(config)?.[1]).toBe('./tests/setup/runtime-guard.ts');
  });

  it('the module that applies it does nothing else, so that importing it first costs nothing', () => {
    const source = readFileSync(join(root, 'src', 'apply-runtime-guard.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim().split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(source).toEqual(["import { applyRuntimeGuard } from './runtime-guard.js';", 'applyRuntimeGuard();']);
  });
});
