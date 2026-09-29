/*
 * Trace search reads span text (#683).
 *
 * An OTLP trace keeps its first model call's input and output on the trace
 * row; the later model calls of an agent loop, tool arguments and results,
 * and exception messages are only in its spans. These tests send an agent
 * loop through the OTLP door (fromOtlp, then insertTraces, as POST
 * /v1/traces does) and search for a word from each, with the index and by
 * reading the traces, and pin what is not searchable (attribute keys, the
 * span ids the door keeps). Then that the index stays exact however the
 * spans change: a span added later, a span deleted by hand, the trace
 * deleted, a sweep; and that an index built before the spans column is
 * rebuilt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Driver } from '../../../src/storage/driver.js';
import type { Trace } from '../../../src/types/trace.js';
import { fromOtlp, type OtlpTraceRequest } from '../../../src/otel/ingest.js';
import { SPAN_TEXT_MAX_CHARS, SPAN_TEXT_SEPARATOR, SPAN_VALUE_MAX_CHARS, readSpanText, spanTextSql, type SpanText, indexQueued } from '../../../src/storage/search-index.js';
import type { Span } from '../../../src/types/trace.js';
import { SEARCH_DRIVER } from './fts5-here.js';
import { parseSearch, spansMayMatch } from '../../../src/storage/search.js';

// File-backed stores, several opens per test, as in trace-search.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-span-search-'));
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

/** The store's connection, with what waits on the index queue (#729) indexed first: a direct read sees the index a search would. */
const dbOf = (s: SqliteAdapter): Driver => {
  const db = (s as unknown as { db: Driver }).db;
  while (indexQueued(db, 1024) !== null);
  return db;
};

function assertIndexHealthy(s: SqliteAdapter): void {
  const db = dbOf(s);
  db.exec("INSERT INTO trace_search (trace_search, rank) VALUES ('integrity-check', 0)");
  const row = db.prepare('SELECT (SELECT COUNT(*) FROM traces) AS traces, (SELECT COUNT(*) FROM trace_search_docs) AS docs').get() as { traces: number; docs: number };
  expect(Number(row.docs)).toBe(Number(row.traces));
}

const ids = async (s: SqliteAdapter, search: string) =>
  (await s.queryTraces(LOCAL_TENANT, { search, sort_by: 'timestamp', sort_order: 'asc', limit: 1000 })).traces.map((t) => t.trace_id);

const str = (stringValue: string) => ({ stringValue });
const attrs = (record: Record<string, string>) => Object.entries(record).map(([key, v]) => ({ key, value: str(v) }));
const nanos = (ms: number) => String(BigInt(Date.UTC(2026, 8, 20, 12, 0, 0) + ms) * 1_000_000n);
const messages = (...turns: Array<[string, string]>) => JSON.stringify(turns.map(([role, content]) => ({ role, parts: [{ type: 'text', content }] })));

/**
 * An agent loop as the OpenAI and LangChain instrumentations send it: two
 * model calls and a tool call between them. The first call's input and
 * output land on the trace row; the tool's result, the second call's
 * answer and an exception event are only in spans. The second call
 * re-sends the whole conversation, as every model call does.
 */
function agentLoop(otlpTraceId: string, words: { tool: string; later: string; exception: string }): OtlpTraceRequest {
  const first = messages(['user', 'Book a table for two at Quintonil tonight']);
  const firstOut = messages(['assistant', 'I will check availability with the booking tool']);
  const span = (spanId: string, name: string, start: number, attributes: Array<{ key: string; value: unknown }>, events?: unknown[]) => ({
    traceId: otlpTraceId,
    spanId,
    name,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(start + 50),
    attributes,
    ...(events ? { events } : {}),
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'service.name': 'concierge' }) },
        scopeSpans: [
          {
            spans: [
              span('a1', 'chat gpt-5', 0, attrs({ 'gen_ai.request.model': 'gpt-5', 'gen_ai.input.messages': first, 'gen_ai.output.messages': firstOut })),
              span('a2', 'execute_tool book_table', 100, attrs({ 'gen_ai.tool.name': 'book_table', 'gen_ai.tool.call.arguments': '{"restaurant":"Quintonil","party":2}', 'gen_ai.tool.call.result': `{"status":"${words.tool}"}` }), [
                { name: 'exception', timeUnixNano: nanos(120), attributes: attrs({ 'exception.type': 'TimeoutError', 'exception.message': `retry after ${words.exception}` }) },
              ]),
              span(
                'a3',
                'chat gpt-5',
                200,
                attrs({
                  'gen_ai.request.model': 'gpt-5',
                  'gen_ai.input.messages': messages(['user', 'Book a table for two at Quintonil tonight'], ['assistant', 'I will check availability with the booking tool']),
                  'gen_ai.output.messages': messages(['assistant', `The table is ${words.later} for 8pm`]),
                }),
              ),
            ],
          },
        ],
      },
    ],
  };
}

