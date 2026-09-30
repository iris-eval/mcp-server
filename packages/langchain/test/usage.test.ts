/*
 * One usage mapping, two handlers: every case in
 * tests/fixtures/langchain-usage-parity becomes the attributes it names, here
 * and in the Python handler's own test (packages/python/tests/test_langchain_usage.py),
 * so a LangChain run reads the same in Iris from either language and either
 * Anthropic integration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageAttributes } from '../src/usage.js';
import { REPO_ROOT } from './helpers.js';

interface Case {
  name: string;
  usage_metadata: unknown;
  response_metadata: unknown;
  attributes: Record<string, number>;
}
const { cases } = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'langchain-usage-parity', 'cases.json'), 'utf8')) as { cases: Case[] };

describe('LangChain usage → span attributes, against the shared expectation', () => {
  it('has cases', () => assert.ok(cases.length >= 6));
  for (const c of cases) {
    it(c.name, () => assert.deepEqual(usageAttributes(c.usage_metadata, c.response_metadata), c.attributes));
  }
  it('nothing to read is no attributes', () => {
    assert.deepEqual(usageAttributes(undefined, undefined), {});
    assert.deepEqual(usageAttributes({ input_tokens: -1, output_tokens: 1.5 }, null), {});
  });
});
