/*
 * Sessions on the HTTP door (arc 9, N-15): session_id on the body, or the
 * SEP-414 baggage member; the list filters by session and refuses a
 * misspelled filter; the field reads back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('sessions over HTTP', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let base = '';

  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/traces`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { trace_id: string } };
  };

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    server = createDashboardServer(storage, config, createLogger(config), {}).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  it('stores the session from the body or from the baggage, reads it back, and lists a session in time order', async () => {
    const a = await post({ agent_name: 'bot', input: 'one', output: 'a', session_id: 'sess-1', timestamp: '2026-09-21T12:00:00.000Z' });
    const b = await post({ agent_name: 'bot', input: 'two', output: 'b', timestamp: '2026-09-21T12:01:00.000Z' }, { traceparent: TP, baggage: 'user=u1,session_id=sess-1' });
    const c = await post({ agent_name: 'bot', input: 'three', output: 'c', session_id: 'sess-2', timestamp: '2026-09-21T12:02:00.000Z' });
    const d = await post({ agent_name: 'bot', input: 'four', output: 'd', timestamp: '2026-09-21T12:03:00.000Z' });
    expect([a.status, b.status, c.status, d.status]).toEqual([201, 201, 201, 201]);
    expect((await storage.getTrace(LOCAL_TENANT, a.body.trace_id))?.session_id).toBe('sess-1');
    expect((await storage.getTrace(LOCAL_TENANT, b.body.trace_id))?.session_id).toBe('sess-1');
    expect((await storage.getTrace(LOCAL_TENANT, d.body.trace_id))?.session_id).toBeUndefined();

    const read = (await (await fetch(`${base}/traces/${a.body.trace_id}`)).json()) as { trace: { session_id?: string } };
    expect(read.trace.session_id).toBe('sess-1');

    const list = (await (await fetch(`${base}/traces?session=sess-1&sort_order=asc`)).json()) as { traces: Array<{ trace_id: string; session_id?: string }>; total: number };
    expect(list.total).toBe(2);
    expect(list.traces.map((t) => t.trace_id)).toEqual([a.body.trace_id, b.body.trace_id]);
    expect(list.traces.every((t) => t.session_id === 'sess-1')).toBe(true);

    // The body's own session wins over the baggage's.
    const e = await post({ agent_name: 'bot', input: 'five', output: 'e', session_id: 'sess-3' }, { traceparent: TP, baggage: 'session_id=sess-1' });
    expect((await storage.getTrace(LOCAL_TENANT, e.body.trace_id))?.session_id).toBe('sess-3');
  });

  it('refuses a misspelled session filter and an empty session id', async () => {
    const bad = await fetch(`${base}/traces?sesion=sess-1`);
    expect(bad.status).toBe(400);
    expect(await post({ agent_name: 'bot', output: 'a', session_id: '' })).toMatchObject({ status: 400 });
  });
});
