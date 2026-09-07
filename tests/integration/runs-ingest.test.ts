/*
 * Runs and case keys arrive through BOTH ingest paths (acceptance row C8) —
 * and the tools catalogue finally arrives through the MCP one.
 *
 * The catalogue bug is why this file drives the real handlers rather than
 * the storage layer: `tools` was in log_trace's input schema since 0.11.0,
 * described as "stored on the trace and reused by evaluate_output", and the
 * handler never put it in the object it stored. Storage was correct, the
 * schema was correct, the HTTP route was correct, and the MCP path dropped
 * it — a gap no test of any single layer could see.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { registerLogTraceTool } from '../../src/tools/log-trace.js';
import { deriveCaseKey } from '../../src/eval/case-key.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal stand-in for the MCP server that captures the registered handler. */
function harness(): { call: (args: Record<string, unknown>) => Promise<unknown>; store: SqliteAdapter } {
  const dir = mkdtempSync(join(tmpdir(), 'iris-runs-'));
  dirs.push(dir);
  const store = new SqliteAdapter(join(dir, 'iris.db'));
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  const server = {
    registerTool: (_name: string, _cfg: unknown, fn: (args: Record<string, unknown>) => Promise<unknown>) => {
      handler = fn;
    },
  };
  registerLogTraceTool(server as never, store as never);
  if (!handler) throw new Error('log_trace did not register');
  return { call: handler, store };
}

const traceIdOf = (result: unknown): string => {
  const r = result as { structuredContent?: { trace_id?: string } };
  const id = r.structuredContent?.trace_id;
  if (!id) throw new Error(`no trace_id in ${JSON.stringify(result).slice(0, 200)}`);
  return id;
};

describe('log_trace carries what it says it carries', () => {
  it('STORES THE TOOLS CATALOGUE — the field it accepted and dropped through 0.11.0', async () => {
    const { call, store } = harness();
    await store.initialize();
    const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }];
    const id = traceIdOf(await call({ agent_name: 'a', input: 'q', output: 'o', tools }));
    const back = await store.getTrace(LOCAL_TENANT, id);
    expect(back?.tools, 'the catalogue must survive the MCP path').toHaveLength(1);
    expect(back?.tools?.[0].name).toBe('read_file');
    await store.close();
  });

  it('carries a run and a case key when the caller names them', async () => {
    const { call, store } = harness();
    await store.initialize();
    const id = traceIdOf(await call({ agent_name: 'a', input: 'q', output: 'o', run: 'ci-1234', case_key: 'fixture-07' }));
    const back = await store.getTrace(LOCAL_TENANT, id);
    expect(back?.run_id).toBe('ci-1234');
    expect(back?.case_key).toBe('fixture-07');
    await store.close();
  });

  it('derives a case key when the caller sends none, so pairing works for free', async () => {
    const { call, store } = harness();
    await store.initialize();
    const id = traceIdOf(await call({ agent_name: 'a', input: 'Summarise the release notes.', output: 'o' }));
    const back = await store.getTrace(LOCAL_TENANT, id);
    expect(back?.case_key).toBe(deriveCaseKey('Summarise the release notes.'));
    await store.close();
  });

  it('two runs asking the same question pair on the derived key', async () => {
    const { call, store } = harness();
    await store.initialize();
    const a = traceIdOf(await call({ agent_name: 'a', input: 'What port?', output: '6920', run: 'before' }));
    const b = traceIdOf(await call({ agent_name: 'a', input: 'What port?', output: '6921', run: 'after' }));
    const ta = await store.getTrace(LOCAL_TENANT, a);
    const tb = await store.getTrace(LOCAL_TENANT, b);
    expect(ta?.case_key).toBe(tb?.case_key);
    expect(ta?.run_id).not.toBe(tb?.run_id);
    await store.close();
  });

  it('every existing caller keeps working: no run, no case key, no input', async () => {
    // The compatibility that makes the migration additive rather than a
    // breaking change — a trace that belongs to no run is the normal case
    // for every trace already stored.
    const { call, store } = harness();
    await store.initialize();
    const id = traceIdOf(await call({ agent_name: 'a', output: 'o' }));
    const back = await store.getTrace(LOCAL_TENANT, id);
    expect(back?.run_id).toBeUndefined();
    expect(back?.case_key).toBeUndefined();
    await store.close();
  });
});
