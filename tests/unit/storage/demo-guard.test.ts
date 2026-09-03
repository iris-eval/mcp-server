import { describe, it, expect } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import {
  withDemoIngestGuard,
  DemoIngestRefusedError,
  DEMO_INGEST_REFUSED_MESSAGE,
} from '../../../src/storage/demo-guard.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { generateEvalId } from '../../../src/utils/ids.js';

/*
 * The demo store refuses ingest and delegates everything else. The
 * end-to-end HTTP behaviour (POST /api/v1/traces → 403 under --demo) is in
 * tests/integration/demo-mode.test.ts; this pins the wrapper's contract so
 * a method added to IStorageAdapter later cannot bypass it by accident.
 */
describe('withDemoIngestGuard', () => {
  it('refuses trace, span and eval writes with a 403-carrying error that says where real traces go', async () => {
    const real = new SqliteAdapter(':memory:');
    await real.initialize();
    const guarded = withDemoIngestGuard(real);
    try {
      await expect(
        guarded.insertTrace(LOCAL_TENANT, { trace_id: 't', agent_name: 'a', timestamp: new Date().toISOString() }),
      ).rejects.toBeInstanceOf(DemoIngestRefusedError);
      await expect(
        guarded.insertSpan(LOCAL_TENANT, { span_id: 's', trace_id: 't', name: 'n', kind: 'LLM', status_code: 'OK', start_time: new Date().toISOString() }),
      ).rejects.toBeInstanceOf(DemoIngestRefusedError);
      await expect(
        guarded.insertEvalResult(LOCAL_TENANT, {
          id: generateEvalId(), eval_type: 'safety', output_text: 'x', score: 1, passed: true, rule_results: [], suggestions: [],
        }),
      ).rejects.toBeInstanceOf(DemoIngestRefusedError);

      const err = new DemoIngestRefusedError();
      expect(err.status).toBe(403);
      expect(err.message).toBe(DEMO_INGEST_REFUSED_MESSAGE);
      expect(err.message).toContain('--demo-clear');
      expect(err.message).toContain('iris-mcp --dashboard');

      // Nothing landed.
      expect((await guarded.queryTraces(LOCAL_TENANT, {})).total).toBe(0);
    } finally {
      await guarded.close();
    }
  });

  it('delegates reads (and every other method) to the real adapter with `this` intact', async () => {
    const real = new SqliteAdapter(':memory:');
    await real.initialize();
    // Seed THROUGH the real adapter, as demo seeding does.
    await real.insertTrace(LOCAL_TENANT, { trace_id: 'seeded', agent_name: 'demo', timestamp: new Date().toISOString() });
    const guarded = withDemoIngestGuard(real);
    try {
      expect((await guarded.queryTraces(LOCAL_TENANT, {})).total).toBe(1);
      expect((await guarded.getTrace(LOCAL_TENANT, 'seeded'))?.agent_name).toBe('demo');
      expect((await guarded.getEvalStats(LOCAL_TENANT, '24h')).totalEvals).toBe(0);
      expect(await guarded.deleteTrace(LOCAL_TENANT, 'seeded')).toBe(true);
    } finally {
      await guarded.close();
    }
  });
});
