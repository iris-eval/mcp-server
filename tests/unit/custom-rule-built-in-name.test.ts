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
import { builtInRuleNames, builtInRules } from '../../src/eval/criticality.js';
import { builtInNameKept, builtInNameNotEnabled, builtInNameRefusal, isBuiltInRuleName } from '../../src/eval/built-in-names.js';
import { buildLocalLabelSource, refreshLocalLabels } from '../../src/eval/local-labels.js';
import { keepInStep } from '../../src/eval/shared-state.js';
import { registerRuleRoutes } from '../../src/dashboard/routes/rules.js';
import { registerLabelRoutes } from '../../src/dashboard/routes/labels.js';
import { createTenantMiddleware } from '../../src/middleware/tenant.js';
import { runIngest } from '../../src/cli/ingest.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { CustomRuleDefinition } from '../../src/types/eval.js';
import { textOf } from '../helpers/mcp-results.js';
import { up } from '../../src/storage/migrations/024-label-row-origin.js';
import { toolGuide } from '../../src/tools/guide.js';

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
async function server(): Promise<{ client: Client; rules: CustomRuleStore; storage: SqliteAdapter }> {
  const storage = await sqlite();
  const rules = ruleStore();
  const { mcpServer } = createIrisServer(defaultConfig, storage, rules);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'built-in-name', version: '0.1.0' });
  await client.connect(clientTransport);
  closers.unshift(() => client.close());
  await client.listTools();
  return { client, rules, storage };
}

/** How many evaluations the store holds. */
const storedCount = async (storage: SqliteAdapter): Promise<number> => (await storage.queryEvalResults(LOCAL_TENANT, { limit: 100 })).results.length;

/** The envelope of an error a tool answered. */
function envelope(result: unknown): { code: string; message: string; field?: string; recovery: string[] } {
  const r = result as { isError?: boolean };
  expect(r.isError).toBe(true);
  return (JSON.parse(textOf(result as Parameters<typeof textOf>[0])) as { error: { code: string; message: string; field?: string; recovery: string[] } }).error;
}

async function call(app: express.Express, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
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
    expect(builtInNameNotEnabled({ id: 'rule-1a2b', name: 'no_pii' })).toBe(
      'The custom rule "no_pii" (rule-1a2b) carries the name of a rule Iris ships, and a custom rule may not take it, so it stays paused: the two would carry one name in every result. Deploy it again under a name of its own, then delete this one.',
    );
  });
});

