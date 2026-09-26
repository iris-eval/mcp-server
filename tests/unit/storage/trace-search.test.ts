/*
 * Full-text search over traces (#7), through the adapter.
 *
 * What a search finds (input, output, tool-call values, metadata values —
 * never JSON keys), how it ranks and combines with the other filters, and
 * that the index stays in step with the traces table through every route a
 * trace changes or leaves by: insert, the metadata patch, delete_trace, the
 * retention sweep, --purge (which VACUUMs, and VACUUM may renumber the
 * traces table's rowids), and a DELETE nobody wrote an index update for.
 * After each, FTS5's own integrity-check must pass and the search must
 * answer exactly what a read of the table would.
 *
 * Then the two SQLite-without-FTS5 cases: a database first opened on such a
 * build (no index; search reads the traces; the index is built on the first
 * start that has FTS5), and a database with an index opened on such a build
 * (its triggers are dropped so writes keep working; the index is rebuilt on
 * the next start that can). And erasure: a deleted trace's words are not
 * left in the file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import type { Driver } from '../../../src/storage/driver.js';
import type { Trace } from '../../../src/types/trace.js';

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-search-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

async function adapter(path = ':memory:', options: { fts5?: boolean } = {}): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(path, options);
  await s.initialize();
  open.push(s);
  return s;
}

const dbOf = (s: SqliteAdapter) => (s as unknown as { db: Driver }).db;

/** FTS5's own consistency check of the index, and the id table against the traces (equal unless the test says otherwise). */
function assertIndexHealthy(s: SqliteAdapter, expected?: { docs: number; traces: number }): void {
  const db = dbOf(s);
  db.exec("INSERT INTO trace_search (trace_search, rank) VALUES ('integrity-check', 0)");
  const row = db.prepare('SELECT (SELECT COUNT(*) FROM traces) AS traces, (SELECT COUNT(*) FROM trace_search_docs) AS docs').get() as { traces: number; docs: number };
  if (expected) expect({ docs: Number(row.docs), traces: Number(row.traces) }).toEqual(expected);
  else expect(Number(row.docs)).toBe(Number(row.traces));
}

const ids = async (s: SqliteAdapter, search: string, tenant = LOCAL_TENANT) =>
  (await s.queryTraces(tenant, { search, sort_by: 'timestamp', sort_order: 'asc', limit: 1000 })).traces.map((t) => t.trace_id);

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString();

const refundTrace: Trace = {
  trace_id: 'refund',
  agent_name: 'support-bot',
  framework: 'langchain',
  input: 'Was my refund for order A-1009 approved?',
  output: 'Yes — the refund of $42.10 was approved on Monday and will reach your card in 3 days.',
  tool_calls: [{ tool_name: 'lookup_order', input: { order_id: 'A-1009' }, output: { status: 'refund_approved', carrier: 'Deutsche Post' } }],
  metadata: { customer_tier: 'platinum', region: 'eu-west' },
  timestamp: at(1),
};
const weatherTrace: Trace = {
  trace_id: 'weather',
  agent_name: 'travel-bot',
  input: 'What is the weather in Zürich?',
  output: 'It is 21°C and sunny in Zürich. The café by the lake is open.',
  timestamp: at(2),
};
const noisyTrace: Trace = {
  trace_id: 'noisy',
  agent_name: 'support-bot',
  input: 'refund refund refund',
  output: 'I cannot process a refund, refund requests go to billing. Refund policy attached.',
  timestamp: at(3),
};

