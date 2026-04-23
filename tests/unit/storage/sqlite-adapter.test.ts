import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { sampleTrace, minimalTrace, allSampleTraces } from '../../fixtures/sample-traces.js';
import { generateEvalId } from '../../../src/utils/ids.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';

describe('SqliteAdapter', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('insertTrace / getTrace', () => {
    it('should insert and retrieve a trace', async () => {
      await adapter.insertTrace(LOCAL_TENANT, sampleTrace);
      const result = await adapter.getTrace(LOCAL_TENANT, sampleTrace.trace_id);
      expect(result).not.toBeNull();
      expect(result!.trace_id).toBe(sampleTrace.trace_id);
      expect(result!.agent_name).toBe('test-agent');
      expect(result!.framework).toBe('langchain');
    });

    it('should return null for non-existent trace', async () => {
      const result = await adapter.getTrace(LOCAL_TENANT, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should handle minimal trace', async () => {
      await adapter.insertTrace(LOCAL_TENANT, minimalTrace);
      const result = await adapter.getTrace(LOCAL_TENANT, minimalTrace.trace_id);
      expect(result).not.toBeNull();
      expect(result!.agent_name).toBe('minimal-agent');
    });

    it('should serialize tool_calls as JSON', async () => {
      await adapter.insertTrace(LOCAL_TENANT, sampleTrace);
      const result = await adapter.getTrace(LOCAL_TENANT, sampleTrace.trace_id);
      expect(result!.tool_calls).toEqual(sampleTrace.tool_calls);
    });

    it('should serialize token_usage as JSON', async () => {
      await adapter.insertTrace(LOCAL_TENANT, sampleTrace);
      const result = await adapter.getTrace(LOCAL_TENANT, sampleTrace.trace_id);
      expect(result!.token_usage).toEqual(sampleTrace.token_usage);
    });
  });

  describe('queryTraces', () => {
    beforeEach(async () => {
      for (const trace of allSampleTraces) {
        await adapter.insertTrace(LOCAL_TENANT, trace);
      }
    });

    it('should return all traces with default query', async () => {
      const result = await adapter.queryTraces(LOCAL_TENANT, {});
      expect(result.total).toBe(allSampleTraces.length);
      expect(result.traces.length).toBe(allSampleTraces.length);
    });

    it('should filter by agent_name', async () => {
      const result = await adapter.queryTraces(LOCAL_TENANT, { filter: { agent_name: 'test-agent' } });
      expect(result.total).toBe(1);
      expect(result.traces[0].agent_name).toBe('test-agent');
    });

    it('should filter by framework', async () => {
      const result = await adapter.queryTraces(LOCAL_TENANT, { filter: { framework: 'langchain' } });
      expect(result.total).toBe(1);
    });

    it('should support pagination', async () => {
      const page1 = await adapter.queryTraces(LOCAL_TENANT, { limit: 2, offset: 0 });
      const page2 = await adapter.queryTraces(LOCAL_TENANT, { limit: 2, offset: 2 });
      expect(page1.traces.length).toBe(2);
      expect(page2.traces.length).toBe(2);
      expect(page1.traces[0].trace_id).not.toBe(page2.traces[0].trace_id);
    });

    it('should sort by timestamp desc by default', async () => {
      const result = await adapter.queryTraces(LOCAL_TENANT, {});
      for (let i = 1; i < result.traces.length; i++) {
        expect(result.traces[i - 1].timestamp >= result.traces[i].timestamp).toBe(true);
      }
    });
  });

  describe('spans', () => {
    it('should insert and retrieve spans', async () => {
      await adapter.insertTrace(LOCAL_TENANT, sampleTrace);
      await adapter.insertSpan(LOCAL_TENANT, {
        span_id: 'span1',
        trace_id: sampleTrace.trace_id,
        name: 'test-span',
        kind: 'INTERNAL',
        status_code: 'OK',
        start_time: '2026-01-15T10:30:00.000Z',
      });
      const spans = await adapter.getSpansByTraceId(LOCAL_TENANT, sampleTrace.trace_id);
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('test-span');
    });

    it('should return empty array for trace with no spans', async () => {
      await adapter.insertTrace(LOCAL_TENANT, minimalTrace);
      const spans = await adapter.getSpansByTraceId(LOCAL_TENANT, minimalTrace.trace_id);
      expect(spans).toEqual([]);
    });
  });

  describe('eval results', () => {
    it('should insert and retrieve eval results', async () => {
      await adapter.insertTrace(LOCAL_TENANT, sampleTrace);
      const evalResult = {
        id: generateEvalId(),
        trace_id: sampleTrace.trace_id,
        eval_type: 'completeness' as const,
        output_text: 'Test output',
        score: 0.85,
        passed: true,
        rule_results: [{ ruleName: 'test', passed: true, score: 1, message: 'OK' }],
        suggestions: [],
      };
      await adapter.insertEvalResult(LOCAL_TENANT, evalResult);
      const results = await adapter.getEvalsByTraceId(LOCAL_TENANT, sampleTrace.trace_id);
      expect(results.length).toBe(1);
      expect(results[0].score).toBe(0.85);
      expect(results[0].passed).toBe(true);
    });

    it('should query eval results with filters', async () => {
      await adapter.insertTrace(LOCAL_TENANT, sampleTrace);
      await adapter.insertEvalResult(LOCAL_TENANT, {
        id: generateEvalId(),
        trace_id: sampleTrace.trace_id,
        eval_type: 'completeness',
        output_text: 'Test',
        score: 0.9,
        passed: true,
        rule_results: [],
        suggestions: [],
      });
      await adapter.insertEvalResult(LOCAL_TENANT, {
        id: generateEvalId(),
        trace_id: sampleTrace.trace_id,
        eval_type: 'safety',
        output_text: 'Test',
        score: 0.3,
        passed: false,
        rule_results: [],
        suggestions: [],
      });

      const passed = await adapter.queryEvalResults(LOCAL_TENANT, { passed: true });
      expect(passed.total).toBe(1);

      const safety = await adapter.queryEvalResults(LOCAL_TENANT, { eval_type: 'safety' });
      expect(safety.total).toBe(1);
      expect(safety.results[0].passed).toBe(false);
    });
  });

  describe('getDashboardSummary', () => {
    it('should return summary stats', async () => {
      for (const trace of allSampleTraces) {
        await adapter.insertTrace(LOCAL_TENANT, trace);
      }
      const summary = await adapter.getDashboardSummary(LOCAL_TENANT, 24 * 365 * 10);
      expect(summary.total_traces).toBe(allSampleTraces.length);
      expect(summary.avg_latency_ms).toBeGreaterThan(0);
    });

    it('should handle empty database', async () => {
      const summary = await adapter.getDashboardSummary(LOCAL_TENANT);
      expect(summary.total_traces).toBe(0);
      expect(summary.avg_latency_ms).toBe(0);
    });
  });

  describe('deleteTracesOlderThan', () => {
    it('should delete old traces', async () => {
      await adapter.insertTrace(LOCAL_TENANT, {
        ...sampleTrace,
        trace_id: 'old-trace',
        timestamp: '2020-01-01T00:00:00.000Z',
      });
      const recentTrace = {
        ...minimalTrace,
        trace_id: 'recent-trace',
        timestamp: new Date().toISOString(),
      };
      await adapter.insertTrace(LOCAL_TENANT, recentTrace);

      const deleted = await adapter.deleteTracesOlderThan(LOCAL_TENANT, 1);
      expect(deleted).toBe(1);

      const remaining = await adapter.queryTraces(LOCAL_TENANT, {});
      expect(remaining.total).toBe(1);
      expect(remaining.traces[0].trace_id).toBe('recent-trace');
    });
  });

  describe('getDistinctValues', () => {
    it('should return distinct agent names', async () => {
      for (const trace of allSampleTraces) {
        await adapter.insertTrace(LOCAL_TENANT, trace);
      }
      const names = await adapter.getDistinctValues(LOCAL_TENANT, 'agent_name');
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain('test-agent');
    });

    it('should reject invalid columns', async () => {
      await expect(adapter.getDistinctValues(LOCAL_TENANT, 'invalid')).rejects.toThrow();
    });
  });

  // =====================================================================
  // Tenant isolation — the core security guarantee (threat model §5.1).
  // Prove that storage SCOPES every read/write by tenant_id so a bug
  // in an upstream caller cannot leak data across tenants.
  // =====================================================================
  describe('tenant isolation', () => {
    const TENANT_A = asTenantId('tenant-a');
    const TENANT_B = asTenantId('tenant-b');

    it('tenant A writes are not visible to tenant B reads', async () => {
      await adapter.insertTrace(TENANT_A, { ...sampleTrace, trace_id: 'a-trace' });
      const b = await adapter.getTrace(TENANT_B, 'a-trace');
      expect(b).toBeNull();
    });

    it('queryTraces scopes to the requesting tenant', async () => {
      await adapter.insertTrace(TENANT_A, { ...sampleTrace, trace_id: 'a1' });
      await adapter.insertTrace(TENANT_B, { ...sampleTrace, trace_id: 'b1' });
      const a = await adapter.queryTraces(TENANT_A, {});
      const b = await adapter.queryTraces(TENANT_B, {});
      expect(a.traces.map((t) => t.trace_id)).toEqual(['a1']);
      expect(b.traces.map((t) => t.trace_id)).toEqual(['b1']);
    });

    it('getSpansByTraceId scopes to tenant', async () => {
      await adapter.insertTrace(TENANT_A, { ...sampleTrace, trace_id: 'a1' });
      await adapter.insertSpan(TENANT_A, {
        span_id: 'a-span',
        trace_id: 'a1',
        name: 'a',
        kind: 'INTERNAL',
        status_code: 'OK',
        start_time: '2026-01-15T10:30:00.000Z',
      });
      // Same trace_id under a different tenant must not see tenant A's span.
      const spansB = await adapter.getSpansByTraceId(TENANT_B, 'a1');
      expect(spansB).toEqual([]);
    });

    it('deleteTracesOlderThan scopes to tenant', async () => {
      await adapter.insertTrace(TENANT_A, {
        ...sampleTrace,
        trace_id: 'a-old',
        timestamp: '2020-01-01T00:00:00.000Z',
      });
      await adapter.insertTrace(TENANT_B, {
        ...sampleTrace,
        trace_id: 'b-old',
        timestamp: '2020-01-01T00:00:00.000Z',
      });
      const deletedA = await adapter.deleteTracesOlderThan(TENANT_A, 1);
      expect(deletedA).toBe(1);
      // B's old trace survived — tenants delete only their own data.
      const bRemaining = await adapter.queryTraces(TENANT_B, {});
      expect(bRemaining.total).toBe(1);
    });

    it('getDashboardSummary aggregates per tenant', async () => {
      await adapter.insertTrace(TENANT_A, { ...sampleTrace, trace_id: 'a1' });
      await adapter.insertTrace(TENANT_A, { ...sampleTrace, trace_id: 'a2' });
      await adapter.insertTrace(TENANT_B, { ...sampleTrace, trace_id: 'b1' });
      const sumA = await adapter.getDashboardSummary(TENANT_A, 24 * 365 * 10);
      const sumB = await adapter.getDashboardSummary(TENANT_B, 24 * 365 * 10);
      expect(sumA.total_traces).toBe(2);
      expect(sumB.total_traces).toBe(1);
    });

    it('refuses to query with an empty tenant (defense-in-depth)', async () => {
      // Bypass the type system via cast to simulate a bug upstream.
      const bad = '' as unknown as Parameters<typeof adapter.getTrace>[0];
      await expect(adapter.getTrace(bad, 'any')).rejects.toThrow(/TenantId/);
    });
  });
});
