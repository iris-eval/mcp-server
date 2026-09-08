/*
 * Nothing the composer computes is dropped on the way out (invariant 13).
 *
 * compose.interpretations() built the sentence for a rule that fired without
 * deciding since 0.10.0, the engine attached it, and no surface emitted it:
 * the serializer had no line, the schema no field, the read path nothing.
 * This drives one evaluation — a $1.33 trace at the shipped defaults — and
 * reads it back through the four surfaces: the tool, the resource, the two
 * routes. Each must carry the sentence naming cost_under_threshold and
 * eval.defaultsGate. A row written before provenance carried the composer
 * facts reads back with no sentences and none fabricated. And the key set
 * of the engine's result must be a subset of the serialized response's,
 * minus the fields a response must never carry.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { createLogger } from '../../src/utils/logger.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { toEvaluationResponse } from '../../src/eval/response.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { EvalResult, Interpretation } from '../../src/types/eval.js';

const LONG = 'A fine answer that is long enough to pass the length floor, in two sentences. It says something concrete.';
type Item = { type: string; text?: string; uri?: string };
const textOf = (r: { content?: unknown }) => (r.content as Item[]).find((c) => c.type === 'text')!.text!;
const costNote = (list: Interpretation[] | undefined) => list?.find((i) => i.rule === 'cost_under_threshold' && i.configKey === 'eval.defaultsGate');

/** Fields the engine's result carries that a response must never: the texts (stored, never echoed) and the storage-only columns. */
const NEVER_ON_THE_WIRE = new Set(['output_text', 'expected_text', 'created_at', 'eval_cost_usd', 'eval_tokens']);

describe('the interpretations reach every surface', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;
  let server: Server;
  let port = 0;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-interp-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const iris = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await iris.mcpServer.connect(serverTransport);
    client = new Client({ name: 'interp', version: '0.1.0' });
    await client.connect(clientTransport);
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    server = createDashboardServer(storage, config, createLogger(config), { evalEngine }).start();
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  it('the tool, the resource and both routes carry the sentence for a rule that fired without deciding', async () => {
    const logged = JSON.parse(textOf(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'costly', input: 'What is 2+2?', output: LONG, cost_usd: 1.33 } }))) as { trace_id: string };
    const viaTool = JSON.parse(textOf(await client.callTool({ name: 'evaluate_output', arguments: { output: LONG, input: 'What is 2+2?', cost_usd: 1.33, trace_id: logged.trace_id } }))) as { id: string; passed: boolean; interpretations?: Interpretation[] };
    expect(viaTool.passed).toBe(true);
    expect(costNote(viaTool.interpretations), 'the tool').toBeDefined();
    // the agent-addressed note: no tool calls were supplied, so the trajectory questions were not judged
    expect(viaTool.interpretations!.some((i) => i.addressee === 'agent' && i.text.includes('not judged')), 'the agent-addressed note').toBe(true);

    const viaResource = JSON.parse((await client.readResource({ uri: `iris://evaluations/${viaTool.id}` })).contents[0].text as string) as { interpretations?: Interpretation[] };
    expect(costNote(viaResource.interpretations), 'the resource').toBeDefined();

    const viaEvals = (await (await fetch(`http://127.0.0.1:${port}/api/v1/evaluations?limit=5`)).json()) as Record<string, unknown> | EvalResult[];
    // The route returns its query result envelope; the list is its array-valued member.
    const list = (Array.isArray(viaEvals) ? viaEvals : (Object.values(viaEvals).find((v) => Array.isArray(v)) as EvalResult[] | undefined) ?? []) as EvalResult[];
    const row = list.find((e) => e.id === viaTool.id)!;
    expect(row, 'GET /api/v1/evaluations lists the row').toBeDefined();
    expect(costNote(row.interpretations), 'GET /api/v1/evaluations').toBeDefined();

    const viaTrace = (await (await fetch(`http://127.0.0.1:${port}/api/v1/traces/${logged.trace_id}`)).json()) as { evals: EvalResult[] };
    expect(costNote(viaTrace.evals.find((e) => e.id === viaTool.id)?.interpretations), 'GET /api/v1/traces/:id').toBeDefined();
  });

  it('a row written before provenance carried the composer facts reads back with no sentences and none fabricated', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const result = await engine.evaluateAll({ output: LONG, costUsd: 1.33 });
    delete result.provenance!.composer; // a 0.9.0–0.12.x row
    delete result.interpretations;
    await storage.insertEvalResult(LOCAL_TENANT, result);
    const back = await storage.getEvalById(LOCAL_TENANT, result.id);
    expect(back!.verdict, 'the verdict still derives under the defaults').toBeDefined();
    expect(back!.interpretations).toBeUndefined();
    expect(back!.provenance!.composer).toBeUndefined();
  });

  it('nothing the engine attaches is dropped by the serializer (invariant 13)', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const result = await engine.evaluateAll({ output: LONG, input: 'What is 2+2?', costUsd: 1.33 });
    const response = toEvaluationResponse(result);
    const dropped = Object.keys(result).filter((k) => !(k in response) && !NEVER_ON_THE_WIRE.has(k));
    expect(dropped).toEqual([]);
    expect(Object.keys(result)).toContain('interpretations'); // the floor: the engine attached them on this input
  });
});
