import { describe, it, expect } from 'vitest';
import { traceQuerySchema, evalQuerySchema, summaryQuerySchema, exportTraceQuerySchema, exportEvalQuerySchema } from '../../../src/dashboard/validation.js';

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

describe('exportTraceQuerySchema', () => {
  it('should default format to json', () => {
    const result = exportTraceQuerySchema.parse({});
    expect(result.format).toBe('json');
  });

  it('should accept csv format', () => {
    const result = exportTraceQuerySchema.parse({ format: 'csv' });
    expect(result.format).toBe('csv');
  });

  it('should accept json format', () => {
    const result = exportTraceQuerySchema.parse({ format: 'json' });
    expect(result.format).toBe('json');
  });

  it('should reject invalid format', () => {
    expect(() => exportTraceQuerySchema.parse({ format: 'xml' })).toThrow();
  });

  it('should accept filters', () => {
    const result = exportTraceQuerySchema.parse({ agent_name: 'bot', framework: 'langchain' });
    expect(result.agent_name).toBe('bot');
    expect(result.framework).toBe('langchain');
  });

  it('should not have limit or offset fields', () => {
    const result = exportTraceQuerySchema.parse({});
    expect((result as Record<string, unknown>).limit).toBeUndefined();
    expect((result as Record<string, unknown>).offset).toBeUndefined();
  });
});

describe('exportEvalQuerySchema', () => {
  it('should default format to json', () => {
    const result = exportEvalQuerySchema.parse({});
    expect(result.format).toBe('json');
  });

  it('should accept csv format', () => {
    const result = exportEvalQuerySchema.parse({ format: 'csv' });
    expect(result.format).toBe('csv');
  });

  it('should coerce passed to boolean', () => {
    const result = exportEvalQuerySchema.parse({ passed: 'false' });
    expect(result.passed).toBe(false);
  });

  it('should reject invalid format', () => {
    expect(() => exportEvalQuerySchema.parse({ format: 'tsv' })).toThrow();
  });

  it('should not have limit or offset fields', () => {
    const result = exportEvalQuerySchema.parse({});
    expect((result as Record<string, unknown>).limit).toBeUndefined();
    expect((result as Record<string, unknown>).offset).toBeUndefined();
  });
});