describe('trace search — what it finds', () => {
  it('finds a trace by a word in its input, its output, a tool-call value or a metadata value', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace]);
    expect(await ids(s, 'approved')).toEqual(['refund']);
    expect(await ids(s, 'Zürich')).toEqual(['weather']);
    expect(await ids(s, 'deutsche post')).toEqual(['refund']);
    expect(await ids(s, 'platinum')).toEqual(['refund']);
    expect(await ids(s, 'eu-west')).toEqual(['refund']);
    expect(await ids(s, 'lookup_order')).toEqual(['refund']);
  });

  it('does not match the keys of tool calls or metadata, only their values', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace]);
    for (const key of ['tool_name', 'order_id', 'customer_tier', 'carrier', 'status']) expect(await ids(s, key), key).toEqual([]);
  });

  it('ignores case and accents, needs every word, reads a quoted phrase in order and a trailing * as a prefix', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace, noisyTrace]);
    expect(await ids(s, 'CAFE zurich')).toEqual(['weather']);
    expect(await ids(s, 'refund billing')).toEqual(['noisy']);
    expect(await ids(s, '"refund of"')).toEqual(['refund']);
    expect(await ids(s, '"of refund"')).toEqual([]);
    expect(await ids(s, 'appro*')).toEqual(['refund']);
    expect(await ids(s, 'sun*')).toEqual(['weather']);
  });

  it('ranks by relevance by default with a search, best first, and honours an explicit sort', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace, noisyTrace]);
    const ranked = await s.queryTraces(LOCAL_TENANT, { search: 'refund' });
    expect(ranked.traces.map((t) => t.trace_id)).toEqual(['noisy', 'refund']);
    expect(ranked.total).toBe(2);
    expect(ranked.search).toEqual({ terms: ['refund'], index: 'fts5' });
    const worstFirst = await s.queryTraces(LOCAL_TENANT, { search: 'refund', sort_order: 'asc' });
    expect(worstFirst.traces.map((t) => t.trace_id)).toEqual(['refund', 'noisy']);
    const newest = await s.queryTraces(LOCAL_TENANT, { search: 'refund', sort_by: 'timestamp' });
    expect(newest.traces.map((t) => t.trace_id)).toEqual(['noisy', 'refund']);
    const oldest = await s.queryTraces(LOCAL_TENANT, { search: 'refund', sort_by: 'timestamp', sort_order: 'asc' });
    expect(oldest.traces.map((t) => t.trace_id)).toEqual(['refund', 'noisy']);
  });

  it('applies every other filter to the matches, and pages them with the total across pages', async () => {
    const s = await adapter();
    const many: Trace[] = Array.from({ length: 30 }, (_, i) => ({
      trace_id: `m-${String(i).padStart(2, '0')}`,
      agent_name: i % 3 === 0 ? 'triage' : 'other',
      framework: i % 2 === 0 ? 'autogen' : 'crewai',
      output: `ticket ${i} escalated to tier two`,
      timestamp: at(10 + i),
    }));
    await s.insertTraces(LOCAL_TENANT, [...many, refundTrace]);
    const filtered = await s.queryTraces(LOCAL_TENANT, { search: 'escalated', filter: { agent_name: 'triage', framework: 'autogen' } });
    expect(filtered.total).toBe(5);
    expect(filtered.traces.every((t) => t.agent_name === 'triage' && t.framework === 'autogen')).toBe(true);
    const window = await s.queryTraces(LOCAL_TENANT, { search: 'escalated', filter: { since: at(20), until: at(24) } });
    expect(window.total).toBe(5);
    const page1 = await s.queryTraces(LOCAL_TENANT, { search: 'escalated', limit: 10, offset: 0, sort_by: 'timestamp' });
    const page3 = await s.queryTraces(LOCAL_TENANT, { search: 'escalated', limit: 10, offset: 20, sort_by: 'timestamp' });
    expect(page1.total).toBe(30);
    expect(page1.traces).toHaveLength(10);
    expect(page3.traces.map((t) => t.trace_id)).toEqual(many.slice(0, 10).map((t) => t.trace_id).reverse());
  });

  it('applies the score filter to the latest evaluation of each matched trace', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, noisyTrace]);
    await s.insertEvalResult(LOCAL_TENANT, { id: 'e1', trace_id: 'refund', eval_type: 'all', output_text: 'x', score: 0.9, passed: true, rule_results: [] });
    await s.insertEvalResult(LOCAL_TENANT, { id: 'e2', trace_id: 'noisy', eval_type: 'all', output_text: 'x', score: 0.2, passed: false, rule_results: [] });
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'refund', filter: { max_score: 0.5 } })).traces.map((t) => t.trace_id)).toEqual(['noisy']);
  });

  it('never returns another tenant’s trace, on either path', async () => {
    for (const fts5 of [true, false]) {
      const s = await adapter(':memory:', { fts5 });
      const other = asTenantId('acme');
      await s.insertTraces(LOCAL_TENANT, [refundTrace]);
      await s.insertTraces(other, [{ ...refundTrace, trace_id: 'acme-refund' }]);
      expect(await ids(s, 'refund')).toEqual(['refund']);
      expect(await ids(s, 'refund', other)).toEqual(['acme-refund']);
      expect((await s.queryTraces(other, { search: 'refund' })).total).toBe(1);
    }
  });

  it('puts a match on each result: the field, a snippet, and the snippet as fragments', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace]);
    const [hit] = (await s.queryTraces(LOCAL_TENANT, { search: 'refund approved' })).traces;
    expect(hit.match).toEqual({
      field: 'output',
      snippet: 'Yes — the refund of $42.10 was approved on Monday and will reach your card in 3 days.',
      fragments: [
        { text: 'Yes — the ', hit: false },
        { text: 'refund', hit: true },
        { text: ' of $42.10 was ', hit: false },
        { text: 'approved', hit: true },
        { text: ' on Monday and will reach your card in 3 days.', hit: false },
      ],
    });
    const [tool] = (await s.queryTraces(LOCAL_TENANT, { search: 'deutsche' })).traces;
    expect(tool.match?.field).toBe('tool_calls');
    expect(tool.match?.snippet).toBe('…1009 · refund_approved · Deutsche Post');
    // The trace itself is returned whole, as without a search.
    expect(tool.tool_calls).toEqual(refundTrace.tool_calls);
    expect(tool.metadata).toEqual(refundTrace.metadata);
  });

  it('refuses relevance without a search, and treats blank search text as no search', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace]);
    await expect(s.queryTraces(LOCAL_TENANT, { sort_by: 'relevance' })).rejects.toThrow(/relevance ranks a search/);
    const blank = await s.queryTraces(LOCAL_TENANT, { search: '   ' });
    expect(blank.total).toBe(2);
    expect(blank.search).toBeUndefined();
    expect(blank.traces.every((t) => !('match' in t))).toBe(true);
  });
});

