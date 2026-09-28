/*
 * claims:check names the fields that drifted (scripts/claims/diff-paths.mjs).
 * Before, it printed only "claims.json drifted from generator output", and
 * on main at 969719e that sentence hid a single failed test in the capture:
 * tests.vitestRoot.passed 3730 against 3729.
 */
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module
import { diffPaths } from '../../../scripts/claims/diff-paths.mjs';

describe('diffPaths', () => {
  it('names each leaf that moved, with both values', () => {
    const committed = { tests: { vitestRoot: { total: 3730, passed: 3730, failed: 0 } }, version: { mcpServer: '0.19.0' } };
    const generated = { tests: { vitestRoot: { total: 3730, passed: 3729, failed: 1 } }, version: { mcpServer: '0.19.0' } };
    expect(diffPaths(committed, generated)).toEqual([
      { path: 'tests.vitestRoot.failed', committed: '0', generated: '1' },
      { path: 'tests.vitestRoot.passed', committed: '3730', generated: '3729' },
    ]);
  });

  it('reports a key on one side only as absent, compares arrays as a whole, and cuts long values', () => {
    expect(diffPaths({ a: 1 }, { a: 1, b: 2 })).toEqual([{ path: 'b', committed: 'absent', generated: '2' }]);
    expect(diffPaths({ list: [1, 2] }, { list: [1, 2] })).toEqual([]);
    expect(diffPaths({ list: [1, 2] }, { list: [2, 1] })).toEqual([
      { path: 'list.0', committed: '1', generated: '2' },
      { path: 'list.1', committed: '2', generated: '1' },
    ]);
    const long = 'x'.repeat(200);
    expect(diffPaths({ s: long }, { s: 'y' })[0].committed).toBe(`${JSON.stringify(long).slice(0, 80)}…`);
  });

  it('returns nothing for equal values', () => {
    expect(diffPaths({ a: { b: [1, { c: null }] } }, { a: { b: [1, { c: null }] } })).toEqual([]);
  });
});
