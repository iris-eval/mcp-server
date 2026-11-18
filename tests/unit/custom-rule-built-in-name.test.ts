/*
 * A custom rule may not take the name of a rule Iris ships.
 *
 * Wherever a result, a sentence or a tally names a rule, a custom rule
 * under a shipped rule's name and the shipped rule are one name: the
 * sentence about one is told of the other, the bundle of one reads with the
 * other, and a label written on the custom rule's fire weighed the shipped
 * rule's fires, so twenty of them could pass an output the shipped rule
 * fails. Each door a custom rule comes in by refuses such a name. A rule
 * stored under one before the doors refused it keeps running, and no label
 * on its fire weighs the rule Iris ships.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { createCustomRuleStore, type CustomRuleStore } from '../../src/custom-rule-store.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { builtInRules } from '../../src/eval/criticality.js';
import { builtInNameKept, builtInNameRefusal, builtInRuleNames, isBuiltInRuleName } from '../../src/eval/built-in-names.js';
import { refreshLocalLabels } from '../../src/eval/local-labels.js';
import { keepInStep } from '../../src/eval/shared-state.js';
import { registerRuleRoutes } from '../../src/dashboard/routes/rules.js';
import { registerLabelRoutes } from '../../src/dashboard/routes/labels.js';
import { createTenantMiddleware } from '../../src/middleware/tenant.js';
import { runIngest } from '../../src/cli/ingest.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { CustomRuleDefinition } from '../../src/types/eval.js';
import { textOf } from '../helpers/mcp-results.js';

const dirs: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  // Close every store first: an open SQLite file cannot be removed on Windows.
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function ruleStore(): CustomRuleStore {
  const dir = mkdtempSync(join(tmpdir(), 'iris-built-in-name-'));
  dirs.push(dir);
  return createCustomRuleStore({ pathFor: () => join(dir, 'custom-rules.json'), auditPath: join(dir, 'audit.log') });
}

async function sqlite(): Promise<SqliteAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-built-in-name-db-'));
  dirs.push(dir);
  const store = new SqliteAdapter(join(dir, 'iris.db'));
  await store.initialize();
  closers.push(() => store.close());
  return store;
}

/** A server built as Iris builds it, asked by a client that has listed the tools. */
async function server(): Promise<{ client: Client; rules: CustomRuleStore }> {
  const storage = await sqlite();
  const rules = ruleStore();
  const { mcpServer } = createIrisServer(defaultConfig, storage, rules);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'built-in-name', version: '0.1.0' });
  await client.connect(clientTransport);
  closers.unshift(() => client.close());
  await client.listTools();
  return { client, rules };
}

/** The envelope of an error a tool answered. */
function envelope(result: unknown): { code: string; message: string; field?: string; recovery: string[] } {
  const r = result as { isError?: boolean };
  expect(r.isError).toBe(true);
  return (JSON.parse(textOf(result as Parameters<typeof textOf>[0])) as { error: { code: string; message: string; field?: string; recovery: string[] } }).error;
}

async function call(app: express.Express, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const listening = app.listen(0);
  const { port } = listening.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    listening.close();
  }
}

const FIRES_ON_A_STUB: Omit<CustomRuleDefinition, 'name'> = { type: 'regex_no_match', config: { pattern: 'write the summary', flags: 'i' } };
const STUB = { output: 'TODO: write the summary.' };

describe('the names of the rules Iris ships', () => {
  it('are every built-in rule name, and no other', () => {
    const shipped = builtInRules().map((r) => r.name);
    expect(builtInRuleNames()).toEqual([...new Set(shipped)].sort());
    for (const name of shipped) expect(isBuiltInRuleName(name), name).toBe(true);
    for (const name of ['no_pii_custom', 'policy', 'NO_PII', ' no_pii', 'no_pii ']) expect(isBuiltInRuleName(name), name).toBe(false);
  });

  it('are refused in a sentence that names each one and says what to do', () => {
    expect(builtInNameRefusal(['no_pii'])).toBe('"no_pii" is the name of a rule Iris ships, and a custom rule may not take it: the two would carry one name in every result. Choose another name.');
    expect(builtInNameRefusal(['no_pii', 'max_steps'])).toBe('"no_pii", "max_steps" are the names of rules Iris ships, and a custom rule may not take one: two rules would carry one name in every result. Choose other names.');
  });
});

