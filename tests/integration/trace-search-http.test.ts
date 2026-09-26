/*
 * GET /api/v1/traces?q= (#7) against the REAL dashboard server over a real
 * socket, behind the same middleware production traffic passes: traces are
 * stored through POST /api/v1/traces and found again by what they said.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const booted: Array<{ server: Server; storage: SqliteAdapter }> = [];

afterEach(async () => {
  for (const b of booted.splice(0)) {
    b.server.closeAllConnections?.();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
    await b.storage.close();
  }
});

async function boot(): Promise<string> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 } };
  const server = createDashboardServer(storage, config, quiet).start();
  await new Promise((r) => server.once('listening', r));
  booted.push({ server, storage });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function post(base: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { trace_id: string }).trace_id;
}

async function get(base: string, query: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/traces?${new URLSearchParams(query)}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/v1/traces?q=', () => {
  it('finds stored traces by their text, ranked, each with a match, and keeps the other filters', async () => {
    const base = await boot();
    const refund = await post(base, {
      agent_name: 'support-bot',
      input: 'Can I get my money back for order 5521?',
      output: 'Your refund for order 5521 was approved and is on its way.',
      tool_calls: [{ tool_name: 'issue_refund', input: { order: '5521', method: 'Klarna' } }],
      metadata: { channel: 'whatsapp' },
    });
    await post(base, { agent_name: 'support-bot', output: 'Refunds take five days.' });
    await post(base, { agent_name: 'sales-bot', output: 'Order 5521 upgraded to express.' });

    const hit = await get(base, { q: 'order 5521 refund' });
    expect(hit.status).toBe(200);
    expect(hit.json.total).toBe(1);
    expect(hit.json.search).toEqual({ terms: ['order', '5521', 'refund'], index: 'fts5' });
    const [trace] = hit.json.traces as Array<{ trace_id: string; match: { field: string; snippet: string } }>;
    expect(trace.trace_id).toBe(refund);
    expect(trace.match.field).toBe('output');
    expect(trace.match.snippet).toBe('Your refund for order 5521 was approved and is on its way.');

    expect(((await get(base, { q: 'klarna' })).json.traces as Array<{ trace_id: string; match: { field: string } }>).map((t) => [t.trace_id, t.match.field])).toEqual([[refund, 'tool_calls']]);
    expect(((await get(base, { q: 'whatsapp' })).json.traces as Array<{ match: { field: string } }>)[0].match.field).toBe('metadata');
    expect((await get(base, { q: '5521', agent_name: 'sales-bot' })).json.total).toBe(1);
    expect((await get(base, { q: 'refund*', sort_by: 'timestamp', sort_order: 'asc' })).json.total).toBe(2);
  });

  it('answers 400 naming the problem for a q with no word, relevance without q, and an overlong q; a blank q is no search', async () => {
    const base = await boot();
    await post(base, { agent_name: 'bot', output: 'hello world' });
    const noWord = await get(base, { q: '(*)' });
    expect(noWord.status).toBe(400);
    expect(JSON.stringify(noWord.json.details)).toMatch(/has no word to search for/);
    const relevance = await get(base, { sort_by: 'relevance' });
    expect(relevance.status).toBe(400);
    expect(JSON.stringify(relevance.json.details)).toMatch(/ranks a search/);
    expect((await get(base, { q: 'y'.repeat(501) })).status).toBe(400);
    const blank = await get(base, { q: '' });
    expect(blank.status).toBe(200);
    expect(blank.json.total).toBe(1);
    expect(blank.json.search).toBeUndefined();
  });

  it('answers FTS5 syntax as words, never a 500', async () => {
    const base = await boot();
    await post(base, { agent_name: 'bot', output: 'Not a NEAR miss: see output miss.' });
    for (const q of ['NEAR(miss', '"near miss', 'output:miss', 'miss)', 'NOT miss', "miss'"]) {
      const r = await get(base, { q });
      expect(r.status, q).toBe(200);
      expect(r.json.total, q).toBe(1);
    }
  });
});
