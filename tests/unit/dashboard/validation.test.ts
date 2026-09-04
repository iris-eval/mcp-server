import { describe, it, expect } from 'vitest';
import {
  traceQuerySchema,
  evalQuerySchema,
  summaryQuerySchema,
  failuresQuerySchema,
  ingestTraceSchema,
  strictBody,
} from '../../../src/dashboard/validation.js';
import { z } from 'zod';

/*
 * POST /api/v1/traces body — the HTTP twin of the strict MCP tool args.
 * Before this schema was strict, `eval_typ: "safety"` was silently
 * dropped, the completeness bundle ran, and PII-laden output came back
 * green (#376 item 2). The schema also used to RELY on stripping to
 * discard a client-supplied trace_id; that field is now rejected
 * explicitly, with a message saying the server mints it.
 */
describe('ingestTraceSchema', () => {
  it('accepts the full log_trace body plus the evaluate opt-in', () => {
    const result = ingestTraceSchema.parse({
      agent_name: 'a',
      output: 'hello',
      evaluate: true,
      eval_type: 'safety',
      metadata: { anything: 'goes' },
      spans: [{ name: 's', start_time: '2026-08-11T12:00:00.000Z' }],
    });
    expect(result.eval_type).toBe('safety');
    expect(result.evaluate).toBe(true);
    expect(result.metadata).toEqual({ anything: 'goes' });
  });

  it('defaults evaluate=false and leaves an omitted eval_type undefined for the route to default', () => {
    // The schema no longer bakes in a bundle: the route resolves an omitted
    // eval_type to DEFAULT_EVAL_TYPE (every bundle) and says so in the
    // response, which it can only do if the schema keeps "omitted" visible.
    const result = ingestTraceSchema.parse({ agent_name: 'a' });
    expect(result.evaluate).toBe(false);
    expect(result.eval_type).toBeUndefined();
  });

  it('accepts eval_type "all" — the same bundle list evaluate_output takes', () => {
    const result = ingestTraceSchema.parse({ agent_name: 'a', output: 'x', evaluate: true, eval_type: 'all' });
    expect(result.eval_type).toBe('all');
  });

  it('rejects a misspelled eval_typ, naming the key and listing the valid ones', () => {
    const parsed = ingestTraceSchema.safeParse({
      agent_name: 'a',
      output: 'SSN 536-22-8145',
      evaluate: true,
      eval_typ: 'safety',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('"eval_typ"');
    expect(messages).toContain('eval_type');
    expect(messages).toContain('agent_name');
    expect(messages).toMatch(/rejected rather than silently dropped/);
  });

  it('rejects a client-supplied trace_id and says the server mints it', () => {
    const parsed = ingestTraceSchema.safeParse({ agent_name: 'a', trace_id: 'attacker-chosen' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('"trace_id"');
    expect(messages).toMatch(/minted by the server/);
  });

  it('still requires output when evaluate is true', () => {
    const parsed = ingestTraceSchema.safeParse({ agent_name: 'a', evaluate: true });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.path.includes('output'))).toBe(true);
  });
});

describe('strictBody', () => {
  it('lists every valid key in the rejection', () => {
    const schema = strictBody({ a: z.string(), b: z.number().optional() });
    const parsed = schema.safeParse({ a: 'x', c: 1 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0].message).toContain('Valid keys: a, b');
  });

  it('appends the reserved-key note only for reserved keys', () => {
    const schema = strictBody({ a: z.string() }, { reserved: { id: 'id is server-owned.' } });
    const reserved = schema.safeParse({ a: 'x', id: '1' });
    expect(reserved.success).toBe(false);
    if (!reserved.success) expect(reserved.error.issues[0].message).toContain('id is server-owned.');
    const plain = schema.safeParse({ a: 'x', typo: '1' });
    expect(plain.success).toBe(false);
    if (!plain.success) expect(plain.error.issues[0].message).not.toContain('server-owned');
  });
});

describe('traceQuerySchema', () => {
  it('should parse valid query with defaults', () => {
    const result = traceQuerySchema.parse({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.sort_by).toBe('timestamp');
    expect(result.sort_order).toBe('desc');
  });

  it('should parse string numbers', () => {
    const result = traceQuerySchema.parse({ limit: '25', offset: '10' });
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(10);
  });

  it('should reject limit > 1000', () => {
    expect(() => traceQuerySchema.parse({ limit: '5000' })).toThrow();
  });

  it('should reject negative offset', () => {
    expect(() => traceQuerySchema.parse({ offset: '-1' })).toThrow();
  });

  it('should reject invalid sort_by', () => {
    expect(() => traceQuerySchema.parse({ sort_by: 'invalid' })).toThrow();
  });

  it('should reject invalid sort_order', () => {
    expect(() => traceQuerySchema.parse({ sort_order: 'sideways' })).toThrow();
  });

  it('should accept valid filters', () => {
    const result = traceQuerySchema.parse({ agent_name: 'test', framework: 'langchain' });
    expect(result.agent_name).toBe('test');
    expect(result.framework).toBe('langchain');
  });

  /*
   * The ranges get_traces refuses (#373) are refused here too, with the
   * same helpers — an HTTP caller used to get an empty page for a window
   * that could never match, which reads as "no such traces".
   */
  describe('impossible ranges — mirrored from get_traces', () => {
    const messages = (input: Record<string, string>) => {
      const parsed = traceQuerySchema.safeParse(input);
      expect(parsed.success).toBe(false);
      return parsed.success ? '' : parsed.error.issues.map((i) => i.message).join('\n');
    };

    it('rejects since later than until, naming both values', () => {
      const msg = messages({ since: '2026-08-02T00:00:00Z', until: '2026-08-01T00:00:00Z' });
      expect(msg).toContain('since (2026-08-02T00:00:00Z) must not be later than until (2026-08-01T00:00:00Z)');
    });

    it('rejects a since/until that is not an ISO timestamp or date', () => {
      expect(messages({ since: 'yesterday' })).toContain('ISO 8601');
      expect(messages({ since: 'yesterday' })).toContain('"yesterday"');
      expect(messages({ until: '08/01/2026' })).toContain('ISO 8601');
      expect(messages({ until: '08/01/2026' })).toContain('"08/01/2026"');
    });

    it('accepts an ISO instant with an offset and a calendar date', () => {
      const result = traceQuerySchema.parse({ since: '2026-08-01', until: '2026-08-02T00:00:00+02:00' });
      expect(result.since).toBe('2026-08-01');
      expect(result.until).toBe('2026-08-02T00:00:00+02:00');
    });

    it('rejects min_score above max_score, naming both values', () => {
      expect(messages({ min_score: '0.9', max_score: '0.1' })).toContain('min_score (0.9) must be <= max_score (0.1)');
    });

    it('rejects a score outside 0..1 and coerces a valid one', () => {
      expect(traceQuerySchema.safeParse({ min_score: '1.5' }).success).toBe(false);
      expect(traceQuerySchema.safeParse({ max_score: '-0.1' }).success).toBe(false);
      const ok = traceQuerySchema.parse({ min_score: '0.25', max_score: '0.75' });
      expect(ok.min_score).toBe(0.25);
      expect(ok.max_score).toBe(0.75);
    });

    it('rejects a negative offset', () => {
      expect(traceQuerySchema.safeParse({ offset: '-5' }).success).toBe(false);
    });
  });
});

describe('evalQuerySchema', () => {
  it('should parse valid query with defaults', () => {
    const result = evalQuerySchema.parse({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it('should coerce passed to boolean', () => {
    const result = evalQuerySchema.parse({ passed: 'true' });
    expect(result.passed).toBe(true);
  });
});

describe('summaryQuerySchema', () => {
  it('should parse valid hours', () => {
    const result = summaryQuerySchema.parse({ hours: '48' });
    expect(result.hours).toBe(48);
  });

  it('should default to 24 hours', () => {
    const result = summaryQuerySchema.parse({});
    expect(result.hours).toBe(24);
  });

  it('should reject hours > 8760', () => {
    expect(() => summaryQuerySchema.parse({ hours: '10000' })).toThrow();
  });
});

describe('failuresQuerySchema', () => {
  it('should parse valid query with defaults', () => {
    const result = failuresQuerySchema.parse({});
    expect(result.limit).toBe(50);
    expect(result.agent_name).toBeUndefined();
  });

  it('should parse string numbers', () => {
    const result = failuresQuerySchema.parse({ limit: '25' });
    expect(result.limit).toBe(25);
  });

  it('should reject limit > 100', () => {
    expect(() => failuresQuerySchema.parse({ limit: '101' })).toThrow();
  });

  it('should reject limit < 1', () => {
    expect(() => failuresQuerySchema.parse({ limit: '0' })).toThrow();
  });

  it('should accept ISO datetimes for since/until and reject junk', () => {
    const result = failuresQuerySchema.parse({
      since: '2026-04-22T20:00:00.000Z',
      until: '2026-04-23T20:00:00.000Z',
    });
    expect(result.since).toBe('2026-04-22T20:00:00.000Z');
    expect(result.until).toBe('2026-04-23T20:00:00.000Z');
    expect(() => failuresQuerySchema.parse({ since: 'yesterday' })).toThrow();
  });

  it('should reject empty agent_name', () => {
    expect(() => failuresQuerySchema.parse({ agent_name: '' })).toThrow();
  });
});
