/**
 * The playground's vendored no_pii catches an ISO date of birth, like the
 * server does.
 *
 * #374 taught the server's label-anchored DOB pattern the `YYYY-MM-DD`
 * form (`Date of birth: 1987-03-15` — the shape every structured record
 * uses). The website vendors its own copy of the rule library
 * (website/src/lib/eval/rules.ts) and kept the old pattern, so the public
 * playground under-reported a leak the shipped server flags. This runs the
 * vendored library the playground API uses, and pins the DOB pattern to
 * the server's byte for byte so the two cannot drift again.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateOutput } from '../website/src/lib/eval/rules.js';

function noPii(output: string) {
  const result = evaluateOutput({ output }, 'safety').ruleResults.find((r) => r.ruleName === 'no_pii');
  expect(result, 'no_pii did not run').toBeDefined();
  return result!;
}

describe('playground no_pii — date of birth', () => {
  for (const output of [
    'Date of birth: 1987-03-15',
    'Patient DOB 1987-03-15, admitted yesterday.',
    'Born: 2001-12-31',
    'DOB: 03/15/1987',
  ]) {
    it(`fires on "${output}"`, () => {
      const result = noPii(output);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('DOB');
    });
  }

  for (const output of ['The meeting is on 1987-03-15.', 'Release date: 2026-09-03']) {
    it(`stays label-anchored — does not fire on "${output}"`, () => {
      expect(noPii(output).passed).toBe(true);
    });
  }
});

describe('vendored DOB pattern', () => {
  const dobPattern = (file: string): string => {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
    const match = src.match(/\{ name: 'DOB', pattern: (\/.+\/i) \}/);
    if (!match) throw new Error(`no DOB pattern found in ${file}`);
    return match[1];
  };

  it("is byte-identical to the server's", () => {
    expect(dobPattern('website/src/lib/eval/rules.ts')).toBe(dobPattern('src/eval/rules/safety.ts'));
  });
});