let minted = 0;
function otlpTraces(request: OtlpTraceRequest, id: string): Trace[] {
  return fromOtlp(request, { mintTraceId: () => id, mintSpanId: () => `${id}-s${(minted += 1)}` }).traces.map((m) => m.trace);
}

const loopA = () => otlpTraces(agentLoop('0af7651916cd43dd8448eb211c80319c', { tool: 'waitlisted', later: 'confirmed', exception: 'zanzibar' }), 'loop-a');
const loopB = () => otlpTraces(agentLoop('4bf92f3577b34da6a3ce929d0e0e4736', { tool: 'available', later: 'marzipan', exception: 'quokka' }), 'loop-b');

describe('span text — what a search finds', () => {
  for (const fts5 of [true, false]) {
    const how = fts5 ? 'with the index' : 'by reading the traces (no FTS5)';

    it(`finds an OTLP trace by a word in a tool result, a later model call or an exception message, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, [...loopA(), ...loopB()]);
      const [a] = loopA();
      // Anti-theater: none of these words is on the trace row the other four fields read.
      for (const word of ['waitlisted', 'confirmed', 'zanzibar']) expect(JSON.stringify([a.input, a.output, a.tool_calls, a.metadata])).not.toContain(word);
      expect(await ids(s, 'waitlisted')).toEqual(['loop-a']);
      expect(await ids(s, 'confirmed')).toEqual(['loop-a']);
      expect(await ids(s, 'zanzibar')).toEqual(['loop-a']);
      expect(await ids(s, 'marzipan')).toEqual(['loop-b']);
      expect(await ids(s, '"retry after quokka"')).toEqual(['loop-b']);
      expect((await s.queryTraces(LOCAL_TENANT, { search: 'zanzibar' })).search?.index).toBe(fts5 ? 'fts5' : 'scan');
    });

    it(`says which span matched, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, loopA());
      const [hit] = (await s.queryTraces(LOCAL_TENANT, { search: 'waitlisted' })).traces;
      expect(hit.match?.field).toBe('spans');
      expect(hit.match?.span?.name).toBe('execute_tool book_table');
      expect(hit.match?.fragments.find((f) => f.hit)?.text).toBe('waitlisted');
      const [later] = (await s.queryTraces(LOCAL_TENANT, { search: 'confirmed' })).traces;
      expect(later.match?.span?.name).toBe('chat gpt-5');
      expect(later.match?.snippet).toContain('The table is confirmed for 8pm');
    });

    it(`reads values, never attribute keys, and not the span ids the OTLP door keeps, ${how}`, async () => {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, loopA());
      expect(await ids(s, 'loop-a')).toEqual([]);
      expect(await ids(s, 'exception message')).toEqual([]);
      expect(await ids(s, 'arguments')).toEqual([]);
      // The first OTLP span id, kept as otel.span_id.
      expect(await ids(s, 'a1')).toEqual([]);
      expect(await ids(s, 'TimeoutError')).toEqual(['loop-a']);
    });
  }
});

