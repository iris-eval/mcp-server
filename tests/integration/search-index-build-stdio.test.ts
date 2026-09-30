/*
 * The first start after upgrading does not make an MCP client wait for the
 * search index (#7).
 *
 * A store written before the index existed is opened by the real server
 * over stdio, the way a client that was just upgraded starts it. The server
 * must answer on connect while the index is still being built, search must
 * already work (by reading the traces), and the same search must come back
 * from the index once the build is done. Before the build moved out of
 * start-up, this store kept the server silent for the whole build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { Trace } from '../../src/types/trace.js';

const TRACES = 40_000;
const NEEDLES = 40;

describe('the search index is built after the server starts, not before it answers', () => {
  let irisHome: string;

  beforeAll(async () => {
    irisHome = mkdtempSync(join(tmpdir(), 'iris-search-build-'));
    // The store as a build without the index left it: traces, and no search objects.
    const store = new SqliteAdapter(join(irisHome, 'iris.db'), { fts5: false });
    await store.initialize();
    const now = Date.now();
    for (let i = 0; i < TRACES; i += 1000) {
      const batch: Trace[] = Array.from({ length: 1000 }, (_, k) => {
        const n = i + k;
        return {
          trace_id: `pre-${n}`,
          agent_name: 'support-bot',
          input: `question ${n} about an order and its delivery window`,
          output: `${n % (TRACES / NEEDLES) === 0 ? 'the zanzibar refund was approved' : 'the order is on its way'} — reply ${n}`,
          timestamp: new Date(now - (TRACES - n) * 1000).toISOString(),
        };
      });
      await store.insertTraces(LOCAL_TENANT, batch);
    }
    await store.close();
  }, 120_000);

  afterAll(() => {
    rmSync(irisHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('answers on connect and searches during the build, then from the index', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve(import.meta.dirname, '../../src/index.ts')],
      env: { ...getDefaultEnvironment(), IRIS_HOME: irisHome },
    });
    const client = new Client({ name: 'search-build', version: '0.1.0' });
    const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text) as { total: number; search: { index: string; complete: boolean } };
    try {
      const t0 = performance.now();
      await client.connect(transport);
      const tools = await client.listTools();
      const connectedMs = performance.now() - t0;
      expect(tools.tools.map((t) => t.name)).toContain('get_traces');

      const during = parse(await client.callTool({ name: 'get_traces', arguments: { q: 'zanzibar', limit: 5 } }));
      // Still building: answered by reading the traces, and answered correctly. A read of 40,000 traces on a busy
      // runner can pass the search's time budget (#703): then it says so, and has found only needles it read.
      expect(during.search.index).toBe('scan');
      if (during.search.complete) expect(during.total).toBe(NEEDLES);
      else expect(during.total).toBeLessThanOrEqual(NEEDLES);

      let after = during;
      const deadline = Date.now() + 180_000;
      while (after.search.index !== 'fts5' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        after = parse(await client.callTool({ name: 'get_traces', arguments: { q: 'zanzibar', limit: 5 } }));
      }
      const indexedMs = performance.now() - t0;
      expect(after.search.index).toBe('fts5');
      expect(after.search.complete).toBe(true);
      expect(after.total).toBe(NEEDLES);
      // The evidence, in the test log: the client was answered long before the index was ready.
      process.stdout.write(`[search-build] ${TRACES} traces: connected and listed tools in ${connectedMs.toFixed(0)} ms; index ready ${indexedMs.toFixed(0)} ms after spawn\n`);
      expect(connectedMs).toBeLessThan(indexedMs);
    } finally {
      await client.close();
    }
  }, 240_000);
});
