/*
 * One structured event per evaluation (arc 8, R-6).
 *
 * The engine has no logger; it has one observer seam that every door —
 * the tools, HTTP ingest, the CLI, re-evaluation — reaches through
 * evaluate() and evaluateAll(). The server wires it to the logger's
 * `event('evaluation', …)`. The event carries the verdict and its shape,
 * never the text and never a key; a throwing observer does not fail the
 * evaluation; null unsubscribes.
 */
import { describe, it, expect } from 'vitest';
import { EvalEngine, evaluationEvent, type EvaluationEvent } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createLogger } from '../../../src/utils/logger.js';

const engine = () => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);

describe('EvalEngine.setObserver', () => {
  it('fires once per evaluateAll with the verdict, the counts, the prior source and a duration — and no text', async () => {
    const e = engine();
    const events: EvaluationEvent[] = [];
    e.setObserver((ev) => events.push(ev));
    const result = await e.evaluateAll({ output: 'TODO: write the summary.', input: 'Summarise the notes.' });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.evaluation_id).toBe(result.id);
    expect(ev.eval_type).toBe('all');
    expect(ev.verdict).toBe('fail');
    expect(ev.verdict).toBe(result.verdict?.state);
    expect(ev.basis).toBe(result.verdict?.basis);
    expect(ev.passed).toBe(false);
    expect(ev.score).toBe(result.score);
    expect(ev.rules_evaluated).toBeGreaterThan(0);
    expect(ev.critical_failures).toEqual(result.critical_failures ?? []);
    expect(['default', 'config', 'estimated']).toContain(ev.prior_source);
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(ev)).not.toContain('write the summary');
    expect(JSON.stringify(ev)).not.toContain('Summarise');
  });

  it('fires for a single-type evaluate too, and for the no-rules result', async () => {
    const e = engine();
    const events: EvaluationEvent[] = [];
    e.setObserver((ev) => events.push(ev));
    await e.evaluate('safety', { output: 'A perfectly ordinary sentence about the weather today.' });
    expect(events).toHaveLength(1);
    expect(events[0].eval_type).toBe('safety');
    const none = evaluationEvent(
      {
        id: 'eval_x',
        eval_type: 'custom',
        output_text: 'x',
        score: 0,
        passed: false,
        rule_results: [],
        rules_evaluated: 0,
        rules_skipped: 0,
        insufficient_data: true,
        verdict: { state: 'unknown', passed: false, basis: 'no_rules', by: [], risk: null },
      } as never,
      3.14159,
    );
    expect(none.verdict).toBe('unknown');
    expect(none.basis).toBe('no_rules');
    expect(none.duration_ms).toBe(3.14);
    expect(none.prior_source).toBeNull();
  });

  it('a throwing observer never fails the evaluation, and null unsubscribes', async () => {
    const e = engine();
    e.setObserver(() => {
      throw new Error('log sink down');
    });
    const result = await e.evaluateAll({ output: 'TODO: write the summary.' });
    expect(result.verdict?.state).toBe('fail');
    let fired = 0;
    e.setObserver(() => {
      fired++;
    });
    await e.evaluateAll({ output: 'TODO' });
    e.setObserver(null);
    await e.evaluateAll({ output: 'TODO' });
    expect(fired).toBe(1);
  });

  it('the real logger exposes event(), the mock four-method logger need not', () => {
    const logger = createLogger({ logging: { level: 'silent' as unknown as 'error' } });
    expect(typeof logger.event).toBe('function');
    // Optional on the interface: a test logger without it type-checks and `logger.event?.()` is a no-op.
    const mock: import('../../../src/utils/logger.js').Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    expect(mock.event).toBeUndefined();
  });
});