describe('span text — what is indexed', () => {
  const span = (span_id: string, start_time: string, attributes: Record<string, unknown>, events?: Span['events']): Span => ({
    span_id,
    trace_id: 't',
    name: span_id,
    kind: 'INTERNAL',
    status_code: 'OK',
    start_time,
    attributes,
    events,
  });
  const at = (s: number) => `2026-09-20T12:00:${String(s).padStart(2, '0')}.000Z`;

  /** The span text of one trace with these spans: what readSpanText gives, checked against the string the index column is given. */
  async function spanTextOf(spans: Span[]): Promise<SpanText> {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 't', agent_name: 'a', timestamp: at(0), spans }]);
    const read = readSpanText(dbOf(s), ['t']).get('t') ?? { text: '', parts: [] };
    const indexed = (dbOf(s).prepare(`SELECT ${spanTextSql("'t'")} AS v`).get() as { v: string }).v;
    expect(read.text).toBe(indexed);
    return read;
  }

  it('indexes a repeated value once: a later call re-sending the conversation adds only what is new', async () => {
    const history = messages(['user', 'first question'], ['assistant', 'first answer']);
    const { text } = await spanTextOf([
      span('s1', at(0), { 'gen_ai.input.messages': messages(['user', 'first question']), 'gen_ai.output.messages': messages(['assistant', 'first answer']) }),
      span('s2', at(1), { 'gen_ai.input.messages': history, 'gen_ai.output.messages': messages(['assistant', 'second answer']) }),
    ]);
    expect(text.split('first question').length - 1).toBe(1);
    expect(text).toContain('second answer');
    // Keys inside the JSON are not words of the trace; values like "user" are.
    expect(text).not.toContain('parts');
  });

  it('is the same text whatever order the spans are written in', async () => {
    const spans = [span('b', at(1), { x: 'later words' }), span('a', at(0), { x: 'earlier words' }), span('c', at(1), { x: 'tie words' })];
    const forward = (await spanTextOf(spans)).text;
    expect((await spanTextOf([...spans].reverse())).text).toBe(forward);
    expect(forward).toBe(['earlier words', 'later words', 'tie words'].join(SPAN_TEXT_SEPARATOR));
  });

  it('cuts a long value, and cuts the trace’s span text at the cap', async () => {
    // Nine values of 4,096 characters after the cut: seven fit whole (28,690 with separators), the eighth is cut at 32,768.
    const spans = Array.from({ length: 9 }, (_, i) => span(`s${i}`, at(i), { payload: `v${i} ${'lorem '.repeat(1_000)}` }));
    spans.push(span('z', at(20), {}, [{ name: 'exception', timestamp: at(20), attributes: { 'exception.message': 'the short exception' } }]));
    const { text, parts } = await spanTextOf(spans);
    expect(parts.map((p) => p.span_id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
    for (const p of parts.slice(0, 7)) expect(p.end - p.start).toBe(SPAN_VALUE_MAX_CHARS);
    expect(text.length).toBe(SPAN_TEXT_MAX_CHARS);
    expect(text).not.toContain('the short exception');
  });

  it('cuts at the cap by characters, as SQLite does, when the text is past the Basic Multilingual Plane', async () => {
    const emoji = '🙂'.repeat(4_000);
    const spans = Array.from({ length: 9 }, (_, i) => span(`s${i}`, at(i), { payload: `${i}${emoji}` }));
    // spanTextOf checks readSpanText's text against the index column's.
    const { text } = await spanTextOf(spans);
    expect(Array.from(text).length).toBe(SPAN_TEXT_MAX_CHARS);
  });

  it('skips numbers, booleans and the OTLP door’s span ids, and reads nested arrays, objects and event attributes by their strings', async () => {
    const { text } = await spanTextOf([
      span('s', at(0), { 'gen_ai.usage.input_tokens': 1234, ok: true, 'otel.span_id': 'ab12cd34ef56ab78', tags: ['alpha', { deep: 'beta' }] }, [
        { name: 'exception', timestamp: at(0), attributes: { 'exception.message': 'gamma', 'exception.escaped': false } },
      ]),
    ]);
    expect(text).toBe(['alpha', 'beta', 'gamma'].join(SPAN_TEXT_SEPARATOR));
  });

  it('reads attributes and events that are not what it expects without failing the write', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 'odd', agent_name: 'a', timestamp: at(0), spans: [span('s', at(0), { ok: 'kept' })] }]);
    // Written by hand: attributes that are not JSON, events that are an object, an event whose attributes are a string.
    dbOf(s).prepare("INSERT INTO spans (tenant_id, span_id, trace_id, name, start_time, attributes, events) VALUES ('local', 'h1', 'odd', 'h', ?, 'not json', '{\"a\":1}')").run(at(1));
    dbOf(s).prepare("INSERT INTO spans (tenant_id, span_id, trace_id, name, start_time, attributes, events) VALUES ('local', 'h2', 'odd', 'h', ?, '[\"listed\"]', '[{\"attributes\":\"flat\"}, 7]')").run(at(2));
    assertIndexHealthy(s);
    expect(await ids(s, 'kept')).toEqual(['odd']);
    expect(await ids(s, 'listed')).toEqual(['odd']);
    expect(await s.deleteTrace(LOCAL_TENANT, 'odd')).toBe(true);
    assertIndexHealthy(s);
  });
});