describe('each door a custom rule comes in by refuses the name of a rule Iris ships', () => {
  it('deploy_rule: an error naming the rule, and nothing deployed', async () => {
    const { client, rules } = await server();
    const refused = envelope(await client.callTool({ name: 'deploy_rule', arguments: { name: 'no_pii', eval_type: 'custom', definition: FIRES_ON_A_STUB } }));
    expect(refused).toMatchObject({ code: 'IRIS_INVALID_ARGUMENT', field: 'name', retryable: false });
    expect(refused.message).toBe(`${builtInNameRefusal(['no_pii'])} Nothing was deployed.`);
    expect(refused.recovery).toEqual(['Deploy the rule under a name of its own: list_rules lists the rules Iris ships under built_in.']);
    expect(rules.list(LOCAL_TENANT)).toEqual([]);
    // A name of its own is deployed as before.
    const deployed = await client.callTool({ name: 'deploy_rule', arguments: { name: 'no_stub_text', eval_type: 'custom', definition: FIRES_ON_A_STUB } });
    expect((deployed as { isError?: boolean }).isError).toBeFalsy();
    expect(rules.list(LOCAL_TENANT).map((r) => r.name)).toEqual(['no_stub_text']);
  });

  it('deploy_rule refuses it with replace: true as well, and a rule stored under that name by an earlier version is kept, not replaced', async () => {
    const { client, rules } = await server();
    const earlier = rules.deploy(LOCAL_TENANT, { name: 'max_steps', evalType: 'cost', definition: { name: 'max_steps', ...FIRES_ON_A_STUB } });
    const refused = envelope(await client.callTool({ name: 'deploy_rule', arguments: { name: 'max_steps', eval_type: 'cost', definition: FIRES_ON_A_STUB, replace: true } }));
    expect(refused).toMatchObject({ code: 'IRIS_INVALID_ARGUMENT', field: 'name' });
    expect(rules.list(LOCAL_TENANT).map((r) => r.id)).toEqual([earlier.id]);
  });

  it("evaluate_output's inline rules: an error naming each, and nothing evaluated or stored", async () => {
    const { client, storage } = await server();
    const refused = envelope(
      await client.callTool({
        name: 'evaluate_output',
        arguments: { ...STUB, custom_rules: [{ name: 'answers_the_ask', ...FIRES_ON_A_STUB }, { name: 'no_stub_text', ...FIRES_ON_A_STUB }, { name: 'no_pii', ...FIRES_ON_A_STUB }, { name: 'no_pii', ...FIRES_ON_A_STUB }] },
      }),
    );
    expect(refused).toMatchObject({ code: 'IRIS_INVALID_ARGUMENT', field: 'custom_rules', retryable: false });
    expect(refused.message).toBe(`${builtInNameRefusal(['answers_the_ask', 'no_pii'])} Nothing was evaluated.`);
    expect(refused.recovery).toEqual(['Send each custom_rules entry under a name of its own: list_rules lists the rules Iris ships under built_in.']);
    expect(await storedCount(storage)).toBe(0);
    // Inline rules of names of their own are evaluated as before.
    const answered = await client.callTool({ name: 'evaluate_output', arguments: { ...STUB, custom_rules: [{ name: 'no_stub_text', ...FIRES_ON_A_STUB }] } });
    expect((answered as { isError?: boolean }).isError).toBeFalsy();
    const rows = (JSON.parse(textOf(answered as Parameters<typeof textOf>[0])) as { rule_results: Array<{ ruleName: string; passed: boolean; origin?: string }> }).rule_results;
    expect(rows.filter((r) => r.ruleName === 'no_stub_text')).toEqual([expect.objectContaining({ passed: false, origin: 'custom' })]);
    expect(await storedCount(storage)).toBe(1);
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
    // With replace: true over a rule an earlier version stored under the name: refused, and the stored rule kept.
    const earlier = rules.deploy(LOCAL_TENANT, { name: 'max_steps', evalType: 'cost', definition: { name: 'max_steps', ...FIRES_ON_A_STUB } });
    expect((await call(app, 'POST', '/api/v1/rules/custom', { name: 'max_steps', evalType: 'cost', definition: FIRES_ON_A_STUB, replace: true })).status).toBe(409);
    expect(rules.list(LOCAL_TENANT).filter((r) => r.name === 'max_steps').map((r) => r.id)).toEqual([earlier.id]);
  });
});

