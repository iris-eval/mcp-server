/*
 * Migration 011 — verdict labels (arc 7, D-8), added without disturbing a
 * database written by an earlier release, and the five storage methods the
 * labels surface reads: one label per (evaluation, rule) with a re-label
 * replacing, tallies per rule, fire rates over a window, and fires grouped
 * by (rule, evidence signature) into issues. Tenant-scoped like everything.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import type { EvalResult } from '../../../src/types/eval.js';
import { issueKey } from '../../../src/eval/labels.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig011-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

function evaluation(id: string, traceId: string | undefined, rows: Array<{ ruleName: string; passed: boolean; skipped?: boolean; evidence?: unknown[]; message?: string }>, createdAt: string): EvalResult {
  return {
    id,
    ...(traceId ? { trace_id: traceId } : {}),
    eval_type: 'all',
    output_text: 'TODO: write it',
    score: 0.5,
    passed: rows.every((r) => r.passed || r.skipped),
    rule_results: rows.map((r) => ({ ruleName: r.ruleName, passed: r.passed, score: r.passed ? 1 : 0, message: r.message ?? 'm', ...(r.skipped ? { skipped: true } : {}), ...(r.evidence ? { evidence: r.evidence } : {}) })) as EvalResult['rule_results'],
    created_at: createdAt,
  };
}

describe('migration 011 — the schema it adds', () => {
  it('creates verdict_labels with its two tenant-first indexes, and an older database opens unchanged', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();

    const db = new Database(path, { readonly: true });
    const cols = (db.prepare('PRAGMA table_info(verdict_labels)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'tenant_id', 'eval_id', 'rule_name', 'label', 'note', 'labelled_at']);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_verdict_labels_tenant_rule', 'idx_verdict_labels_tenant_eval']));
    expect((db.prepare("SELECT id FROM _iris_migrations WHERE id = '011-verdict-labels'").get() as { id: string } | undefined)?.id).toBe('011-verdict-labels');
    db.close();

    // Re-open: idempotent.
    const again = new SqliteAdapter(path);
    await again.initialize();
    expect(await again.labelTallies(LOCAL_TENANT)).toEqual([]);
    await again.close();
  });

  it('refuses a label that is neither right nor wrong at the schema', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await expect(store.insertVerdictLabel(LOCAL_TENANT, { id: 'l1', evalId: 'e1', ruleName: 'no_pii', label: 'maybe' as never, note: null })).rejects.toThrow(/CHECK constraint/);
    await store.close();
  });
});

describe('the label store', () => {
  it('one label per (evaluation, rule): a re-label replaces, and the tallies count the current opinion once', async () => {
    const store = new SqliteAdapter(tempDb());
    await store.initialize();
    const first = await store.insertVerdictLabel(LOCAL_TENANT, { id: 'l1', evalId: 'e1', ruleName: 'no_stub_output', label: 'right', note: null });
    expect(first.labelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await store.insertVerdictLabel(LOCAL_TENANT, { id: 'l2', evalId: 'e1', ruleName: 'no_stub_output', label: 'wrong', note: 'a diff, not a stub' });
    await store.insertVerdictLabel(LOCAL_TENANT, { id: 'l3', evalId: 'e1', ruleName: 'no_pii', label: 'right', note: null });
    await store.insertVerdictLabel(LOCAL_TENANT, { id: 'l4', evalId: 'e2', ruleName: 'no_stub_output', label: 'right', note: null });

    const onE1 = await store.getLabelsForEval(LOCAL_TENANT, 'e1');
    expect(onE1.map((l) => [l.ruleName, l.label, l.note])).toEqual(expect.arrayContaining([
      ['no_stub_output', 'wrong', 'a diff, not a stub'],
      ['no_pii', 'right', null],
    ]));
    expect(onE1).toHaveLength(2);
    expect(await store.labelTallies(LOCAL_TENANT)).toEqual([
      { ruleName: 'no_pii', right: 1, wrong: 0 },
      { ruleName: 'no_stub_output', right: 1, wrong: 1 },
    ]);
    await store.close();
  });

  it('never returns another tenant’s labels', async () => {
    const store = new SqliteAdapter(tempDb());
    await store.initialize();
    await store.insertVerdictLabel(LOCAL_TENANT, { id: 'l1', evalId: 'e1', ruleName: 'no_pii', label: 'right', note: null });
    const other = asTenantId('someone-else');
    expect(await store.getLabelsForEval(other, 'e1')).toEqual([]);
    expect(await store.labelTallies(other)).toEqual([]);
    expect(await store.listIssues(other, 100)).toEqual([]);
    await store.close();
  });
});

describe('fire rates and issues over the recent window', () => {
  async function seeded(): Promise<SqliteAdapter> {
    const store = new SqliteAdapter(tempDb());
    await store.initialize();
    const t0 = Date.UTC(2026, 8, 1);
    for (let i = 0; i < 6; i++) {
      const traceId = `t${i}`;
      await store.insertTrace(LOCAL_TENANT, { trace_id: traceId, agent_name: i % 2 === 0 ? 'alpha' : 'beta', input: 'q', output: 'TODO', timestamp: new Date(t0 + i * 60_000).toISOString() });
      await store.insertEvalResult(
        LOCAL_TENANT,
        evaluation(
          `e${i}`,
          traceId,
          [
            // no_stub_output fires on the first five with one pattern, the sixth with another.
            { ruleName: 'no_stub_output', passed: false, evidence: [{ type: 'pattern', name: i < 5 ? 'marker TODO' : 'marker FIXME', count: 1 }] },
            // no_pii runs and stays quiet on every one.
            { ruleName: 'no_pii', passed: true },
            // cost_under_threshold skips on every one: not an observation.
            { ruleName: 'cost_under_threshold', passed: false, skipped: true },
          ],
          new Date(t0 + i * 60_000).toISOString(),
        ),
      );
    }
    await store.insertVerdictLabel(LOCAL_TENANT, { id: 'l1', evalId: 'e0', ruleName: 'no_stub_output', label: 'wrong', note: null });
    await store.insertVerdictLabel(LOCAL_TENANT, { id: 'l2', evalId: 'e1', ruleName: 'no_stub_output', label: 'right', note: null });
    return store;
  }

  it('counts fires over evaluations the rule RAN on; a skip is not an observation', async () => {
    const store = await seeded();
    expect(await store.ruleFireStats(LOCAL_TENANT, 100)).toEqual([
      { ruleName: 'no_pii', judged: 6, fired: 0 },
      { ruleName: 'no_stub_output', judged: 6, fired: 6 },
    ]);
    // The window is the newest N evaluations.
    expect(await store.ruleFireStats(LOCAL_TENANT, 2)).toEqual([
      { ruleName: 'no_pii', judged: 2, fired: 0 },
      { ruleName: 'no_stub_output', judged: 2, fired: 2 },
    ]);
    await store.close();
  });

  it('groups fires by (rule, evidence signature): five TODO fires are one issue with a count, one FIXME fire is another', async () => {
    const store = await seeded();
    const issues = await store.listIssues(LOCAL_TENANT, 100);
    expect(issues).toHaveLength(2);
    const [todo, fixme] = issues;
    expect(todo.key).toBe(issueKey('no_stub_output', 'pattern:marker TODO'));
    expect(todo.ruleName).toBe('no_stub_output');
    expect(todo.signature).toBe('pattern:marker TODO');
    expect(todo.count).toBe(5);
    expect(todo.agents.sort()).toEqual(['alpha', 'beta']);
    expect(todo.firstSeen < todo.lastSeen).toBe(true);
    expect(todo.exampleEvalIds).toEqual(['e4', 'e3', 'e2', 'e1', 'e0']);
    expect(todo.exampleTraceIds).toEqual(['t4', 't3', 't2', 't1', 't0']);
    expect(todo.labelled).toEqual({ right: 1, wrong: 1 });
    expect(fixme.signature).toBe('pattern:marker FIXME');
    expect(fixme.count).toBe(1);
    expect(fixme.labelled).toEqual({ right: 0, wrong: 0 });

    expect(await store.listIssues(LOCAL_TENANT, 100, { rule: 'no_pii' })).toEqual([]);
    expect(await store.listIssues(LOCAL_TENANT, 100, { limit: 1 })).toHaveLength(1);
    await store.close();
  });
});