describe('each door a custom rule comes in by refuses the name of a rule Iris ships', () => {
  it('deploy_rule: an error naming the rule, and nothing deployed', async () => {
    const { client, rules } = await server();
    const refused = envelope(await client.callTool({ name: 'deploy_rule', arguments: { name: 'no_pii', eval_type: 'custom', definition: FIRES_ON_A_STUB } }));
    expect(refused).toMatchObject({ code: 'IRIS_INVALID_ARGUMENT', field: 'name' });
    expect(refused.message).toBe(`${builtInNameRefusal(['no_pii'])} Nothing was deployed.`);
    expect(refused.recovery.join(' ')).toContain('list_rules lists the rules Iris ships under built_in');
    expect(rules.list(LOCAL_TENANT)).toEqual([]);
    // A name of its own is deployed as before.
    const deployed = await client.callTool({ name: 'deploy_rule', arguments: { name: 'no_stub_text', eval_type: 'custom', definition: FIRES_ON_A_STUB } });
    expect((deployed as { isError?: boolean }).isError).toBeFalsy();
    expect(rules.list(LOCAL_TENANT).map((r) => r.name)).toEqual(['no_stub_text']);
  });

  it('deploy_rule refuses it with replace: true as well, where a deployed rule of that name would have been replaced', async () => {
    const { client, rules } = await server();
    const refused = envelope(await client.callTool({ name: 'deploy_rule', arguments: { name: 'max_steps', eval_type: 'cost', definition: FIRES_ON_A_STUB, replace: true } }));
    expect(refused).toMatchObject({ code: 'IRIS_INVALID_ARGUMENT', field: 'name' });
    expect(rules.list(LOCAL_TENANT)).toEqual([]);
  });

  it("evaluate_output's inline rules: an error naming each, and nothing evaluated", async () => {
    const { client } = await server();
    const refused = envelope(
      await client.callTool({
        name: 'evaluate_output',
        arguments: { ...STUB, custom_rules: [{ name: 'answers_the_ask', ...FIRES_ON_A_STUB }, { name: 'no_stub_text', ...FIRES_ON_A_STUB }, { name: 'no_pii', ...FIRES_ON_A_STUB }, { name: 'no_pii', ...FIRES_ON_A_STUB }] },
      }),
    );
    expect(refused).toMatchObject({ code: 'IRIS_INVALID_ARGUMENT', field: 'custom_rules' });
    expect(refused.message).toBe(`${builtInNameRefusal(['answers_the_ask', 'no_pii'])} Nothing was evaluated.`);
    // Inline rules of names of their own are evaluated as before.
    const answered = await client.callTool({ name: 'evaluate_output', arguments: { ...STUB, custom_rules: [{ name: 'no_stub_text', ...FIRES_ON_A_STUB }] } });
    expect((answered as { isError?: boolean }).isError).toBeFalsy();
    const rows = (JSON.parse(textOf(answered as Parameters<typeof textOf>[0])) as { rule_results: Array<{ ruleName: string; passed: boolean; origin?: string }> }).rule_results;
    expect(rows.filter((r) => r.ruleName === 'no_stub_text')).toEqual([expect.objectContaining({ passed: false, origin: 'custom' })]);
  });

  it('the rules API and its preview: 409, the refusal, and nothing deployed', async () => {
    const rules = ruleStore();
    const app = express();
    app.use(express.json());
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerRuleRoutes(router, (await sqlite()) as never, { customRuleStore: rules, evalEngine: new EvalEngine(0.7) });
    app.use('/api/v1', router);
    const deployed = await call(app, 'POST', '/api/v1/rules/custom', { name: 'no_tool_loop', evalType: 'cost', severity: 'high', definition: FIRES_ON_A_STUB });
    expect(deployed.status).toBe(409);
    expect(deployed.body.error).toBe(`${builtInNameRefusal(['no_tool_loop'])} Nothing was deployed.`);
    expect(rules.list(LOCAL_TENANT)).toEqual([]);
    const previewed = await call(app, 'POST', '/api/v1/rules/custom/preview', { definition: { name: 'no_pii', ...FIRES_ON_A_STUB } });
    expect(previewed.status).toBe(409);
    expect(previewed.body.error).toBe(builtInNameRefusal(['no_pii']));
    // A preview with no name, and a deploy under a name of its own, go through.
    expect((await call(app, 'POST', '/api/v1/rules/custom/preview', { definition: FIRES_ON_A_STUB })).status).toBe(200);
    expect((await call(app, 'POST', '/api/v1/rules/custom', { name: 'no_loop_text', evalType: 'cost', definition: FIRES_ON_A_STUB })).status).toBe(201);
  });
});