describe('a rule stored under such a name before the doors refused it keeps running, and the server says so', () => {
  it('the server says so once when it starts, naming the rule that runs, and says nothing of a rule of a name of its own or of one that is paused', async () => {
    const rules = ruleStore();
    const kept = rules.deploy(LOCAL_TENANT, { name: 'no_pii', evalType: 'safety', definition: { name: 'no_pii', ...FIRES_ON_A_STUB } });
    rules.deploy(LOCAL_TENANT, { name: 'no_stub_text', evalType: 'custom', definition: { name: 'no_stub_text', ...FIRES_ON_A_STUB } });
    const paused = rules.deploy(LOCAL_TENANT, { name: 'max_steps', evalType: 'cost', definition: { name: 'max_steps', ...FIRES_ON_A_STUB } });
    rules.setEnabled(LOCAL_TENANT, paused.id, false);
    const said: string[] = [];
    createIrisServer(defaultConfig, await sqlite(), rules, { warn: (line) => said.push(line) });
    expect(said.filter((line) => line.includes('carries the name of a rule Iris ships'))).toEqual([builtInNameKept(kept)]);
  });

  it('iris-eval ingest says so too, on its own stream: once, of the rule that runs, and of no paused one', async () => {
    const saved = { home: process.env.IRIS_HOME, db: process.env.IRIS_DB_PATH };
    const home = mkdtempSync(join(tmpdir(), 'iris-built-in-name-ingest-'));
    dirs.push(home);
    process.env.IRIS_HOME = home;
    process.env.IRIS_DB_PATH = join(home, 'iris.db');
    try {
      const store = createCustomRuleStore();
      const kept = store.deploy(LOCAL_TENANT, { name: 'no_stub_output', evalType: 'completeness', definition: { name: 'no_stub_output', ...FIRES_ON_A_STUB } });
      store.deploy(LOCAL_TENANT, { name: 'no_stub_text', evalType: 'custom', definition: { name: 'no_stub_text', ...FIRES_ON_A_STUB } });
      const paused = store.deploy(LOCAL_TENANT, { name: 'max_steps', evalType: 'cost', definition: { name: 'max_steps', ...FIRES_ON_A_STUB } });
      store.setEnabled(LOCAL_TENANT, paused.id, false);
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
      // Once, and of that rule alone.
      expect(err.split(/\r?\n/).filter((line) => line.includes('carries the name of a rule Iris ships'))).toEqual([builtInNameKept(kept)]);
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
    expect(builtInNameKept(stored)).toBe(
      `The deployed custom rule "no_stub_output" (${stored.id}) carries the name of a rule Iris ships. It keeps running, and the two share one name in every result. ` +
        `Deploy it again under a name of its own and delete this one (delete_rule with rule_id "${stored.id}"); a label on its fires cannot be written, so that none weighs the rule Iris ships.`,
    );
  });

  it('once paused, delete_rule does not turn it back on; it pauses, and turns on a rule of a name of its own, as before', async () => {
    const { client, rules } = await server();
    const stored = rules.deploy(LOCAL_TENANT, { name: 'no_pii', evalType: 'safety', definition: { name: 'no_pii', ...FIRES_ON_A_STUB } });
    const own = rules.deploy(LOCAL_TENANT, { name: 'no_stub_text', evalType: 'custom', definition: { name: 'no_stub_text', ...FIRES_ON_A_STUB } });
    // Turning on a rule that is already on answers as before: it was running, and keeps running.
    expect(await client.callTool({ name: 'delete_rule', arguments: { rule_id: stored.id, enabled: true } })).toMatchObject({ structuredContent: { toggled: true, enabled: true } });
    expect(await client.callTool({ name: 'delete_rule', arguments: { rule_id: stored.id, enabled: false } })).toMatchObject({ structuredContent: { toggled: true, enabled: false } });
    const refused = envelope(await client.callTool({ name: 'delete_rule', arguments: { rule_id: stored.id, enabled: true } }));
    expect(refused).toMatchObject({ code: 'IRIS_INVALID_ARGUMENT', field: 'enabled', message: builtInNameNotEnabled(stored), retryable: false });
    expect(refused.recovery).toEqual(['Deploy the rule again under a name of its own (deploy_rule), then delete this one (delete_rule without enabled).']);
    expect(rules.get(LOCAL_TENANT, stored.id)?.enabled).toBe(false);
    await client.callTool({ name: 'delete_rule', arguments: { rule_id: own.id, enabled: false } });
    expect(await client.callTool({ name: 'delete_rule', arguments: { rule_id: own.id, enabled: true } })).toMatchObject({ structuredContent: { toggled: true, enabled: true } });
    // And it can still be deleted.
    expect(await client.callTool({ name: 'delete_rule', arguments: { rule_id: stored.id } })).toMatchObject({ structuredContent: { deleted: true } });
  });

  it("once paused, the rules API's toggle does not turn it back on: 409, and the rule stays paused", async () => {
    const rules = ruleStore();
    const engine = new EvalEngine(0.7);
    const app = express();
    app.use(express.json());
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerRuleRoutes(router, (await sqlite()) as never, { customRuleStore: rules, evalEngine: engine });
    app.use('/api/v1', router);
    const stored = rules.deploy(LOCAL_TENANT, { name: 'no_tool_loop', evalType: 'cost', definition: { name: 'no_tool_loop', ...FIRES_ON_A_STUB } });
    const own = rules.deploy(LOCAL_TENANT, { name: 'no_loop_text', evalType: 'cost', definition: { name: 'no_loop_text', ...FIRES_ON_A_STUB } });
    expect((await call(app, 'PATCH', `/api/v1/rules/custom/${stored.id}`, { enabled: true })).status).toBe(200);
    expect((await call(app, 'PATCH', `/api/v1/rules/custom/${stored.id}`, { enabled: false })).status).toBe(200);
    const refused = await call(app, 'PATCH', `/api/v1/rules/custom/${stored.id}`, { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(builtInNameNotEnabled(stored));
    expect(rules.get(LOCAL_TENANT, stored.id)?.enabled).toBe(false);
    expect(engine.hasRule(stored.id)).toBe(false);
    expect((await call(app, 'PATCH', `/api/v1/rules/custom/${own.id}`, { enabled: false })).status).toBe(200);
    expect((await call(app, 'PATCH', `/api/v1/rules/custom/${own.id}`, { enabled: true })).status).toBe(200);
    expect(engine.hasRule(own.id)).toBe(true);
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
    expect(refused.body.error).toBe("The first row named no_stub_output on this evaluation is a custom rule's, and a label under the name of a rule Iris ships weighs that rule, so it cannot be written here.");
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

describe("whose row a label stands on is kept with the label, and read where the evaluation is gone", () => {
  const raw = (store: SqliteAdapter) => (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): Record<string, unknown> | undefined; all(...a: unknown[]): Array<Record<string, unknown>> }; exec(sql: string): void } }).db;
  async function labels(): Promise<{ store: SqliteAdapter; engine: EvalEngine; app: express.Express }> {
    const store = await sqlite();
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const app = express();
    app.use(express.json());
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerLabelRoutes(router, store, { evalEngine: engine });
    app.use('/api/v1', router);
    return { store, engine, app };
  }
  /** A stored evaluation whose first row named no_stub_output is a custom rule's fire, as an earlier version stored it. */
  async function customRow(store: SqliteAdapter, engine: EvalEngine, rewrite?: (rows: Array<Record<string, unknown>>) => unknown): Promise<string> {
    const result = await engine.evaluate('custom', { ...STUB }, [{ name: 'no_stub_output', ...FIRES_ON_A_STUB }]);
    await store.insertEvalResult(LOCAL_TENANT, result);
    if (rewrite) raw(store).prepare('UPDATE eval_results SET rule_results = ? WHERE id = ?').run(JSON.stringify(rewrite(result.rule_results as unknown as Array<Record<string, unknown>>)), result.id);
    return result.id;
  }
  const deleteEvaluations = (store: SqliteAdapter): void => void raw(store).prepare("UPDATE eval_results SET created_at = '2020-01-01T00:00:00.000Z'").run();

  it("a label written through the route keeps whose row it was: none for the row of the rule Iris ships, custom for a custom rule of a name of its own; both are counted after the retention sweep deletes the evaluation", async () => {
    const { store, engine, app } = await labels();
    const both = await engine.evaluateAll({ ...STUB }, [{ name: 'no_stub_text', ...FIRES_ON_A_STUB }]);
    await store.insertEvalResult(LOCAL_TENANT, both);
    expect((await call(app, 'POST', '/api/v1/labels', { eval_id: both.id, rule: 'no_stub_output', label: 'right' })).status).toBe(201);
    expect((await call(app, 'POST', '/api/v1/labels', { eval_id: both.id, rule: 'no_stub_text', label: 'wrong' })).status).toBe(201);
    expect(raw(store).prepare('SELECT rule_name, row_origin FROM verdict_labels ORDER BY rule_name').all()).toEqual([
      { rule_name: 'no_stub_output', row_origin: null },
      { rule_name: 'no_stub_text', row_origin: 'custom' },
    ]);
    deleteEvaluations(store);
    expect(await store.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(1);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([
      { ruleName: 'no_stub_output', right: 1, wrong: 0 },
      { ruleName: 'no_stub_text', right: 0, wrong: 1 },
    ]);
  });

  it('labels an earlier version wrote on a custom rule\'s fires are given their row at upgrade, and stay out of the tally after the sweep and after a purge', async () => {
    const { store, engine } = await labels();
    for (let i = 0; i < 20; i += 1) {
      const evalId = await customRow(store, engine);
      raw(store).prepare("INSERT INTO verdict_labels (id, tenant_id, eval_id, rule_name, label, note, labelled_at) VALUES (?, 'local', ?, 'no_stub_output', 'wrong', NULL, datetime('now'))").run(`label-${i}`, evalId);
    }
    // As an earlier version left them: no row kept with the label. The migration fills it once, from each stored evaluation.
    raw(store).prepare('UPDATE verdict_labels SET row_origin = NULL').run();
    up(raw(store) as never);
    expect(raw(store).prepare("SELECT COUNT(*) AS n FROM verdict_labels WHERE row_origin = 'custom'").get()).toEqual({ n: 20 });
    deleteEvaluations(store);
    expect(await store.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(20);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([]);
    await refreshLocalLabels(engine, store, LOCAL_TENANT);
    expect((await engine.evaluateAll({ ...STUB })).verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    // A purge keeps labels too; they stay out.
    await store.purge(LOCAL_TENANT);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([]);
  });

  it("a label that keeps no row (one a release older than this one wrote after the upgrade) is read from its evaluation while it is held, and counted once it is gone (#1072)", async () => {
    const { store, engine } = await labels();
    const evalId = await customRow(store, engine);
    raw(store).prepare("INSERT INTO verdict_labels (id, tenant_id, eval_id, rule_name, label, note, labelled_at) VALUES ('older', 'local', ?, 'no_stub_output', 'wrong', NULL, datetime('now'))").run(evalId);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([]);
    deleteEvaluations(store);
    await store.deleteEvalResultsOlderThan(LOCAL_TENANT, 30);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([{ ruleName: 'no_stub_output', right: 0, wrong: 1 }]);
  });

  it("a custom rule's row stored before rows carried their origin is told by the deployed rule's id: the route refuses the label, and the tally leaves out one written before", async () => {
    const { store, engine, app } = await labels();
    const older = (rows: Array<Record<string, unknown>>) => rows.map((r) => (r.ruleName === 'no_stub_output' ? { ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'origin')), ruleId: 'rule-0a1b2c' } : r));
    const evalId = await customRow(store, engine, older);
    const refused = await call(app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'wrong' });
    expect(refused.status).toBe(400);
    raw(store).prepare("INSERT INTO verdict_labels (id, tenant_id, eval_id, rule_name, label, note, labelled_at) VALUES ('before', 'local', ?, 'no_stub_output', 'wrong', NULL, datetime('now'))").run(evalId);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([]);
  });

  it("a quiet custom row under a shipped name is told it is a custom rule's, not that it did not fire; and where the rule Iris ships has a row after it, the sentence says so", async () => {
    const { store, engine, app } = await labels();
    const quiet = await engine.evaluate('custom', { output: 'All done.' }, [{ name: 'no_stub_output', ...FIRES_ON_A_STUB }]);
    await store.insertEvalResult(LOCAL_TENANT, quiet);
    expect((await call(app, 'POST', '/api/v1/labels', { eval_id: quiet.id, rule: 'no_stub_output', label: 'right' })).body.error).toBe(
      "The first row named no_stub_output on this evaluation is a custom rule's, and a label under the name of a rule Iris ships weighs that rule, so it cannot be written here.",
    );
    const rules = ruleStore();
    rules.deploy(LOCAL_TENANT, { name: 'no_stub_output', evalType: 'completeness', definition: { name: 'no_stub_output', ...FIRES_ON_A_STUB } });
    const first = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    keepInStep(first, rules, store, LOCAL_TENANT)();
    const ranBoth = await first.evaluateAll({ ...STUB });
    expect(ranBoth.rule_results.filter((r) => r.ruleName === 'no_stub_output').map((r) => r.origin ?? 'built-in')).toEqual(['custom', 'built-in']);
    await store.insertEvalResult(LOCAL_TENANT, ranBoth);
    expect((await call(app, 'POST', '/api/v1/labels', { eval_id: ranBoth.id, rule: 'no_stub_output', label: 'right' })).body.error).toBe(
      "The first row named no_stub_output on this evaluation is a custom rule's, and a label under the name of a rule Iris ships weighs that rule, so it cannot be written here. The rule Iris ships has a row of that name on this evaluation too, after the custom rule's, and a label for it cannot be written on this evaluation.",
    );
  });

  it("the refusal's second sentence is said where a row of the rule Iris ships follows the custom one, fired or not, and only there", async () => {
    const { store, engine, app } = await labels();
    const custom = { ruleName: 'no_stub_output', passed: false, score: 0, message: 'fired', origin: 'custom' };
    const shipped = { ruleName: 'no_stub_output', passed: false, score: 0, message: 'fired' };
    const first = "The first row named no_stub_output on this evaluation is a custom rule's, and a label under the name of a rule Iris ships weighs that rule, so it cannot be written here.";
    const second = " The rule Iris ships has a row of that name on this evaluation too, after the custom rule's, and a label for it cannot be written on this evaluation.";
    const cases: Array<[string, unknown[], string]> = [
      ['a custom fire, then the shipped rule quiet', [custom, { ...shipped, passed: true, score: 1, message: 'ok' }], first + second],
      ['a quiet custom row, then the shipped rule quiet', [{ ...custom, passed: true, score: 1 }, { ...shipped, passed: true, score: 1 }], first + second],
      ['a custom fire, then the shipped rule not judged', [custom, { ...shipped, skipped: true, skipClass: 'not_applicable' }], first + second],
      // A row older than origin that carries a deployed rule's id is a custom rule's too, not the shipped rule's.
      ['a custom fire, then a custom row older than origin', [custom, { ruleName: 'no_stub_output', passed: false, score: 0, message: 'fired', ruleId: 'rule-0a1b2c' }], first],
      ['a custom fire, and the shipped row of another name', [custom, { ...shipped, ruleName: 'no_pii' }], first],
    ];
    for (const [what, rows, error] of cases) {
      const evalId = await customRow(store, engine, () => rows);
      expect((await call(app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'right' })).body.error, what).toBe(error);
    }
  });

  it('labels on a custom rule\'s row are left out under the name of every rule Iris ships, not one', async () => {
    const { store, engine } = await labels();
    const names = ['no_pii', 'answers_the_ask', 'max_steps', 'no_tool_loop'];
    for (const [i, name] of names.entries()) {
      const evalId = await customRow(store, engine, () => [{ ruleName: name, passed: false, score: 0, message: 'fired', origin: 'custom' }]);
      raw(store).prepare("INSERT INTO verdict_labels (id, tenant_id, eval_id, rule_name, label, note, labelled_at) VALUES (?, 'local', ?, ?, 'wrong', NULL, datetime('now'))").run(`other-${i}`, evalId, name);
    }
    // Through the source the engine reads, as the server builds it.
    const source = await buildLocalLabelSource(store, LOCAL_TENANT);
    expect(names.filter((name) => source.precision.has(name))).toEqual([]);
    // Counted with no shipped names, they would weigh each rule.
    expect((await store.labelTallies(LOCAL_TENANT)).map((t) => t.ruleName)).toEqual([...names].sort());
  });

  it('the route and the store read a stored row alike: its name as the route reads it, and a ruleId that is null as no id', async () => {
    const { store, engine, app } = await labels();
    const shapes: Array<[string, unknown[], boolean]> = [
      // ruleName that is not text: the row is named by `rule`, as the route's reader names it.
      ['a name under rule beside a ruleName that is not text', [{ ruleName: 5, rule: 'no_stub_output', passed: false, score: 0, message: 'fired', origin: 'custom' }], true],
      // A ruleId of null is no deployed rule's id.
      ['a ruleId of null', [{ ruleName: 'no_stub_output', ruleId: null, passed: false, score: 0, message: 'fired' }], false],
    ];
    for (const [i, [what, rows, custom]] of shapes.entries()) {
      const evalId = await customRow(store, engine, () => rows);
      const answer = await call(app, 'POST', '/api/v1/labels', { eval_id: evalId, rule: 'no_stub_output', label: 'wrong' });
      expect(answer.status === 400 && String(answer.body.error).startsWith('The first row named no_stub_output on this evaluation is a custom rule'), what).toBe(custom);
      raw(store).prepare('DELETE FROM verdict_labels WHERE eval_id = ?').run(evalId);
      raw(store).prepare("INSERT INTO verdict_labels (id, tenant_id, eval_id, rule_name, label, note, labelled_at) VALUES (?, 'local', ?, 'no_stub_output', 'wrong', NULL, datetime('now'))").run(`alike-${i}`, evalId);
      const counted = (await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).find((t) => t.ruleName === 'no_stub_output')?.wrong ?? 0;
      expect(counted === 0, what).toBe(custom);
      raw(store).prepare('DELETE FROM verdict_labels WHERE eval_id = ?').run(evalId);
    }
  });

  it('the tally reads rows by their place, takes any stored shape without failing, and counts a label it cannot place', async () => {
    const { store, engine } = await labels();
    const shipped = { ruleName: 'no_stub_output', passed: false, score: 0, message: 'fired' };
    const custom = { ...shipped, origin: 'custom' };
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ ruleName: `r${i}`, passed: true, score: 1, message: 'ok' }));
    const shapes: Array<[string, unknown, number]> = [
      // The rule Iris ships at place 9 and a custom row at place 10: place 9 comes first.
      ['shipped at 9, custom at 10', [...filler(9), shipped, custom], 1],
      ['custom at 9, shipped at 10', [...filler(9), custom, shipped], 0],
      ['not JSON', 'not json', 1],
      ['a JSON object, not a list', { no_stub_output: custom }, 1],
      ['a list with a string before the custom row', ['a string', custom], 0],
      // A row named by `rule` (a shape of rows written by hand; no release writes it) is read by that name, as the route reads it.
      ['a custom row named by rule', [{ rule: 'no_stub_output', passed: false, score: 0, message: 'fired', origin: 'custom' }], 0],
    ];
    for (const [i, [, rows]] of shapes.entries()) {
      const evalId = await customRow(store, engine);
      raw(store).prepare('UPDATE eval_results SET rule_results = ? WHERE id = ?').run(typeof rows === 'string' ? rows : JSON.stringify(rows), evalId);
      raw(store).prepare("INSERT INTO verdict_labels (id, tenant_id, eval_id, rule_name, label, note, labelled_at) VALUES (?, 'local', ?, 'no_stub_output', 'wrong', NULL, datetime('now'))").run(`shape-${i}`, evalId);
    }
    const counted = shapes.reduce((n, [, , c]) => n + c, 0);
    expect(await store.labelTallies(LOCAL_TENANT, builtInRuleNames())).toEqual([{ ruleName: 'no_stub_output', right: 0, wrong: counted }]);
  });
});

