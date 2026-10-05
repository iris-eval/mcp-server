import { describe, expect, it } from 'vitest';
import { judge, PULL_REQUEST_ONLY } from '../../../scripts/ci/require-checks-passed.mjs';

/*
 * The release's gate on main's CI (scripts/ci/require-checks-passed.mjs):
 * which check runs on the tagged commit let a release through, which make
 * it wait, and which refuse it.
 */

const done = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion });
const running = (name: string) => ({ name, status: 'in_progress', conclusion: null });

describe('a release waits for, and requires, the checks main runs', () => {
  it('passes when every context that runs on main succeeded', () => {
    expect(judge(['build', 'e2e'], [done('build', 'success'), done('e2e', 'success')])).toEqual({ failed: [], waiting: [] });
  });

  it('waits while a context is still running or has not started', () => {
    expect(judge(['build', 'e2e'], [done('build', 'success'), running('e2e')]).waiting).toEqual(['e2e']);
    expect(judge(['build', 'e2e'], [done('build', 'success')]).waiting).toEqual(['e2e']);
  });

  it('refuses a context that finished without succeeding, and counts a re-run that passed', () => {
    expect(judge(['e2e'], [done('e2e', 'failure')]).failed).toEqual(['e2e (failure)']);
    expect(judge(['e2e'], [done('e2e', 'cancelled')]).failed).toEqual(['e2e (cancelled)']);
    expect(judge(['e2e'], [done('e2e', 'cancelled'), done('e2e', 'success')])).toEqual({ failed: [], waiting: [] });
  });

  it('never waits for a context that runs only on pull requests', () => {
    expect([...PULL_REQUEST_ONLY].sort()).toEqual(['Build the sdist and the wheel', 'CodeQL']);
    expect(judge(['CodeQL', 'build'], [done('build', 'success')])).toEqual({ failed: [], waiting: [] });
  });
});