describe('a rule stored under such a name before the doors refused it keeps running, and the server says so', () => {
  it('the server says so once when it starts, naming the rule, and says nothing of a rule of a name of its own', async () => {
    const rules = ruleStore();
    const kept = rules.deploy(LOCAL_TENANT, { name: 'no_pii', evalType: 'safety', definition: { name: 'no_pii', ...FIRES_ON_A_STUB } });
    rules.deploy(LOCAL_TENANT, { name: 'no_stub_text', evalType: 'custom', definition: { name: 'no_stub_text', ...FIRES_ON_A_STUB } });
    const said: string[] = [];
    createIrisServer(defaultConfig, await sqlite(), rules, { warn: (line) => said.push(line) });
    expect(said.filter((line) => line.includes('carries the name of a rule Iris ships'))).toEqual([builtInNameKept(kept)]);
  });

  it('iris-eval ingest says so too, on its own stream', async () => {
    const saved = { home: process.env.IRIS_HOME, db: process.env.IRIS_DB_PATH };
    const home = mkdtempSync(join(tmpdir(), 'iris-built-in-name-ingest-'));
    dirs.push(home);
    process.env.IRIS_HOME = home;
    process.env.IRIS_DB_PATH = join(home, 'iris.db');
    try {
      const kept = createCustomRuleStore().deploy(LOCAL_TENANT, { name: 'no_stub_output', evalType: 'completeness', definition: { name: 'no_stub_output', ...FIRES_ON_A_STUB } });
      let err = '';
      const sink = (append: (s: string) => void): Writable => new Writable({ write: (chunk, _enc, cb) => (append(chunk.toString()), cb()) });
      const code = await runIngest({
        cliArgs: {},
        evaluate: true,
        source: 'cli',
        stdin: Readable.from([`${JSON.stringify({ agent_name: 'bot', input: 'Summarise the notes.', output: STUB.output })}\n`]),
        stdout: sink(() => undefined),
        stderr: sink((s) => (err += s)),
      });
      expect(code).toBe(0);
      expect(err).toContain(builtInNameKept(kept));
    } finally {
      if (saved.home === undefined) delete process.env.IRIS_HOME;
      else process.env.IRIS_HOME = saved.home;
      if (saved.db === undefined) delete process.env.IRIS_DB_PATH;
      else process.env.IRIS_DB_PATH = saved.db;
    }
  });

  it('it is registered and fires beside the rule Iris ships, and the start-up line names it and how to rename it', async () => {
    // The store itself takes any name: only the doors refuse, so a file written by an earlier version still loads.
    const rules = ruleStore();
    const stored = rules.deploy(LOCAL_TENANT, { name: 'no_stub_output', evalType: 'completeness', definition: { name: 'no_stub_output', ...FIRES_ON_A_STUB } });
    const engine = new EvalEngine(0.7);
    keepInStep(engine, rules, await sqlite(), LOCAL_TENANT)();
    const rows = (await engine.evaluateAll({ ...STUB })).rule_results.filter((r) => r.ruleName === 'no_stub_output');
    expect(rows.map((r) => r.origin ?? 'built-in').sort()).toEqual(['built-in', 'custom']);
    expect(rows.every((r) => r.passed === false)).toBe(true);
    const line = builtInNameKept(stored);
    expect(line).toContain(`"no_stub_output" (${stored.id}) carries the name of a rule Iris ships. It keeps running`);
    expect(line).toContain(`delete_rule with id "${stored.id}"`);
  });
});

