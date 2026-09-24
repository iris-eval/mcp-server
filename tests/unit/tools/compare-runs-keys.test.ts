/*
 * The compare_runs answer's top-level keys, locked — a key
 * that appears or disappears here is a contract change and must be named.
 */
import { describe, expect, it } from 'vitest';
import { compareRunsOutputSchema } from '../../../src/tools/compare-runs.js';

describe('compare_runs — the answer\'s keys', () => {
  it('are exactly these', () => {
    expect(Object.keys(compareRunsOutputSchema.shape).sort()).toEqual(
      [
        'after',
        'before',
        'better',
        'comparable',
        'dataset',
        'difference',
        'discordant',
        'discordant_total',
        'equivalent_within',
        'forced',
        'improvements',
        'incomparable_because',
        'method',
        'paired',
        'regressions',
        'rules_tested',
        'smallest_detectable',
        'summary',
        'worse',
      ].sort(),
    );
  });
});