describe('span text — the index stays exact', () => {
  it('a span added to an indexed trace is searchable, and the trace still deletes cleanly', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, loopA());
    await s.insertSpan(LOCAL_TENANT, { span_id: 'late', trace_id: 'loop-a', name: 'late span', kind: 'INTERNAL', status_code: 'OK', start_time: '2026-09-20T12:05:00.000Z', attributes: { note: 'kumquat arrived late' } });
    expect(await ids(s, 'kumquat')).toEqual(['loop-a']);
    expect(await ids(s, 'waitlisted')).toEqual(['loop-a']);
    assertIndexHealthy(s);
    expect(await s.deleteTrace(LOCAL_TENANT, 'loop-a')).toBe(true);
    expect(await ids(s, 'kumquat')).toEqual([]);
    assertIndexHealthy(s);
  });

  it('a span deleted by hand does not change what the trace’s delete hands the index', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [...loopA(), ...loopB()]);
    dbOf(s).prepare("DELETE FROM spans WHERE trace_id = 'loop-a' AND name = 'execute_tool book_table'").run();
    assertIndexHealthy(s);
    dbOf(s).prepare("DELETE FROM traces WHERE trace_id = 'loop-a'").run();
    assertIndexHealthy(s);
    expect(await ids(s, 'waitlisted')).toEqual([]);
    expect(await ids(s, 'marzipan')).toEqual(['loop-b']);
  });

  it('a span edited by hand, or moved to another trace, re-indexes both traces', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [...loopA(), ...loopB()]);
    dbOf(s).prepare("UPDATE spans SET attributes = json_set(attributes, '$.\"gen_ai.tool.call.result\"', '{\"status\":\"rebooked\"}') WHERE trace_id = 'loop-a' AND name = 'execute_tool book_table'").run();
    expect(await ids(s, 'rebooked')).toEqual(['loop-a']);
    expect(await ids(s, 'waitlisted')).toEqual([]);
    assertIndexHealthy(s);
    dbOf(s).prepare("UPDATE spans SET trace_id = 'loop-b' WHERE trace_id = 'loop-a' AND name = 'execute_tool book_table'").run();
    expect(await ids(s, 'rebooked')).toEqual(['loop-b']);
    assertIndexHealthy(s);
    for (const id of ['loop-a', 'loop-b']) expect(await s.deleteTrace(LOCAL_TENANT, id)).toBe(true);
    assertIndexHealthy(s);
  });

  it('a retention sweep and the metadata patch keep span words exact', async () => {
    const s = await adapter();
    await s.insertTraces(LOCAL_TENANT, [...loopA(), ...loopB()]);
    await s.updateTraceMetadata(LOCAL_TENANT, 'loop-b', { note: 'escalated' });
    expect(await ids(s, 'marzipan')).toEqual(['loop-b']);
    assertIndexHealthy(s);
    await s.deleteTracesOlderThan(LOCAL_TENANT, 0);
    expect(await ids(s, 'marzipan')).toEqual([]);
    assertIndexHealthy(s);
  });

  it('leaves none of a deleted trace’s span words in iris.db or iris.db-wal', async () => {
    const path = tempDb();
    const s = await adapter(path);
    const word = 'qzjxkvbwpfmhgdlcrntsyaeiou';
    await s.insertTraces(LOCAL_TENANT, [...otlpTraces(agentLoop('5bf92f3577b34da6a3ce929d0e0e4736', { tool: word, later: 'fine', exception: 'none' }), 'secret'), ...loopB()]);
    await s.checkpoint();
    const holds = (file: string) => existsSync(file) && readFileSync(file).includes(word);
    // Anti-theater: on disk in the span row, the docs row and the index.
    expect(holds(path)).toBe(true);
    expect(await s.deleteTrace(LOCAL_TENANT, 'secret')).toBe(true);
    await s.checkpoint();
    expect(holds(path)).toBe(false);
    expect(holds(`${path}-wal`)).toBe(false);
    expect(await ids(s, 'marzipan')).toEqual(['loop-b']);
  });
});

