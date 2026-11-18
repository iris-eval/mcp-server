/*
 * The runtime guard takes effect when it is set from inside the process.
 *
 * The guard is a V8 flag changed after start (src/runtime-guard.ts), and
 * the documents of `v8.setFlagsFromString` say such a change "may simply do
 * nothing". So this asks the engine itself: a function is run often enough
 * to be compiled, in a fresh process started with --trace-opt, and the
 * engine prints which compiler tier it chose. Without the guard it chooses
 * the tier at fault; with the guard applied first, as the entry point
 * applies it, that tier is never named for the function.
 *
 * The same is asked of a worker thread started after the guard: the server
 * runs its regex sandbox, its checkpointer and its search in such threads,
 * and the flag is set on the main one.
 *
 * Only an engine that has the defect is asked: on any other the guard does
 * nothing, on purpose.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { v8SharesNumbers, SHARED_NUMBERS_WARNING } from '../../src/runtime-guard.js';

const root = resolve(__dirname, '..', '..');
const FIXTURE = resolve(root, 'tests', 'fixtures', 'runtime-guard', 'hot.ts');
const WARNS = resolve(root, 'tests', 'fixtures', 'runtime-guard', 'engine-warns.ts');
const STARTED = resolve(root, 'tests', 'fixtures', 'runtime-guard', 'started-with.ts');

type WarnsMode = 'none' | 'guard' | 'apply-after-import' | 'guard-worker';

/** The warnings of Iris's own that a fresh process emitted while it built two evaluators; null when the process did not get that far. */
function warningsOf(mode: WarnsMode): string[] | null {
  return built(mode).warnings;
}

/** The same process's warnings, and the guard's state where the evaluators were built. */
function built(mode: WarnsMode): { warnings: string[] | null; state: string | undefined } {
  const child = spawnSync(process.execPath, ['--import', 'tsx', WARNS, mode], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const lines = `${child.stdout ?? ''}`.split(/\r?\n/);
  const warnings = lines.find((l) => l.startsWith('WARNINGS '));
  return { warnings: warnings === undefined ? null : (JSON.parse(warnings.slice('WARNINGS '.length)) as string[]), state: lines.find((l) => l.startsWith('STATE '))?.slice('STATE '.length) };
}

/** What a process started with these flags, or this NODE_OPTIONS, reads of the guard before and after the step asked, and the lines the engine printed about its hot function. */
function startedWith(flags: string[], nodeOptions: string | undefined, step: 'read' | 'apply'): { before?: string; after?: string; lines: string[]; done: boolean } {
  const env = { ...process.env };
  if (nodeOptions === undefined) delete env['NODE_OPTIONS'];
  else env['NODE_OPTIONS'] = nodeOptions;
  const child = spawnSync(process.execPath, ['--trace-opt', ...flags, '--import', 'tsx', STARTED, step], { cwd: root, encoding: 'utf8', timeout: 60_000, env });
  const out = `${child.stdout ?? ''}`;
  // The engine's trace and the fixture's line go to one stream, so the line is found wherever it starts.
  const state = /STATE (\w+) (\w+) (true|false)/.exec(out);
  return { before: state?.[1], after: state?.[2], lines: out.split(/\r?\n/).filter((line) => line.includes('hotLoop')), done: state?.[3] === 'true' };
}

type Mode = 'guard' | 'none' | 'guard-worker' | 'none-worker' | 'library';

/** The lines the engine printed about the fixture's hot function, in a fresh process. */
function tiersChosen(mode: Mode): { lines: string[]; done: boolean } {
  const child = spawnSync(process.execPath, ['--trace-opt', '--import', 'tsx', FIXTURE, mode], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const out = `${child.stdout ?? ''}`;
  return { lines: out.split(/\r?\n/).filter((line) => line.includes('hotLoop')), done: out.includes('DONE true') };
}

describe.skipIf(!v8SharesNumbers())('on an engine that has the defect', () => {
  it.each([['none'], ['none-worker']] as Array<[Mode]>)('without the guard (%s), the tier at fault compiles a hot function: the probe can see it', (mode) => {
    const { lines, done } = tiersChosen(mode);
    expect(done).toBe(true);
    expect(lines.some((line) => line.includes('MAGLEV'))).toBe(true);
  }, 90_000);

  it.each([['guard'], ['guard-worker']] as Array<[Mode]>)('with the guard applied first (%s), that tier never compiles it, and the function is still compiled', (mode) => {
    const { lines, done } = tiersChosen(mode);
    expect(done).toBe(true);
    expect(lines.filter((line) => line.includes('MAGLEV'))).toEqual([]);
    // Still optimised, by the tier above it: the guard turns one tier off, not the compiler.
    expect(lines.some((line) => line.includes('TURBOFAN'))).toBe(true);
  }, 90_000);

  // A process that embeds the evaluator and does neither thing the guard asks is told so by the evaluator itself.
  it('an evaluator built with nothing in the way says so once, however many are built', () => {
    expect(warningsOf('none')).toEqual([SHARED_NUMBERS_WARNING]);
  }, 90_000);

  it('an evaluator built after the guard was applied says nothing', () => {
    expect(warningsOf('guard')).toEqual([]);
  }, 90_000);

  it('importing the library changes nothing in its host: the tier at fault still compiles a hot function, and the state reads unguarded', () => {
    const { lines, done } = tiersChosen('library');
    expect(done).toBe(true);
    expect(lines.some((line) => line.includes('MAGLEV'))).toBe(true);
    expect(built('none').state).toBe('unguarded');
  }, 90_000);

  it('a host that imports the library and then applies the guard through it is told nothing: the library speaks when an evaluator is built, not when it is imported', () => {
    expect(built('apply-after-import')).toEqual({ warnings: [], state: 'applied' });
  }, 90_000);

  it('a worker thread started after the guard reads it as applied, and an evaluator built there says nothing', () => {
    expect(built('guard-worker')).toEqual({ warnings: [], state: 'applied' });
  }, 90_000);

  it.each([
    ['--no-maglev', undefined],
    ['--no_maglev', undefined],
    ['--nomaglev', undefined],
    ['--jitless', undefined],
    [undefined, '--jitless'],
  ] as Array<[string | undefined, string | undefined]>)('a process started with the tier off (flag %s, NODE_OPTIONS %s) reads as started, and the tier at fault never compiles', (flag, nodeOptions) => {
    const run = startedWith(flag === undefined ? [] : [flag], nodeOptions, 'read');
    expect(run.done).toBe(true);
    expect(run.before).toBe('started');
    expect(run.lines.filter((line) => line.includes('MAGLEV'))).toEqual([]);
  }, 90_000);

  it('a process started with the tier off and then on again reads as unguarded, and the guard turns it off: the tier at fault never compiles', () => {
    const run = startedWith(['--no-maglev', '--maglev'], undefined, 'apply');
    expect(run.done).toBe(true);
    expect([run.before, run.after]).toEqual(['unguarded', 'applied']);
    expect(run.lines.filter((line) => line.includes('MAGLEV'))).toEqual([]);
    // Without the guard the same start compiles it with that tier: the probe can see it.
    expect(startedWith(['--no-maglev', '--maglev'], undefined, 'read').lines.some((line) => line.includes('MAGLEV'))).toBe(true);
  }, 90_000);
});