describe('trace search — the index stays in step', () => {
  it('indexes on insert, re-indexes on the metadata patch, and forgets on delete_trace', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace]);
    assertIndexHealthy(s);
    expect(await s.updateTraceMetadata(LOCAL_TENANT, 'weather', { reviewer: 'Grace Hopper' })).toBe(true);
    expect(await ids(s, 'hopper')).toEqual(['weather']);
    expect(await ids(s, 'zurich')).toEqual(['weather']);
    assertIndexHealthy(s);
    expect(await s.deleteTrace(LOCAL_TENANT, 'weather')).toBe(true);
    expect(await ids(s, 'hopper')).toEqual([]);
    expect(await ids(s, 'zurich')).toEqual([]);
    assertIndexHealthy(s);
  });

  it('forgets what the retention sweep removes, and keeps the rest', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [{ ...refundTrace, timestamp: '2020-01-01T00:00:00.000Z' }, { ...noisyTrace, timestamp: new Date().toISOString() }]);
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(1);
    expect(await ids(s, 'refund')).toEqual(['noisy']);
    expect(await ids(s, 'platinum')).toEqual([]);
    assertIndexHealthy(s);
  });

  it('survives --purge of one tenant, and its VACUUM, with the other tenant’s traces still found', async () => {
    const path = tempDb();
    const s = await adapter(path);
    const other = asTenantId('acme');
    // Interleaved, so the purged tenant's rows sit between the kept tenant's.
    for (let i = 0; i < 40; i += 1) {
      await s.insertTrace(i % 2 ? other : LOCAL_TENANT, { trace_id: `p-${i}`, agent_name: 'a', output: `word${i} shared`, timestamp: at(i) });
    }
    await s.purge(LOCAL_TENANT);
    assertIndexHealthy(s);
    for (let i = 1; i < 40; i += 2) expect(await ids(s, `word${i}`, other)).toEqual([`p-${i}`]);
    expect(await ids(s, 'word2', other)).toEqual([]);
    expect(await ids(s, 'shared', other)).toHaveLength(20);
    expect(await ids(s, 'shared')).toEqual([]);
  });

  it('does not depend on the traces table’s rowids, which VACUUM is allowed to renumber (traces has a TEXT primary key)', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace, noisyTrace]);
    // What a renumbering VACUUM would do, done directly: every rowid moves, no indexed column changes.
    dbOf(s).exec('UPDATE traces SET rowid = rowid + 1000');
    expect(await ids(s, 'zurich')).toEqual(['weather']);
    expect(await ids(s, 'billing')).toEqual(['noisy']);
    expect(await s.deleteTrace(LOCAL_TENANT, 'noisy')).toBe(true);
    expect(await ids(s, 'refund')).toEqual(['refund']);
    assertIndexHealthy(s);
  });

  it('follows a DELETE and an UPDATE that no adapter method made — the triggers, not the call sites, keep it', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace]);
    dbOf(s).prepare("UPDATE traces SET output = 'rewritten by hand: cloudy' WHERE trace_id = 'weather'").run();
    expect(await ids(s, 'cloudy')).toEqual(['weather']);
    expect(await ids(s, 'sunny')).toEqual([]);
    dbOf(s).prepare("DELETE FROM traces WHERE trace_id = 'refund'").run();
    expect(await ids(s, 'approved')).toEqual([]);
    assertIndexHealthy(s);
  });

  it('a trace inserted by something other than the adapter is indexed at the next start, and deleting it first leaves the index whole', async () => {
    const path = tempDb();
    const s = await adapter(path);
    await s.insertTraces(LOCAL_TENANT, [refundTrace]);
    const insertByHand = (id: string, output: string) =>
      dbOf(s).prepare("INSERT INTO traces (tenant_id, trace_id, agent_name, output, timestamp) VALUES ('local', ?, 'hand', ?, ?)").run(id, output, at(9));
    insertByHand('by-hand', 'inserted by an operator with sqlite3');
    insertByHand('by-hand-gone', 'inserted and then deleted by an operator');
    expect(await ids(s, 'operator')).toEqual([]);
    dbOf(s).prepare("DELETE FROM traces WHERE trace_id = 'by-hand-gone'").run();
    assertIndexHealthy(s, { docs: 1, traces: 2 });
    await s.close();
    open.splice(open.indexOf(s), 1);

    const next = await adapter(path);
    assertIndexHealthy(next);
    expect(await ids(next, 'operator')).toEqual(['by-hand']);
    expect(await ids(next, 'approved')).toEqual(['refund']);
  });

  it('pages past the last match with the total still counted', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace, noisyTrace]);
    const past = await s.queryTraces(LOCAL_TENANT, { search: 'refund', offset: 10 });
    expect(past).toMatchObject({ traces: [], total: 2, offset: 10 });
    const pastFiltered = await s.queryTraces(LOCAL_TENANT, { search: 'refund', offset: 10, filter: { agent_name: 'support-bot' } });
    expect(pastFiltered).toMatchObject({ traces: [], total: 2 });
  });

  it('rolls back with the insert it belongs to', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [refundTrace]);
    // The second trace reuses a trace_id, so the batch fails as a whole.
    await expect(s.insertTraces(LOCAL_TENANT, [weatherTrace, { ...weatherTrace, output: 'duplicate' }])).rejects.toThrow();
    expect(await ids(s, 'zurich')).toEqual([]);
    assertIndexHealthy(s);
  });
});

