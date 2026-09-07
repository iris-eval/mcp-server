/*
 * Migration 009 — runs and case keys, added without disturbing a database
 * written by an earlier release (acceptance row C9).
 *
 * The whole migration is additive on purpose. Every trace already in every
 * user's store predates it and belongs to no run, and a NOT NULL column
 * would have to either refuse those rows or invent a grouping for them. An
 * invented run is worse than none: it would let a comparison report a
 * difference between two things that were never a batch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { deriveCaseKey, normaliseForCaseKey, resolveCaseKey } from '../../../src/eval/case-key.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig009-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

describe('migration 009 — the schema it adds', () => {
  it('creates the runs table and the three columns a comparison needs', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();

    const db = new Database(path, { readonly: true });
    const cols = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('traces')).toEqual(expect.arrayContaining(['run_id', 'case_key']));
    expect(cols('eval_results')).toEqual(expect.arrayContaining(['run_id']));
    expect(cols('runs')).toEqual(
      expect.arrayContaining(['run_id', 'tenant_id', 'label', 'agent_name', 'engine_version', 'ruleset_hash', 'config_hash', 'started_at', 'reevaluation_of']),
    );

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    // The two access paths a comparison takes: everything in a run, and
    // every occurrence of one case. Tenant-scoped first, like every query here.
    expect(indexes).toEqual(expect.arrayContaining(['idx_traces_tenant_case', 'idx_traces_tenant_run', 'idx_eval_results_tenant_run']));
    db.close();
  });

  it('leaves a trace written before the migration readable, with the new fields ABSENT rather than invented', async () => {
    const path = tempDb();
    const first = new SqliteAdapter(path);
    await first.initialize();
    await first.insertTrace(LOCAL_TENANT, {
      trace_id: 't-old',
      agent_name: 'legacy-agent',
      input: 'what changed in the release notes?',
      output: 'Streaming was added.',
      timestamp: new Date().toISOString(),
    });
    await first.close();

    // Re-open: migrations are idempotent and must not rewrite existing rows.
    const second = new SqliteAdapter(path);
    await second.initialize();
    const back = await second.getTrace(LOCAL_TENANT, 't-old');
    expect(back).not.toBeNull();
    expect(back!.output).toBe('Streaming was added.');
    // Never fabricated: a trace that predates runs belongs to no run.
    expect((back as unknown as { run_id?: string }).run_id ?? null).toBeNull();
    await second.close();
  });
});

describe('the case key — what makes two traces the same question asked twice', () => {
  it('derives the same key for the same question re-indented by a template', () => {
    const a = deriveCaseKey('Summarise   the release notes.');
    const b = deriveCaseKey('Summarise the release notes.');
    const c = deriveCaseKey('\n  Summarise the release notes.\n');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toHaveLength(16);
  });

  it('does NOT merge two different questions, however similar', () => {
    /*
     * The one temptation to refuse. Lowercasing or stripping punctuation
     * would pair more traces, and every extra pair would be a pair nobody
     * asked for — a case key is an IDENTITY, not a similarity score, and
     * quietly merging two prompts reports a difference between things that
     * were never compared.
     */
    expect(deriveCaseKey('Summarise the release notes.')).not.toBe(deriveCaseKey('summarise the release notes.'));
    expect(deriveCaseKey('Summarise the release notes.')).not.toBe(deriveCaseKey('Summarise the release notes'));
    expect(deriveCaseKey('List the tools.')).not.toBe(deriveCaseKey('List the rules.'));
  });

  it('has no key when there is no input to derive one from', () => {
    expect(deriveCaseKey(undefined)).toBeNull();
    expect(deriveCaseKey('')).toBeNull();
    expect(deriveCaseKey('   \n  ')).toBeNull();
    expect(normaliseForCaseKey('  a   b  ')).toBe('a b');
  });

  it('the CALLER\'S key always wins, because it knows something no hash can recover', () => {
    // A CI job naming its fixture can pair two runs that legitimately
    // reworded the prompt. The derived key exists so a caller who sends
    // nothing still gets pairing — not so it can overrule one who does.
    expect(resolveCaseKey('fixture-07', 'anything at all')).toBe('fixture-07');
    expect(resolveCaseKey('  fixture-07  ', 'x')).toBe('fixture-07');
    expect(resolveCaseKey(undefined, 'the question')).toBe(deriveCaseKey('the question'));
    expect(resolveCaseKey('   ', 'the question')).toBe(deriveCaseKey('the question'));
    expect(resolveCaseKey(undefined, undefined)).toBeNull();
  });

  it('caps a caller key so it cannot become a payload', () => {
    expect(resolveCaseKey('k'.repeat(500), 'x')).toHaveLength(200);
  });
});
