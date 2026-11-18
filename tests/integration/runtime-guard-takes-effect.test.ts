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

/** The warnings of Iris's own that a fresh process emitted while it built two evaluators; null when the process did not get that far. */
function warningsOf(mode: 'none' | 'guard'): string[] | null {
  const child = spawnSync(process.execPath, ['--import', 'tsx', WARNS, mode], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const line = `${child.stdout ?? ''}`.split(/\r?\n/).find((l) => l.startsWith('WARNINGS '));
  return line === undefined ? null : (JSON.parse(line.slice('WARNINGS '.length)) as string[]);
}

type Mode = 'guard' | 'none' | 'guard-worker' | 'none-worker';

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
});