describe('trace search — a SQLite without FTS5', () => {
  it('a database first opened without FTS5 has no index, searches by reading the traces, and is indexed on the first start with FTS5', async () => {
    const path = tempDb();
    const bare = await adapter(path, { fts5: false });
    const tables = (dbOf(bare).prepare("SELECT name FROM sqlite_master WHERE name LIKE 'trace_search%'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual([]);
    await bare.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace, noisyTrace]);
    const scanned = await bare.queryTraces(LOCAL_TENANT, { search: 'refund' });
    expect(scanned.search).toEqual({ terms: ['refund'], index: 'scan' });
    expect(scanned.traces.map((t) => t.trace_id)).toEqual(['noisy', 'refund']);
    expect(scanned.traces[0].match?.fragments.some((f) => f.hit)).toBe(true);
    await bare.close();
    open.splice(open.indexOf(bare), 1);

    const full = await adapter(path);
    assertIndexHealthy(full);
    const indexed = await full.queryTraces(LOCAL_TENANT, { search: 'refund' });
    expect(indexed.search?.index).toBe('fts5');
    expect(indexed.traces.map((t) => t.trace_id)).toEqual(['noisy', 'refund']);
    expect(await ids(full, 'platinum')).toEqual(['refund']);
  });

  it('a database with an index opened without FTS5 drops the triggers so writes keep working, and is rebuilt on the next start that can', async () => {
    const path = tempDb();
    const first = await adapter(path);
    await first.insertTraces(LOCAL_TENANT, [refundTrace, weatherTrace]);
    await first.close();
    open.splice(open.indexOf(first), 1);

    const degraded = await adapter(path, { fts5: false });
    const triggers = dbOf(degraded).prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trace_search%'").all();
    expect(triggers).toEqual([]);
    // Writes the index does not see: an insert, a delete, and a metadata change.
    await degraded.insertTraces(LOCAL_TENANT, [noisyTrace]);
    expect(await degraded.deleteTrace(LOCAL_TENANT, 'weather')).toBe(true);
    await degraded.updateTraceMetadata(LOCAL_TENANT, 'refund', { note: 'escalated' });
    expect((await degraded.queryTraces(LOCAL_TENANT, { search: 'billing' })).search?.index).toBe('scan');
    expect(await ids(degraded, 'billing')).toEqual(['noisy']);
    await degraded.close();
    open.splice(open.indexOf(degraded), 1);

    const restored = await adapter(path);
    assertIndexHealthy(restored);
    expect(await ids(restored, 'billing')).toEqual(['noisy']);
    expect(await ids(restored, 'zurich')).toEqual([]);
    expect(await ids(restored, 'escalated')).toEqual(['refund']);
    const triggersBack = dbOf(restored).prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trace_search%' ORDER BY name").all() as Array<{ name: string }>;
    expect(triggersBack.map((t) => t.name)).toEqual(['trace_search_ad', 'trace_search_au']);
  });
});