describe('the long form of the tools says the same', () => {
  it('deploy_rule, delete_rule and evaluate_output name the refusal', () => {
    const guide = toolGuide();
    expect(guide.deploy_rule.errors).toContain('IRIS_INVALID_ARGUMENT (field name) when the name is the name of a rule Iris ships, with replace true or false; a rule already deployed under it is kept, and nothing is deployed.');
    expect(guide.deploy_rule.parameters?.replace).toContain('Neither deploys a rule under the name of a rule Iris ships');
    expect(guide.deploy_rule.does).toContain('The name of a rule Iris ships is refused whatever replace says (list_rules lists them under built_in).');
    expect(guide.delete_rule.parameters?.enabled).toContain('true RE-ENABLES a disabled rule, unless it carries the name of a rule Iris ships.');
    expect(guide.delete_rule.errors).toContain('IRIS_INVALID_ARGUMENT (field enabled) for enabled: true on a paused rule stored under the name of a rule Iris ships; it stays paused.');
    expect(guide.delete_rule.does).toContain('A paused rule stored under the name of a rule Iris ships (by an earlier version) is not brought back');
    expect(guide.evaluate_output.errors).toContain('when a custom_rules entry takes the name of a rule Iris ships (field custom_rules, naming each; nothing evaluated or written)');
  });

  it('and so do the descriptions a client lists', async () => {
    const { client } = await server();
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    type Schema = { description?: string; items?: Schema; properties?: Record<string, Schema> };
    const property = (tool: string, name: string): Schema | undefined => (tools.get(tool)?.inputSchema as Schema | undefined)?.properties?.[name];
    expect(tools.get('deploy_rule')?.description).toContain("IRIS_INVALID_ARGUMENT for a built-in rule's name");
    expect(property('deploy_rule', 'name')?.description).toContain('and may not be the name of a rule Iris ships');
    expect(tools.get('delete_rule')?.description).toContain("IRIS_INVALID_ARGUMENT for turning on a paused rule under a built-in rule's name");
    expect(property('evaluate_output', 'custom_rules')?.items?.properties?.name?.description).toBe('Rule name as it will appear in rule_results; not the name of a rule Iris ships');
  });
});
