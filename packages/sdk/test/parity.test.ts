/*
 * One mapping, two languages: every case in tests/fixtures/genai-parity is
 * turned into the span in expected.json — by this package here, and by the
 * Python client's `_genai.py` in its own test — so a call recorded from
 * either language reads the same in Iris.
 *
 * IRIS_PARITY_WRITE=1 rewrites expected.json from this implementation; the
 * Python test then says whether it agrees.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { genAiSpan, type Api } from '../src/index.js';
import { REPO_ROOT } from './helpers.js';

const dir = join(REPO_ROOT, 'tests', 'fixtures', 'genai-parity');
const { cases } = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')) as {
  cases: Array<{ name: string; api: Api; request: Record<string, unknown>; response?: Record<string, unknown>; error?: [string, string] }>;
};

const spans = cases.map((c) => {
  const span = genAiSpan({ api: c.api, request: c.request, response: c.response, error: c.error ? { type: c.error[0], message: c.error[1] } : undefined });
  return { name: c.name, span: { name: span.name, attributes: span.attributes } };
});

if (process.env.IRIS_PARITY_WRITE === '1') writeFileSync(join(dir, 'expected.json'), `${JSON.stringify(spans, null, 2)}\n`);

describe('the GenAI mapping, against the shared expectation', () => {
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as typeof spans;
  it('covers every case', () => assert.deepEqual(expected.map((e) => e.name), cases.map((c) => c.name)));
  for (const [i, c] of cases.entries()) {
    it(c.name, () => assert.deepEqual(spans[i].span, expected[i].span));
  }
});