describe('trace search — erasure', () => {
  const fileHolds = (path: string, needle: string): boolean => existsSync(path) && readFileSync(path).includes(needle);

  it('leaves none of a deleted trace’s words in iris.db or iris.db-wal, and never stores a second copy of the text', async () => {
    const path = tempDb();
    const s = await adapter(path);
    // One word the index stores (lower-cased) and nothing else in the file contains.
    const word = 'zyxwvutsrqponmlkjihgfedcba';
    const sentence = `the account number is ${word} and it must not survive`;
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 'secret', agent_name: 'a', output: sentence, timestamp: at(1) }, refundTrace]);
    await s.checkpoint();
    // Anti-theater: the word is on disk, in the trace row and in the index.
    expect(fileHolds(path, word)).toBe(true);
    // The index is contentless: the sentence is stored once, in the traces table.
    expect(readFileSync(path).toString('latin1').split(sentence).length - 1).toBe(1);

    expect(await s.deleteTrace(LOCAL_TENANT, 'secret')).toBe(true);
    await s.checkpoint();
    expect(fileHolds(path, word)).toBe(false);
    expect(fileHolds(`${path}-wal`, word)).toBe(false);
    expect(await ids(s, 'approved')).toEqual(['refund']);
  });

  /*
   * The bulk paths erase differently (search-index.ts, bulkIndexDelete):
   * a sweep that removes a large share of the index rewrites it once rather
   * than erasing row by row, and a purge of everything empties it. Each
   * must leave the same file: no word of a removed trace, a whole index.
   */
  const secretTraces = (n: number, word: string, timestamp: string): Trace[] =>
    Array.from({ length: n }, (_, i) => ({ trace_id: `old-${i}`, agent_name: 'a', output: `record ${i} holds ${word}`, timestamp }));

  it('a retention sweep large enough to rewrite the index leaves none of the swept words', async () => {
    const path = tempDb();
    const s = await adapter(path);
    const word = 'qwpoeirutyalskdjfhgzmxncbv';
    await s.insertTraces(LOCAL_TENANT, [...secretTraces(40, word, '2020-01-01T00:00:00.000Z'), { ...refundTrace, timestamp: new Date().toISOString() }]);
    await s.checkpoint();
    expect(fileHolds(path, word)).toBe(true);
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(40);
    await s.checkpoint();
    expect(fileHolds(path, word)).toBe(false);
    expect(fileHolds(`${path}-wal`, word)).toBe(false);
    assertIndexHealthy(s);
    expect(await ids(s, 'approved')).toEqual(['refund']);
    // secure-delete is back on for the deletes that follow.
    const config = dbOf(s).prepare("SELECT v FROM trace_search_config WHERE k = 'secure-delete'").get() as { v: number };
    expect(Number(config.v)).toBe(1);
  });

  it('a purge of one tenant keeps the other’s traces searchable and leaves none of the purged words; a purge of the last tenant empties the index', async () => {
    const path = tempDb();
    const s = await adapter(path);
    const other = asTenantId('acme');
    const word = 'mnbvcxzlkjhgfdsapoiuytrewq';
    await s.insertTraces(LOCAL_TENANT, secretTraces(20, word, at(1)));
    await s.insertTraces(other, [{ ...refundTrace, trace_id: 'acme-refund' }]);
    await s.purge(LOCAL_TENANT);
    expect(fileHolds(path, word)).toBe(false);
    expect(fileHolds(`${path}-wal`, word)).toBe(false);
    assertIndexHealthy(s);
    expect(await ids(s, 'approved', other)).toEqual(['acme-refund']);
    await s.purge(other);
    assertIndexHealthy(s, { docs: 0, traces: 0 });
    expect(fileHolds(path, 'deutsche')).toBe(false);
  });
});
