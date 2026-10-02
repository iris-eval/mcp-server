/*
 * The evaluation list draws a verdict that was not checked as that: a grey
 * NOT CHECKED beside a grey score, never a red FAIL beside a red number.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { EvalTable } from '../../../src/components/evals/EvalTable';
import { EvalFilters } from '../../../src/components/evals/EvalFilters';
import type { EvalResult } from '../../../src/api/types';

const evaluation = (id: string, over: Partial<EvalResult>): EvalResult =>
  ({
    id,
    eval_type: 'all',
    output_text: 'answer',
    score: 0.9,
    passed: false,
    rule_results: [
      { ruleName: 'no_pii', passed: true, score: 1, message: 'ok' },
      { ruleName: 'cost_under_threshold', passed: false, score: 0, message: 'no cost', skipped: true },
    ],
    created_at: '2026-10-02T10:00:00.000Z',
    ...over,
  }) as EvalResult;

const verdict = (state: 'pass' | 'fail' | 'unknown') => ({ state, passed: state === 'pass', basis: state === 'pass' ? 'clean' : state === 'fail' ? 'detector_veto' : 'required_evidence_missing', by: [], risk: null }) as EvalResult['verdict'];

describe('EvalTable', () => {
  it('draws the three states apart, and the score of an unchecked verdict in neither colour of a result', () => {
    const { container } = render(
      <MemoryRouter>
        <EvalTable
          evals={[
            evaluation('ev_pass', { passed: true, verdict: verdict('pass') }),
            evaluation('ev_fail', { verdict: verdict('fail') }),
            evaluation('ev_unsent', { verdict: verdict('unknown') }),
            // A row from a server older than the verdict: only `passed` to read.
            evaluation('ev_old', { verdict: undefined }),
          ]}
          onSelect={vi.fn()}
        />
      </MemoryRouter>,
    );
    const rows = [...container.querySelectorAll('tbody tr')];
    const cell = (row: Element, n: number) => row.querySelectorAll('td')[n];
    expect(rows.map((r) => cell(r, 1).textContent)).toEqual(['PASS', 'FAIL', 'NOT CHECKED', 'FAIL']);
    const scoreColour = (row: Element) => (cell(row, 2).querySelector('span') as HTMLElement).style.color;
    expect(scoreColour(rows[2])).toBe('rgb(161, 161, 170)');
    expect(scoreColour(rows[1])).not.toBe('rgb(161, 161, 170)');
    // Passed of the rules that ran: the skipped rule is in neither number.
    expect(cell(rows[0], 3).textContent).toBe('1/1');
  });
});

describe('EvalFilters', () => {
  it('the result filter says "Did not pass": it holds failures and verdicts that were not checked', () => {
    const { container } = render(<EvalFilters values={{ eval_type: '', passed: '', since: '', until: '' }} onChange={vi.fn()} />);
    const options = [...container.querySelectorAll('select[aria-label="Filter by result"] option')].map((o) => o.textContent);
    expect(options).toEqual(['All Results', 'Passed', 'Did not pass']);
  });
});
