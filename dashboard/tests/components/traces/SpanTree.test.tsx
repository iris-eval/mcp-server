/*
 * The drawer's span tree for an agent run: the agent's own span reads as
 * INTERNAL and only the model calls as LLM. These are the spans the server
 * serves for the Microsoft Agent Framework fixture
 * (tests/fixtures/otlp/conventions/agent-framework.otlp.json at the
 * repository root, held there by tests/unit/dashboard/routes/otlp.test.ts):
 * one invoke_agent, two chat calls, one tool call. Before the server filed
 * agent operations as INTERNAL, the drawer showed three LLM rows for two
 * model calls.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { Span } from '../../../src/api/types';
import { SpanTree } from '../../../src/components/traces/SpanTree';

const at = (ms: number) => new Date(Date.UTC(2026, 8, 21, 12, 0, 0, ms)).toISOString();
const span = (id: string, parent: string | undefined, name: string, kind: string, from: number, to: number): Span => ({
  span_id: id,
  trace_id: 't-agent',
  ...(parent ? { parent_span_id: parent } : {}),
  name,
  kind,
  status_code: 'OK',
  start_time: at(from),
  end_time: at(to),
});

const served: Span[] = [
  span('s1', undefined, 'invoke_agent Writer', 'INTERNAL', 0, 900),
  span('s2', 's1', 'chat gpt-4o-mini', 'LLM', 10, 300),
  span('s3', 's1', 'execute_tool get_release_facts', 'TOOL', 310, 400),
  span('s4', 's1', 'chat gpt-4o-mini', 'LLM', 410, 890),
];

describe('SpanTree for an agent run', () => {
  it('shows the agent as INTERNAL at the root and counts only the model calls as LLM', () => {
    const { getAllByRole } = render(<SpanTree spans={served} />);
    const rows = getAllByRole('button');
    expect(rows).toHaveLength(4);
    const kindOf = (row: HTMLElement) => row.querySelectorAll('span')[1]?.textContent;
    expect(rows.map((r) => [r.getAttribute('aria-label'), kindOf(r)])).toEqual([
      ['Expand span invoke_agent Writer', 'INTERNAL'],
      ['Expand span chat gpt-4o-mini', 'LLM'],
      ['Expand span execute_tool get_release_facts', 'TOOL'],
      ['Expand span chat gpt-4o-mini', 'LLM'],
    ]);
    expect(rows.filter((r) => kindOf(r) === 'LLM')).toHaveLength(2);
  });
});
