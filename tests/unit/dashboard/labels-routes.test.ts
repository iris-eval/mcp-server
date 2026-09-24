/*
 * The labels routes over a real store and a real engine:
 *
 *   POST /labels refuses a rule that did not fire and writes one label per
 *   (evaluation, rule); GET /labels lists them; GET /labels/stats carries
 *   the floor and the per-rule rows; GET /issues groups the fires;
 *   POST /evaluations/:id/reevaluate keeps the old row and names it — and
 *   after twenty labels calling the rule wrong, the re-score passes what
 *   the published number failed. The bold sentence, end to end.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { refreshLocalLabels } from '../../../src/eval/local-labels.js';
import { registerLabelRoutes } from '../../../src/dashboard/routes/labels.js';
import { createTenantMiddleware } from '../../../src/middleware/tenant.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const STUB = 'TODO: write the summary.';

const dirs: string[] = [];
const stores: SqliteAdapter[] = [];
afterEach(async () => {
  // Close every store first: an open SQLite file cannot be removed on Windows.
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  store: SqliteAdapter;
  engine: EvalEngine;
  app: express.Express;
  /** Store a trace with the stub output and evaluate it; returns the ids. */
  scoreOne(i: number): Promise<{ traceId: string; evalId: string; verdict: string | undefined }>;
}

async function harness(withEngine = true): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-labels-routes-'));
  dirs.push(dir);
  const store = new SqliteAdapter(join(dir, 'iris.db'));
  await store.initialize();
  stores.push(store);
  const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  await refreshLocalLabels(engine, store, LOCAL_TENANT);
  const app = express();
  app.use(express.json());
  app.use(createTenantMiddleware());
  const router = express.Router();
  registerLabelRoutes(router, store, withEngine ? { evalEngine: engine } : {});
  app.use('/api/v1', router);
  const scoreOne = async (i: number) => {
    const traceId = `trace-${i}`;
    await store.insertTrace(LOCAL_TENANT, { trace_id: traceId, agent_name: 'bot', input: 'Summarise the notes.', output: STUB, timestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() });
    const result = await engine.evaluateAll({ output: STUB, input: 'Summarise the notes.' });
    result.trace_id = traceId;
    await store.insertEvalResult(LOCAL_TENANT, result);
    return { traceId, evalId: result.id, verdict: result.verdict?.state };
  };
  return { store, engine, app, scoreOne };
}

async function call(app: express.Express, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('POST /labels and GET /labels', () => {
  it('refuses a label on a rule that did not fire, writes one on a fire, and a re-label replaces', async () => {
    const h = await harness();
    const { evalId } = await h.scoreOne(0);

    const quiet = await call(h.app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_pii', label: 'wrong' });
    expect(quiet.status).toBe(400);
    expect(String(quiet.body.error)).toContain('did not fire');

    const unknown = await call(h.app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_such_rule', label: 'wrong' });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error)).toContain('did not run');

    const missing = await call(h.app, 'POST', '/api/v1/labels', { eval_id: 'eval_nope', rule: 'no_stub_output', label: 'wrong' });
    expect(missing.status).toBe(404);

    const bad = await call(h.app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'maybe' });
    expect(bad.status).toBe(400);

    const ok = await call(h.app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'right', note: 'it really is a stub' });
    expect(ok.status).toBe(201);
    expect(ok.body.label).toMatchObject({ evalId, ruleName: 'no_stub_output', label: 'right', note: 'it really is a stub' });
    expect(ok.body.rule).toMatchObject({ rule: 'no_stub_output', kind: 'inference', entersRisk: true, n: 1, right: 1, wrong: 0, local: false });
    expect(ok.body.min).toBe(20);

    const again = await call(h.app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'wrong' });
    expect(again.status).toBe(201);
    expect(again.body.rule).toMatchObject({ n: 1, right: 0, wrong: 1 });

    const list = await call(h.app, 'GET', `/api/v1/labels?eval_id=${evalId}`);
    expect(list.status).toBe(200);
    expect(list.body.labels).toHaveLength(1);
    expect((list.body.labels as Array<{ label: string }>)[0].label).toBe('wrong');

    const noId = await call(h.app, 'GET', '/api/v1/labels');
    expect(noId.status).toBe(400);
    await h.store.close();
  });
});

