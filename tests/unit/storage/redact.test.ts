/*
 * storage.redact: 'critical_spans' — an evaluation is stored with the spans
 * a critical detector flagged replaced by [REDACTED:<pattern>], so a tool
 * that detects leaks need not keep the leak it found. The evidence offsets
 * still index the ORIGINAL text (they are what the caller saw), which the
 * option's documentation states.
 */
import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createStorage } from '../../../src/storage/index.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const OUTPUT = 'Customer SSN 536-22-8145 on file; card 4111 1111 1111 1111 was charged. Thanks!';

describe('storage.redact', () => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds);

  it('critical_spans stores the flagged spans redacted, keeps the offsets, and leaves quiet text alone', async () => {
    const storage = new SqliteAdapter(':memory:', { redact: 'critical_spans' });
    await storage.initialize();
    const result = engine.evaluate('safety', { output: OUTPUT });
    const pii = result.rule_results.find((r) => r.ruleName === 'no_pii')!;
    expect(pii.passed).toBe(false);
    const spans = (pii.evidence ?? []).filter((e) => e.type === 'span');
    expect(spans.length).toBeGreaterThan(0);
    await storage.insertEvalResult(LOCAL_TENANT, result);
    const stored = (await storage.getEvalById(LOCAL_TENANT, result.id))!;
    expect(stored.output_text).not.toContain('536-22-8145');
    expect(stored.output_text).not.toContain('4111 1111 1111 1111');
    expect(stored.output_text).toMatch(/\[REDACTED:[^\]]+\]/);
    expect(stored.output_text).toContain('Thanks!');
    expect(stored.rule_results.find((r) => r.ruleName === 'no_pii')!.evidence).toEqual(pii.evidence);
    expect(stored.score).toBe(result.score);
    await storage.close();
  });

  it('none (the default) stores the text verbatim', async () => {
    const storage = createStorage(defaultConfig) as SqliteAdapter;
    await storage.initialize();
    const result = engine.evaluate('safety', { output: OUTPUT });
    await storage.insertEvalResult(LOCAL_TENANT, result);
    expect((await storage.getEvalById(LOCAL_TENANT, result.id))!.output_text).toBe(OUTPUT);
    await storage.close();
  });

  it('a clean output is stored unchanged under critical_spans', async () => {
    const storage = new SqliteAdapter(':memory:', { redact: 'critical_spans' });
    await storage.initialize();
    const clean = 'The report is ready and the weather in Paris stays mild this week.';
    const result = engine.evaluate('safety', { output: clean });
    await storage.insertEvalResult(LOCAL_TENANT, result);
    expect((await storage.getEvalById(LOCAL_TENANT, result.id))!.output_text).toBe(clean);
    await storage.close();
  });
});
