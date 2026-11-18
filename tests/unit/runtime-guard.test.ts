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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import v8 from 'node:v8';
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyRuntimeGuard,
  guardStateOf,
  nodeVersionOf,
  releasesWithTheFix,
  runtimeGuardState,
  RUNTIME_GUARD_STATES,
  runtimeLine,
  runtimeReport,
  tierOffAtStart,
  unguardedWarning,
  v8SharesNumbers,
  warnIfUnguarded,
  SHARED_NUMBERS_REPORT,
  SHARED_NUMBERS_WARNING,
  TIER_OFF_FLAG,
  type RuntimeGuardState,
} from '../../src/runtime-guard.js';

const root = resolve(__dirname, '..', '..');
/** The guard's two marks: on the thread, and in the data every worker thread started after it is handed. */
const APPLIED_KEY = '@iris-eval/mcp-server/runtime-guard.applied';
const WARNED_KEY = '@iris-eval/mcp-server/runtime-guard.warned';
const marks = globalThis as unknown as Record<symbol, boolean | undefined>;

/** Takes both marks off, for a test that needs a process the guard has not been applied in; the function it returns puts them back. */
function forgetMarks(): () => void {
  const had = { applied: marks[Symbol.for(APPLIED_KEY)], appliedData: getEnvironmentData(APPLIED_KEY) };
  delete marks[Symbol.for(APPLIED_KEY)];
  setEnvironmentData(APPLIED_KEY, undefined);
  return () => {
    if (had.applied !== undefined) marks[Symbol.for(APPLIED_KEY)] = had.applied;
    if (had.appliedData !== undefined) setEnvironmentData(APPLIED_KEY, had.appliedData as boolean);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete marks[Symbol.for(WARNED_KEY)];
  setEnvironmentData(WARNED_KEY, undefined);
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
      // A pre-release comes before its release: a build of 26.12.0 before it was released may not carry the fix.
      [V8_OF_26, '26.12.0-pre', true],
      [V8_OF_26, '26.12.0-rc.1', true],
      [V8_OF_26, '26.12.1-pre', false],
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

  it('the Node release is read only where the runtime is Node itself', () => {
    const V8_OF_26 = '14.6.202.34-node.32';
    expect(nodeVersionOf({ node: '26.12.0', v8: V8_OF_26 })).toBe('26.12.0');
    // Deno, Bun and Electron answer as a Node version over an engine of their own build.
    for (const other of ['deno', 'bun', 'electron']) expect(nodeVersionOf({ node: '26.12.0', v8: V8_OF_26, [other]: '1.0.0' }), other).toBeNull();
    expect(nodeVersionOf({ v8: V8_OF_26 })).toBeNull();
    // So a runtime that answers as Node 26.12.0 is asked by its engine's line, and Node 26.12.0 itself by its release.
    expect(v8SharesNumbers(V8_OF_26, nodeVersionOf({ node: '26.12.0', electron: '40.0.0' }))).toBe(true);
    expect(v8SharesNumbers(V8_OF_26, nodeVersionOf({ node: '26.12.0' }))).toBe(false);
  });

  it('asked of this process, it answers for this process', () => {
    expect(v8SharesNumbers()).toBe(v8SharesNumbers(process.versions.v8, nodeVersionOf(process.versions)));
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

  it('what the process was started with is read as the engine reads its flags: each spelling it takes, NODE_OPTIONS before the command line, the last one standing', () => {
    const rows: Array<[execArgv: string[], nodeOptions: string, state: RuntimeGuardState]> = [
      [[], '', 'unguarded'],
      [['--no-maglev'], '', 'started'],
      [['--no_maglev'], '', 'started'],
      [['--nomaglev'], '', 'started'],
      [['--jitless'], '', 'started'],
      [[], '--jitless', 'started'],
      [[], '--max-old-space-size=4096   --jitless', 'started'],
      [[], '"--jitless"', 'started'],
      [[], '--title="a --jitless"', 'unguarded'],
      // Of two that disagree, the engine keeps the last; Node hands it NODE_OPTIONS first.
      [['--no-maglev', '--maglev'], '', 'unguarded'],
      [['--maglev', '--no-maglev'], '', 'started'],
      [['--jitless', '--no-jitless'], '', 'unguarded'],
      [['--no-jitless'], '--jitless', 'unguarded'],
      [['--jitless'], '--no-jitless', 'started'],
      [['--no-maglev-osr', '--maglev-inlining'], '', 'unguarded'],
    ];
    for (const [execArgv, nodeOptions, state] of rows) {
      expect(guardStateOf(AFFECTED, execArgv, false, nodeOptions), `${execArgv.join(' ')} | NODE_OPTIONS=${nodeOptions}`).toBe(state);
      expect(tierOffAtStart(execArgv, nodeOptions)).toBe(state === 'started');
    }
  });

  it('a process started with the tier off reads as started whether or not the guard was applied in it, and one that turned it on again reads as applied once it is', () => {
    expect(guardStateOf(AFFECTED, [TIER_OFF_FLAG], true)).toBe('started');
    expect(guardStateOf(AFFECTED, [TIER_OFF_FLAG, '--maglev'], true)).toBe('applied');
    expect(guardStateOf(AFFECTED, [TIER_OFF_FLAG, '--maglev'], false)).toBe('unguarded');
  });

  it('this test worker is not unguarded, and applying again changes nothing', () => {
    // tests/setup/runtime-guard.ts applied it before this file loaded.
    const before = runtimeGuardState();
    expect(before).not.toBe('unguarded');
    expect(applyRuntimeGuard()).toBe(before);
    expect(runtimeGuardState()).toBe(before);
    expect(before === 'not_needed').toBe(!v8SharesNumbers());
  });

  const startedWithTheTierOn = !tierOffAtStart(process.execArgv, process.env['NODE_OPTIONS'] ?? '');

  it.runIf(v8SharesNumbers() && startedWithTheTierOn)('the guard is marked applied only once the engine has taken the flag', () => {
    const putBack = forgetMarks();
    try {
      expect(runtimeGuardState()).toBe('unguarded');
      const refused = vi.spyOn(v8, 'setFlagsFromString').mockImplementation(() => {
        throw new Error('refused');
      });
      expect(applyRuntimeGuard()).toBe('unguarded');
      expect(refused).toHaveBeenCalledWith(TIER_OFF_FLAG);
      expect(runtimeGuardState()).toBe('unguarded');
    } finally {
      putBack();
    }
    expect(runtimeGuardState()).toBe('applied');
  });

  it.runIf(v8SharesNumbers())('the flag is set on an engine that has the defect whatever the process was started with: setting it again changes nothing where it is off', () => {
    const set = vi.spyOn(v8, 'setFlagsFromString');
    applyRuntimeGuard();
    expect(set).toHaveBeenCalledWith(TIER_OFF_FLAG);
  });

  it('a second copy of the module, as a bundle loaded beside the package would be, reads the same state', async () => {
    const second = './../../src/runtime-guard.ts?a-second-copy';
    const copy = (await import(second)) as typeof import('../../src/runtime-guard.js');
    expect(copy.runtimeGuardState).not.toBe(runtimeGuardState);
    expect(copy.runtimeGuardState()).toBe(runtimeGuardState());
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

describe('what the documents say of the guard is what the code does', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const reference = readFileSync(join(root, 'docs', 'api-reference.md'), 'utf8');
  /** The changelog's entry for the guard: from its first line to the next entry of the list. */
  const entry = /^- \*\*On Node 24 and 26, a number in a result cannot be another result's\.\*\*[\s\S]*?(?=^- \*\*)/m.exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))?.[0] ?? '';

  it('the changelog has the entry', () => {
    expect(entry.length).toBeGreaterThan(0);
  });

  it('each names the first release of a line that carries the fix, and no other, as the code reads it', () => {
    const fixed = releasesWithTheFix();
    expect(fixed).toEqual(['26.12.0']);
    const v8OfTheLine: Record<string, string> = { '26': '14.6.202.34-node.32' };
    for (const release of fixed) {
      const [major] = release.split('.');
      expect(v8SharesNumbers(v8OfTheLine[major] ?? '', release), release).toBe(false);
      for (const [name, text] of [['README.md', readme], ['CHANGELOG.md', entry]] as const) expect(text, name).toContain(`Node ${major} before ${release}`);
    }
    // Node 24 has no such release: both say every one so far has it.
    for (const [name, text] of [['README.md', readme], ['CHANGELOG.md', entry]] as const) expect(text, name).toContain('every Node 24 released so far');
  });

  it('each says Node 22 does not have it, and the code reads its engine as clean', () => {
    expect(v8SharesNumbers('12.4.254.21-node.39', '22.23.5')).toBe(false);
    for (const [name, text] of [['README.md', readme], ['CHANGELOG.md', entry]] as const) expect(text, name).toContain('Node 22 does not have it');
  });

  it('each tells a host the call the library exports, and the flag', async () => {
    const library = await import('../../src/engine.js');
    expect(typeof library.applyRuntimeGuard).toBe('function');
    for (const [name, text] of [['README.md', readme], ['CHANGELOG.md', entry]] as const) {
      expect(text, name).toContain('`applyRuntimeGuard()`');
      expect(text, name).toContain(`\`${TIER_OFF_FLAG}\``);
    }
  });

  it('the reference describes `runtime`, and names every state the guard can be in', () => {
    const runtime = /the `runtime` \([^]*?\), the `tools`/.exec(reference)?.[0] ?? '';
    expect(runtime).toContain('`sharedNumbers`');
    for (const state of RUNTIME_GUARD_STATES) expect(runtime, state).toContain(`\`${state}\``);
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

  /** Every test runner configuration in the repository, found on disk: a new one is held by the test below the day it is added. */
  const configs = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return ['node_modules', 'dist', '.git', '.next', 'coverage'].includes(entry.name) ? [] : configs(join(dir, entry.name));
      return /^vitest\.config\.[cm]?[jt]s$/.test(entry.name) ? [relative(root, join(dir, entry.name)).replace(/\\/g, '/')] : [];
    });

  /** The dashboard's tests render its pages and build no evaluator (held below). */
  const EVALUATES_NOTHING = new Set(['dashboard/vitest.config.ts']);

  it('the test workers of every configuration load that setup before any other', () => {
    const found = configs(root).sort();
    expect(found).toEqual(['dashboard/vitest.config.ts', 'tests/mcpb/vitest.config.ts', 'tests/real-clients/vitest.config.ts', 'tests/stall/vitest.config.ts', 'tests/upgrade/vitest.config.ts', 'vitest.config.ts']);
    for (const config of found.filter((c) => !EVALUATES_NOTHING.has(c))) {
      expect(/setupFiles:\s*\[\s*'([^']+)'/.exec(readFileSync(join(root, config), 'utf8'))?.[1], config).toBe('./tests/setup/runtime-guard.ts');
    }
  });

  it("the dashboard's tests build no evaluator: nothing they load, followed through every module of the server's they import, reaches it", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []));
    /** A relative import as the bundler resolves it: as written, or a .js that names a .ts, or a path without its extension. */
    const resolved = (from: string, spec: string): string | undefined => {
      const at = resolve(dirname(from), spec);
      return [at, at.replace(/\.js$/, '.ts'), at.replace(/\.js$/, '.tsx'), `${at}.ts`, `${at}.tsx`, join(at, 'index.ts')].find((p) => /\.[cm]?[jt]sx?$/.test(p) && existsSync(p));
    };
    // Statements that load a module at run time: not `import type` or `export type`, which leave nothing behind.
    const LOADS = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    const engine = join(root, 'src', 'eval', 'engine.ts');
    const queue = [...files(join(root, 'dashboard', 'tests')), ...files(join(root, 'dashboard', 'src'))];
    const seen = new Set<string>();
    const server: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (relative(root, file).replace(/\\/g, '/').startsWith('src/')) server.push(relative(root, file).replace(/\\/g, '/'));
      for (const m of readFileSync(file, 'utf8').matchAll(LOADS)) {
        const target = resolved(file, m[1] ?? m[2]);
        if (target !== undefined) queue.push(target);
      }
    }
    // What the dashboard does load of the server's: the search parser and what it imports.
    expect(server.length).toBeGreaterThan(0);
    expect(seen.has(engine)).toBe(false);
    expect(server.filter((file) => file.startsWith('src/eval/') || file === 'src/runtime-guard.ts')).toEqual([]);
  });

  it('the module that applies it does nothing else, so that importing it first costs nothing', () => {
    const source = readFileSync(join(root, 'src', 'apply-runtime-guard.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim().split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(source).toEqual(["import { applyRuntimeGuard } from './runtime-guard.js';", 'applyRuntimeGuard();']);
  });
});