describe('GET /labels/stats and GET /issues', () => {
  it('stats carry the floor, the window and a row per rule; issues group the fires by what the rule found', async () => {
    const h = await harness();
    const a = await h.scoreOne(0);
    const b = await h.scoreOne(1);
    await call(h.app, 'POST', '/api/v1/labels', { eval_id: a.evalId, rule: 'no_stub_output', label: 'wrong' });

    const stats = await call(h.app, 'GET', '/api/v1/labels/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.min).toBe(20);
    expect(stats.body.window).toBe(2000);
    const rows = stats.body.rules as Array<Record<string, unknown>>;
    const stub = rows.find((r) => r.rule === 'no_stub_output')!;
    expect(stub).toMatchObject({ n: 1, right: 0, wrong: 1, local: false, entersRisk: true, fireRate: 1 });
    expect(typeof stub.publishedPrecision).toBe('number');
    expect(rows.find((r) => r.rule === 'no_pii')).toMatchObject({ n: 0, fireRate: 0 });
    expect(stats.body.estimatedPrior).toBeNull();
    // The suggestion names a rule whose labels can move a verdict — never a measurement's.
    const suggestion = stats.body.suggestion as { ruleName: string; n: number; sentence: string };
    expect(rows.find((r) => r.rule === suggestion.ruleName)).toMatchObject({ entersRisk: true });
    expect(suggestion.sentence).toContain(`label a ${suggestion.ruleName} fire next`);

    const issues = await call(h.app, 'GET', '/api/v1/issues');
    expect(issues.status).toBe(200);
    const groups = issues.body.issues as Array<Record<string, unknown>>;
    const stubIssue = groups.find((g) => g.ruleName === 'no_stub_output')!;
    expect(stubIssue).toMatchObject({ count: 2, agents: ['bot'], labelled: { right: 0, wrong: 1 } });
    expect(stubIssue.exampleEvalIds).toEqual([b.evalId, a.evalId]);
    expect(stubIssue.exampleTraceIds).toEqual([b.traceId, a.traceId]);

    const narrowed = await call(h.app, 'GET', '/api/v1/issues?rule=no_pii');
    expect(narrowed.body.issues).toEqual([]);
    expect((await call(h.app, 'GET', '/api/v1/issues?limit=0')).status).toBe(400);
    await h.store.close();
  });
});

describe('POST /evaluations/:id/reevaluate', () => {
  it('keeps the earlier row, names it, and after twenty labels calling the rule wrong the re-score passes what the published number failed', async () => {
    const h = await harness();
    const scored: Array<{ traceId: string; evalId: string; verdict: string | undefined }> = [];
    for (let i = 0; i < 20; i++) scored.push(await h.scoreOne(i));
    expect(scored.every((s) => s.verdict === 'fail')).toBe(true);

    // Nineteen labels: still the published number, still a fail.
    for (let i = 0; i < 19; i++) {
      const r = await call(h.app, 'POST', '/api/v1/labels', { eval_id: scored[i].evalId, rule: 'no_stub_output', label: i < 2 ? 'right' : 'wrong' });
      expect(r.status).toBe(201);
    }
    const still = await call(h.app, 'POST', `/api/v1/evaluations/${scored[19].evalId}/reevaluate`);
    expect(still.status).toBe(201);
    expect(still.body.before).toMatchObject({ verdict: 'fail', passed: false });
    expect(still.body.after).toMatchObject({ verdict: 'fail', passed: false });
    expect(still.body.changed).toBe(false);

    // The twentieth label: the rule's number on this deployment is its own.
    const twentieth = await call(h.app, 'POST', '/api/v1/labels', { eval_id: scored[19].evalId, rule: 'no_stub_output', label: 'wrong' });
    expect(twentieth.status).toBe(201);
    expect(twentieth.body.rule).toMatchObject({ n: 20, right: 2, wrong: 18, local: true });
    expect(twentieth.body.estimatedPrior).not.toBeNull();

    const moved = await call(h.app, 'POST', `/api/v1/evaluations/${scored[19].evalId}/reevaluate`);
    expect(moved.status).toBe(201);
    expect(moved.body.supersedes).toBe(scored[19].evalId);
    expect(moved.body.before).toMatchObject({ verdict: 'fail' });
    expect(moved.body.after).toMatchObject({ verdict: 'pass', passed: true });
    expect(moved.body.changed).toBe(true);
    const evaluation = moved.body.evaluation as { id: string; provenance: { supersedes: string; composer: { priorSource: string } }; rule_results: Array<{ ruleName: string; uncertainty?: { basis: string; n?: number } }> };
    expect(evaluation.id).not.toBe(scored[19].evalId);
    expect(evaluation.provenance.supersedes).toBe(scored[19].evalId);
    expect(evaluation.provenance.composer.priorSource).toBe('estimated');
    expect(evaluation.rule_results.find((r) => r.ruleName === 'no_stub_output')!.uncertainty).toMatchObject({ basis: 'local_labels', n: 20 });

    // Both rows stand on the trace; the newest is the re-score.
    const rows = await h.store.getEvalsByTraceId(LOCAL_TENANT, scored[19].traceId);
    expect(rows.map((r) => r.id)).toContain(scored[19].evalId);
    expect(rows.map((r) => r.id)).toContain(evaluation.id);
    expect(rows.find((r) => r.id === evaluation.id)!.verdict?.state).toBe('pass');
    expect(rows.find((r) => r.id === scored[19].evalId)!.verdict?.state).toBe('fail');
    await h.store.close();
  }, 120_000);

  it('refuses an evaluation with no stored trace, an unknown id, and a dashboard started without the engine', async () => {
    const h = await harness();
    const bare = await h.engine.evaluateAll({ output: STUB });
    await h.store.insertEvalResult(LOCAL_TENANT, bare);
    const unlinked = await call(h.app, 'POST', `/api/v1/evaluations/${bare.id}/reevaluate`);
    expect(unlinked.status).toBe(409);
    expect(String(unlinked.body.error)).toContain('not linked');
    expect((await call(h.app, 'POST', '/api/v1/evaluations/eval_nope/reevaluate')).status).toBe(404);
    await h.store.close();

    const noEngine = await harness(false);
    const { evalId } = await noEngine.scoreOne(0);
    const refused = await call(noEngine.app, 'POST', `/api/v1/evaluations/${evalId}/reevaluate`);
    expect(refused.status).toBe(503);
    // Labels still work without the engine: the source is rebuilt from storage.
    expect((await call(noEngine.app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'right' })).status).toBe(201);
    expect((await call(noEngine.app, 'GET', '/api/v1/labels/stats')).status).toBe(200);
    await noEngine.store.close();
  });
});