describe('span text — an index built before the spans column', () => {
  it('is dropped and built again at the next start, and then finds span words', async () => {
    const path = tempDb();
    const first = await adapter(path);
    await first.insertTraces(LOCAL_TENANT, [...loopA(), ...loopB()]);
    // The shape an earlier release built: four columns, no spans on the docs row.
    const db = dbOf(first);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trace_search%'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER ${name}`);
    db.exec(`
      DROP TABLE trace_search; DROP TABLE trace_search_docs;
      CREATE TABLE trace_search_docs (doc_id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, trace_id TEXT NOT NULL UNIQUE);
      CREATE VIRTUAL TABLE trace_search USING fts5(input, output, tool_calls, metadata, content = '', tokenize = 'unicode61 remove_diacritics 2');
      INSERT INTO trace_search_docs (tenant_id, trace_id) SELECT tenant_id, trace_id FROM traces;
      INSERT INTO trace_search (rowid, input, output, tool_calls, metadata) SELECT d.doc_id, t.input, t.output, NULL, NULL FROM trace_search_docs d JOIN traces t ON t.trace_id = d.trace_id;
      CREATE TRIGGER trace_search_ad AFTER DELETE ON traces BEGIN DELETE FROM trace_search_docs WHERE trace_id = OLD.trace_id; END;
      CREATE TRIGGER trace_search_au AFTER UPDATE OF metadata ON traces BEGIN SELECT 1; END;
    `);
    await first.close();
    open.splice(open.indexOf(first), 1);
    // The start renames the old index and returns; the build drops it before it indexes a trace.
    const next = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    open.push(next);
    await next.initialize();
    const retired = () => (dbOf(next).prepare("SELECT name FROM sqlite_master WHERE name LIKE 'trace_search_retired%'").all() as unknown[]).length;
    expect(retired()).toBeGreaterThan(0);
    expect(await next.whenSearchIndexReady()).toBe('ready');
    expect(retired()).toBe(0);
    assertIndexHealthy(next);
    expect(await ids(next, 'waitlisted')).toEqual(['loop-a']);
    expect(await ids(next, 'marzipan')).toEqual(['loop-b']);
    const declared = (dbOf(next).prepare("SELECT sql FROM sqlite_master WHERE name = 'trace_search'").get() as { sql: string }).sql;
    expect(declared).toMatch(/metadata, spans/);
    const triggers = (dbOf(next).prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trace_search_ad'").all() as unknown[]).length;
    expect(triggers).toBe(0);
  });
});

describe('span text — the search without FTS5 skips only spans that cannot match', () => {
  const none = { input: '', output: '', tool_calls: '', spans: '', metadata: '' };
  const may = (q: string, raw: string) => spansMayMatch(none, parseSearch(q), raw);
  // What the adapter stores: JSON.stringify of the attributes, so an escape is a backslash in the text.
  const stored = (attributes: Record<string, unknown>) => JSON.stringify(attributes);

  it('reads the stored JSON with accents and case removed, and a word glued to an escape', () => {
    expect(may('cafe', stored({ note: 'Café au lait' }))).toBe(true);
    // The newline is stored as backslash-n, so "hello" sits in "nhello".
    expect(stored({ note: 'line one\nhello' })).toContain('\\nhello');
    expect(may('hello', stored({ note: 'line one\nhello' }))).toBe(true);
    expect(may('"au lait"', stored({ note: 'café au lait' }))).toBe(true);
    expect(may('lai*', stored({ note: 'café au lait' }))).toBe(true);
    expect(may('zanzibar', stored({ note: 'café au lait' }))).toBe(false);
  });

  it('always may when the JSON spells letters as unicode escapes, and compares a final sigma however it lower-cased', () => {
    // A messages attribute a Python client wrote with json.dumps: é as an escape inside the string.
    const pythonJson = '[{"content": "caf' + '\\' + 'u00e9"}]';
    expect(may('cafe', stored({ m: pythonJson }))).toBe(true);
    expect(may('οδος', stored({ note: 'ΟΔΟΣ.ΑΒΓ' }))).toBe(true);
  });

  it('asks only about the terms the trace’s own fields lack', () => {
    const fields = { ...none, output: 'the refund was approved' };
    expect(spansMayMatch(fields, parseSearch('refund zanzibar'), stored({ x: 'zanzibar' }))).toBe(true);
    expect(spansMayMatch(fields, parseSearch('refund zanzibar'), stored({ x: 'nothing here' }))).toBe(false);
  });

  it('finds a word inside JSON written with unicode escapes, with the index and without it', async () => {
    const escaped = '[{"role": "assistant", "parts": [{"type": "text", "content": "caf' + '\\' + 'u00e9 cr' + '\\' + 'u00e8me"}]}]';
    for (const fts5 of [true, false]) {
      const s = await adapter(':memory:', { fts5 });
      await s.insertTraces(LOCAL_TENANT, [
        {
          trace_id: 'py',
          agent_name: 'a',
          timestamp: '2026-09-20T12:00:00.000Z',
          spans: [{ span_id: 'p1', trace_id: 'py', name: 'chat', kind: 'LLM', status_code: 'OK', start_time: '2026-09-20T12:00:00.000Z', attributes: { 'gen_ai.output.messages': escaped } }],
        },
      ]);
      expect(await ids(s, 'creme')).toEqual(['py']);
    }
  });
});
