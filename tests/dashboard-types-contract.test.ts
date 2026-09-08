/*
 * The dashboard's evaluation type names every key the server sends (D-0).
 *
 * The dashboard is a separate TypeScript project with its own copy of the
 * response shape in dashboard/src/api/types.ts. From 0.9.0 to 0.13.0 the
 * server added verdict, coverage, interpretations and provenance to every
 * evaluation, and the dashboard's type never learned any of them — so the
 * screen could not render what the engine had computed. A type in another
 * project is not held by tsc; this test holds it.
 *
 * What it checks, precisely: every key present on a serialized evaluation
 * rich enough to set the optional fields is declared as a field of the
 * dashboard's `EvalResult` interface; and every key on a serialized rule
 * result is declared on its `EvalRuleResult`. Read textually — the
 * interface's own field names — because the dashboard's types are not
 * importable from the server's test runner.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../src/eval/engine.js';
import { defaultConfig } from '../src/config/defaults.js';
import { toEvaluationResponse } from '../src/eval/response.js';

const root = resolve(__dirname, '..');
const source = readFileSync(join(root, 'dashboard', 'src', 'api', 'types.ts'), 'utf8').replace(/\r\n/g, '\n');

/** The field names declared directly inside `export interface <name> { … }` (top-level members only). */
function fieldsOf(name: string): Set<string> {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`dashboard types: interface ${name} not found`);
  let depth = 0;
  let i = start + `export interface ${name} `.length;
  const body: string[] = [];
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 1) body.push(ch);
  }
  const fields = new Set<string>();
  for (const line of body.join('').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/);
    if (m) fields.add(m[1]);
  }
  return fields;
}

const OUTPUT = 'Here is the summary. The customer record shows SSN 123-45-6789 and the refund was approved.';

describe('dashboard/src/api/types.ts names every key the server sends', () => {
  it('EvalResult declares every key of a rich serialized evaluation', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const result = await engine.evaluateAll({
      output: OUTPUT,
      input: 'Summarise the customer record.',
      toolCalls: [{ tool_name: 'lookup', input: { id: 1 }, output: 'ok' }],
      costUsd: 1.33,
    });
    const response = toEvaluationResponse(result, { traceId: 'trace-1', note: 'x' });
    const declared = fieldsOf('EvalResult');
    // `note` is the response's own commentary, not a stored field; the dashboard shows it if present.
    const missing = Object.keys(response).filter((k) => k !== 'note' && !declared.has(k));
    expect(missing, 'response keys the dashboard type does not declare').toEqual([]);
    for (const must of ['verdict', 'coverage', 'interpretations', 'provenance']) expect(declared.has(must), must).toBe(true);
  });

  it('EvalRuleResult declares every key of a serialized rule result', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const result = await engine.evaluateAll({ output: OUTPUT, costUsd: 1.33 });
    const declared = fieldsOf('EvalRuleResult');
    const keys = new Set<string>();
    for (const r of result.rule_results) for (const k of Object.keys(r)) if ((r as unknown as Record<string, unknown>)[k] !== undefined) keys.add(k);
    const missing = [...keys].filter((k) => !declared.has(k));
    expect(missing, 'rule-result keys the dashboard type does not declare').toEqual([]);
    for (const must of ['kind', 'role', 'evidence', 'uncertainty', 'criticalSource']) expect(declared.has(must), must).toBe(true);
  });
});
