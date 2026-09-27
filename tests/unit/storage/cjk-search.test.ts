/*
 * Finding words inside Chinese, Japanese and Korean text (#682).
 *
 * unicode61 keeps a run of CJK characters as one word, so a word inside it
 * matched nothing. The CJK stream (search.ts, cjkStream; search-index.ts)
 * indexes each run's bigrams, only for traces that hold CJK. These tests
 * search each case with the index and without FTS5, which must agree; mark
 * the matched characters inside a run; keep the stream exact through every
 * route a trace or its spans change by; and leave traces without CJK out
 * of it entirely.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Driver } from '../../../src/storage/driver.js';
import type { Trace } from '../../../src/types/trace.js';
import { SEARCH_DRIVER } from './fts5-here.js';
import { foldText } from '../../../src/storage/search.js';

// File-backed stores, several opens per test, as in trace-search.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-cjk-search-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

async function adapter(path = ':memory:', options: { fts5?: boolean } = {}): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER, ...options });
  await s.initialize();
  open.push(s);
  await s.whenSearchIndexReady();
  return s;
}

const dbOf = (s: SqliteAdapter) => (s as unknown as { db: Driver }).db;

function assertIndexHealthy(s: SqliteAdapter): void {
  const db = dbOf(s);
  db.exec("INSERT INTO trace_search (trace_search, rank) VALUES ('integrity-check', 0)");
  db.exec("INSERT INTO trace_search_cjk (trace_search_cjk, rank) VALUES ('integrity-check', 0)");
  const row = db.prepare('SELECT (SELECT COUNT(*) FROM traces) AS traces, (SELECT COUNT(*) FROM trace_search_docs) AS docs').get() as { traces: number; docs: number };
  expect(Number(row.docs)).toBe(Number(row.traces));
}

const ids = async (s: SqliteAdapter, search: string) =>
  (await s.queryTraces(LOCAL_TENANT, { search, sort_by: 'timestamp', sort_order: 'asc', limit: 1000 })).traces.map((t) => t.trace_id);

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString();
const trace = (trace_id: string, output: string, extra: Partial<Trace> = {}): Trace => ({ trace_id, agent_name: 'support-bot', output, timestamp: at(Number(trace_id.replace(/\D/g, '')) || 0), ...extra });

const corpus: Trace[] = [
  trace('zh1', '退款已经批准了，请查收邮件'),
  trace('zh2', '订单已经发货，预计三天送达'),
  trace('ja3', 'カードの支払いが承認されました'),
  trace('ko4', '환불이 승인되었습니다'),
  trace('mix5', 'iPhone充电器坏了，已经退款 approved'),
  trace('en6', 'The refund was approved on Monday; café au lait'),
];

describe('CJK words are found inside a run', () => {
  for (const fts5 of [true, false]) {
    const how = fts5 ? 'with the index' : 'without FTS5';

    it(`finds a two-character word, a longer one, and one character anywhere in a run, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, corpus);
      expect((await s.queryTraces(LOCAL_TENANT, { search: '批准' })).search?.index).toBe(fts5 ? 'fts5' : 'scan');
      // The issue's example: 批准 ("approved") inside 退款已经批准了.
      expect(await ids(s, '批准')).toEqual(['zh1']);
      expect(await ids(s, '已经批准')).toEqual(['zh1']);
      expect(await ids(s, '已经')).toEqual(['zh1', 'zh2', 'mix5']);
      // One character, first, middle and last in its run.
      expect(await ids(s, '退')).toEqual(['zh1', 'mix5']);
      expect(await ids(s, '准')).toEqual(['zh1']);
      expect(await ids(s, '件')).toEqual(['zh1']);
      // In order, and inside one run: not across the comma, not reversed.
      expect(await ids(s, '批准了请')).toEqual([]);
      expect(await ids(s, '准批')).toEqual([]);
      expect(await ids(s, '"退款 批准"')).toEqual([]);
    });

    it(`finds Japanese with its long-vowel mark, and Korean, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, corpus);
      expect(await ids(s, 'カード')).toEqual(['ja3']);
      expect(await ids(s, '承認')).toEqual(['ja3']);
      expect(await ids(s, '支払い')).toEqual(['ja3']);
      expect(await ids(s, '승인')).toEqual(['ko4']);
      expect(await ids(s, '승인되었')).toEqual(['ko4']);
      expect(await ids(s, '환불이')).toEqual(['ko4']);
    });

    it(`finds Latin written against CJK, and a phrase mixing the two, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, corpus);
      expect(await ids(s, 'iphone')).toEqual(['mix5']);
      expect(await ids(s, 'iPhone充电器')).toEqual(['mix5']);
      expect(await ids(s, '充电')).toEqual(['mix5']);
      expect(await ids(s, '"退款 approved"')).toEqual(['mix5']);
      // Words without CJK are found as before, alongside a CJK word.
      expect(await ids(s, 'approved')).toEqual(['mix5', 'en6']);
      expect(await ids(s, 'cafe')).toEqual(['en6']);
      expect(await ids(s, 'approved 退款')).toEqual(['mix5']);
    });

    it(`never reads a phrase across words left out of the CJK stream, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      // alpha and delta sit next to CJK words and are carried into the stream; beta and gamma are not.
      await s.insertTraces(LOCAL_TENANT, [trace('g1', '退款 alpha beta gamma delta 批准')]);
      expect(await ids(s, '"退款 alpha"')).toEqual(['g1']);
      expect(await ids(s, '"delta 批准"')).toEqual(['g1']);
      expect(await ids(s, '"alpha delta"')).toEqual([]);
      expect(await ids(s, '"退款 批准"')).toEqual([]);
      expect(await ids(s, '"beta gamma"')).toEqual(['g1']);
    });

    it(`marks the matched characters inside the run, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, corpus);
      const [hit] = (await s.queryTraces(LOCAL_TENANT, { search: '批准' })).traces;
      expect(hit.match?.fragments).toEqual([
        { text: '退款已经', hit: false },
        { text: '批准', hit: true },
        { text: '了，请查收邮件', hit: false },
      ]);
    });
  }
});

describe('the CJK stream stays exact', () => {
  const cjkRows = (s: SqliteAdapter) =>
    dbOf(s).prepare('SELECT (SELECT COUNT(*) FROM trace_search_cjk_docs) AS docs, (SELECT COUNT(*) FROM trace_search_cjk_pending) AS pending').get() as { docs: number; pending: number };

  it('holds no row for a trace without CJK, accented Latin included', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [trace('en1', 'plain words'), trace('en2', 'Ünïcödé café résumé — naïve')]);
    expect(cjkRows(s)).toEqual({ docs: 0, pending: 0 });
    await s.insertTraces(LOCAL_TENANT, [trace('zh3', '退款已经批准了')]);
    expect(cjkRows(s)).toEqual({ docs: 1, pending: 0 });
  });

  it('follows delete_trace, the metadata patch and a sweep, with FTS5’s integrity check passing after each', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, corpus);
    assertIndexHealthy(s);
    await s.updateTraceMetadata(LOCAL_TENANT, 'en6', { note: '已经升级处理' });
    expect(await ids(s, '升级')).toEqual(['en6']);
    await s.updateTraceMetadata(LOCAL_TENANT, 'en6', { note: 'escalated' });
    expect(await ids(s, '升级')).toEqual([]);
    assertIndexHealthy(s);
    expect(await s.deleteTrace(LOCAL_TENANT, 'zh1')).toBe(true);
    expect(await ids(s, '批准')).toEqual([]);
    assertIndexHealthy(s);
    await s.deleteTracesOlderThan(LOCAL_TENANT, 0);
    expect(await ids(s, '承認')).toEqual([]);
    assertIndexHealthy(s);
    expect(cjkRows(s)).toEqual({ docs: 0, pending: 0 });
  });

  it('streams a span added to a trace, and one edited by hand at the next start', async () => {
    const path = tempDb();
    const s = await adapter(path);
    await s.insertTraces(LOCAL_TENANT, [trace('en1', 'plain words')]);
    await s.insertSpan(LOCAL_TENANT, { span_id: 'sp1', trace_id: 'en1', name: 'tool', kind: 'TOOL', status_code: 'OK', start_time: at(1), attributes: { result: '库存不足' } });
    expect(await ids(s, '库存')).toEqual(['en1']);
    assertIndexHealthy(s);
    dbOf(s).prepare("UPDATE spans SET attributes = json_set(attributes, '$.result', '库存充足') WHERE span_id = 'sp1'").run();
    // Taken out at once, by trigger; streamed again by the next start.
    expect(await ids(s, '不足')).toEqual([]);
    assertIndexHealthy(s);
    expect(cjkRows(s)).toEqual({ docs: 0, pending: 1 });
    await s.close();
    open.splice(open.indexOf(s), 1);
    const next = await adapter(path);
    expect(await ids(next, '充足')).toEqual(['en1']);
    expect(await ids(next, '不足')).toEqual([]);
    expect(cjkRows(next)).toEqual({ docs: 1, pending: 0 });
    assertIndexHealthy(next);
  });

  it('leaves none of a deleted trace’s CJK words in iris.db or iris.db-wal', async () => {
    const path = tempDb();
    const s = await adapter(path);
    // A word found nowhere else: rare characters, so neither the file's other pages nor the rest of the corpus hold it.
    const word = '鼗鼙鼛鼜';
    await s.insertTraces(LOCAL_TENANT, [trace('zh9', `密码是${word}不要外传`), ...corpus]);
    await s.checkpoint();
    const holds = (file: string, needle: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(needle, 'utf8'));
    // Anti-theater: its bigram is on disk, in the stream and the stored text.
    expect(holds(path, '鼗鼙')).toBe(true);
    expect(await s.deleteTrace(LOCAL_TENANT, 'zh9')).toBe(true);
    await s.checkpoint();
    for (const needle of [word, '鼗鼙', '鼙鼛', '鼛鼜']) {
      expect(holds(path, needle)).toBe(false);
      expect(holds(`${path}-wal`, needle)).toBe(false);
    }
    expect(await ids(s, '批准')).toEqual(['zh1']);
  });

  it('an index built before the CJK stream keeps its words, and streams its CJK traces at the next start', async () => {
    const path = tempDb();
    const first = await adapter(path);
    await first.insertTraces(LOCAL_TENANT, corpus);
    // The shape the previous release left: no CJK tables, and triggers of the same names that know nothing of them.
    const db = dbOf(first);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trace_search%'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER ${name}`);
    db.exec('DROP TABLE trace_search_cjk; DROP TABLE trace_search_cjk_docs; DROP TABLE trace_search_cjk_pending;');
    for (const name of ['trace_search_au', 'trace_search_bd', 'trace_search_spans_bi', 'trace_search_spans_ai', 'trace_search_spans_bd', 'trace_search_spans_ad', 'trace_search_spans_bu', 'trace_search_spans_au']) {
      db.exec(`CREATE TRIGGER ${name} AFTER UPDATE OF agent_name ON traces BEGIN SELECT 1; END`);
    }
    await first.close();
    open.splice(open.indexOf(first), 1);
    const next = await adapter(path);
    expect(await ids(next, '批准')).toEqual(['zh1']);
    expect(await ids(next, 'approved')).toEqual(['mix5', 'en6']);
    expect(cjkRows(next)).toEqual({ docs: 5, pending: 0 });
    assertIndexHealthy(next);
  });
});

describe('folding ASCII', () => {
  it('is lower-casing: foldText takes that shortcut for ASCII text, and the table agrees for every ASCII character', () => {
    const all = Array.from({ length: 127 }, (_, i) => String.fromCharCode(i + 1)).join('');
    // With one character past ASCII, foldText walks the table instead of taking the shortcut.
    expect(foldText(`${all}é`).slice(0, all.length)).toBe(all.toLowerCase());
  });
});