describe('a label under the name of a rule Iris ships is that rule\'s', () => {
  async function labels(): Promise<{ store: SqliteAdapter; engine: EvalEngine; app: express.Express }> {
    const store = await sqlite();
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    await refreshLocalLabels(engine, store, LOCAL_TENANT);
    const app = express();
    app.use(express.json());
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerLabelRoutes(router, store, { evalEngine: engine });
    app.use('/api/v1', router);
    return { store, engine, app };
  }
  /** A stored evaluation whose only row of the name is a custom rule's that fired: a call for the custom bundle, with a rule sent under the name of no_stub_output. */
  async function customRowOnly(store: SqliteAdapter, engine: EvalEngine): Promise<string> {
    const result = await engine.evaluate('custom', { ...STUB }, [{ name: 'no_stub_output', ...FIRES_ON_A_STUB }]);
    expect(result.rule_results.filter((r) => r.ruleName === 'no_stub_output')).toEqual([expect.objectContaining({ origin: 'custom', passed: false })]);
    await store.insertEvalResult(LOCAL_TENANT, result);
    return result.id;
  }

  it('is not written on the fire of a custom rule that carries that name', async () => {
    const { store, engine, app } = await labels();
    const evalId = await customRowOnly(store, engine);
    const refused = await call(app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'wrong' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('no_stub_output on this evaluation is a custom rule that carries the name of a rule Iris ships, and a label under that name weighs the rule Iris ships, so it cannot be labelled. Deploy the custom rule under a name of its own.');
    expect(await store.getLabelsForEval(LOCAL_TENANT, evalId)).toEqual([]);
  });

  it("is written on the rule Iris ships when its row comes first, and a custom rule of a name of its own is labelled as before", async () => {
    const { store, engine, app } = await labels();
    const both = await engine.evaluateAll({ ...STUB }, [{ name: 'no_stub_output', ...FIRES_ON_A_STUB }, { name: 'no_stub_text', ...FIRES_ON_A_STUB }]);
    const named = both.rule_results.filter((r) => r.ruleName === 'no_stub_output');
    expect((named[0].origin ?? 'built-in') !== 'custom' && named[0].passed === false).toBe(true);
    await store.insertEvalResult(LOCAL_TENANT, both);
    expect((await call(app, 'POST', '/api/v1/labels', { eval_id: both.id, rule: 'no_stub_output', label: 'right' })).status).toBe(201);
    expect((await call(app, 'POST', '/api/v1/labels', { eval_id: both.id, rule: 'no_stub_text', label: 'wrong' })).status).toBe(201);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([
      { ruleName: 'no_stub_output', right: 1, wrong: 0 },
      { ruleName: 'no_stub_text', right: 0, wrong: 1 },
    ]);
  });

  it('labels stored on such a fire before are left out of the tally, so they no longer pass an output the rule Iris ships fails', async () => {
    const { store, engine } = await labels();
    // Twenty labels calling the custom rule's fires wrong, stored as an earlier version wrote them.
    for (let i = 0; i < 20; i += 1) {
      const evalId = await customRowOnly(store, engine);
      await store.insertVerdictLabel(LOCAL_TENANT, { id: `label-${i}`, evalId, ruleName: 'no_stub_output', label: 'wrong', note: null });
    }
    // Counted as an earlier version counted them, they weigh the rule Iris ships, and the unfilled template passes.
    expect(await store.labelTallies(LOCAL_TENANT)).toEqual([{ ruleName: 'no_stub_output', right: 0, wrong: 20 }]);
    // Counted under the rule Iris ships, they are not that rule's, and are left out.
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([]);
    await refreshLocalLabels(engine, store, LOCAL_TENANT);
    const template = await engine.evaluateAll({ ...STUB });
    expect(template.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    expect(template.rule_results.find((r) => r.ruleName === 'no_stub_output')?.uncertainty?.basis).toBe('published_accuracy');
  });
});
