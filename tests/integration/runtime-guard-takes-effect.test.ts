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
import { v8SharesNumbers } from '../../src/runtime-guard.js';

const root = resolve(__dirname, '..', '..');
const FIXTURE = resolve(root, 'tests', 'fixtures', 'runtime-guard', 'hot.ts');

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
});
