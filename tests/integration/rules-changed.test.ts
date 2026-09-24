/*
 * A verdict produced under rules that changed while the server ran says so.
 *
 * An agent with deploy_rule and delete_rule can shape the rules it is then
 * judged by. Every change is in the audit log (iris://audit); this pins
 * that the verdict itself points there — `rules_changed` with the count,
 * the time of the last change and the audit resource — and that the field
 * is only a pointer: passed, score and the verdict are what they would be
 * without it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { evaluateOutputResponseSchema } from '../../src/eval/response-schema.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createLogger } from '../../src/utils/logger.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { irisHome } from '../../src/utils/iris-home.js';

type Result = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
const body = (r: unknown) => JSON.parse((r as Result).content!.find((c) => c.type === 'text')!.text!) as Record<string, unknown>;

const OUTPUT = 'The invoice was sent on Tuesday and the customer confirmed receipt the same afternoon.';
const INPUT = 'Was the invoice sent?';

describe('rules_changed on a verdict', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let dir: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    dir = mkdtempSync(join(tmpdir(), 'iris-rules-changed-'));
    const store = createCustomRuleStore({ pathFor: () => join(dir, 'custom-rules.json'), auditPath: join(dir, 'audit.log') });
    const server = createIrisServer(defaultConfig, storage, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(serverTransport);
    client = new Client({ name: 'rules-changed', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const evaluate = async () => body(await client.callTool({ name: 'evaluate_output', arguments: { output: OUTPUT, input: INPUT } }));

  it('is absent while the deployed rules are the ones the server started with', async () => {
    expect(await evaluate()).not.toHaveProperty('rules_changed');
  });

  it('counts each deploy and toggle, names the audit resource, and leaves the verdict alone', async () => {
    const before = await evaluate();

    const deployed = body(
      await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'always-long-enough', eval_type: 'completeness', definition: { type: 'min_length', config: { min_length: 1 } } },
      }),
    );
    const ruleId = (deployed.rule as { id: string }).id;
    // Disable it again: the rules that run are the starting set, so the
    // verdict must match `before` exactly — only the pointer is new.
    await client.callTool({ name: 'delete_rule', arguments: { rule_id: ruleId, enabled: false } });

    const after = await evaluate();
    const changed = after.rules_changed as { count: number; last_change_at: string; since: string; audit: string };
    expect(changed.count).toBe(2);
    expect(changed.audit).toBe('iris://audit');
    expect(Date.parse(changed.last_change_at)).toBeGreaterThanOrEqual(Date.parse(changed.since));

    expect(after.passed).toBe(before.passed);
    expect(after.score).toBe(before.score);
    expect(after.verdict).toEqual(before.verdict);
    expect((after.rule_results as Array<{ ruleName: string }>).map((r) => r.ruleName)).toEqual(
      (before.rule_results as Array<{ ruleName: string }>).map((r) => r.ruleName),
    );
    expect(evaluateOutputResponseSchema.safeParse(after).success).toBe(true);

    // The pointer resolves: the audit resource carries both changes.
    const audit = await client.readResource({ uri: 'iris://audit' });
    const auditText = (audit.contents[0] as { text: string }).text;
    expect(auditText).toContain('rule.deploy');
    expect(auditText).toContain('rule.toggle');
  });

  it('reaches log_trace with evaluate: true, the same verdict path', async () => {
    const deployed = body(
      await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'short-rule', eval_type: 'completeness', definition: { type: 'min_length', config: { min_length: 1 } } },
      }),
    );
    await client.callTool({ name: 'delete_rule', arguments: { rule_id: (deployed.rule as { id: string }).id } });
    const logged = body(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', input: INPUT, output: OUTPUT, evaluate: true } }));
    expect((logged.evaluation as { rules_changed?: { count: number } }).rules_changed?.count).toBe(2);
  });

  it('reaches POST /api/v1/traces with evaluate: true on the dashboard sharing the store', async () => {
    const store = createCustomRuleStore({ pathFor: () => join(dir, 'http-rules.json'), auditPath: join(dir, 'http-audit.log') });
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    const server = createDashboardServer(storage, config, createLogger(config), { evalEngine: engine, customRuleStore: store }).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = (server.address() as { port: number }).port;
    const post = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_name: 'a', input: INPUT, output: OUTPUT, evaluate: true }),
      });
      return (await res.json()) as { evaluation: Record<string, unknown> };
    };
    try {
      expect((await post()).evaluation).not.toHaveProperty('rules_changed');
      store.deploy(LOCAL_TENANT, {
        name: 'r',
        evalType: 'completeness',
        definition: { name: 'r', type: 'min_length', config: { min_length: 1 } },
      } as Parameters<typeof store.deploy>[1]);
      expect((await post()).evaluation.rules_changed).toMatchObject({ count: 1, audit: 'iris://audit' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('is not written onto the stored evaluation: a later read shows what was judged, not when', async () => {
    await client.callTool({
      name: 'deploy_rule',
      arguments: { name: 'r', eval_type: 'completeness', definition: { type: 'min_length', config: { min_length: 1 } } },
    });
    const evaluated = await evaluate();
    expect(evaluated).toHaveProperty('rules_changed');
    const read = await client.readResource({ uri: `iris://evaluations/${evaluated.id as string}` });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).not.toHaveProperty('rules_changed');
  });

  it('reaches evaluate_runs: a re-score under changed rules says so', async () => {
    for (let i = 0; i < 2; i++) {
      await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', input: INPUT, output: OUTPUT, run: 'nightly' } });
    }
    const unchanged = body(await client.callTool({ name: 'evaluate_runs', arguments: { run: 'nightly', into: 'nightly-a' } }));
    expect(unchanged).not.toHaveProperty('rules_changed');

    await client.callTool({
      name: 'deploy_rule',
      arguments: { name: 'r', eval_type: 'completeness', definition: { type: 'min_length', config: { min_length: 1 } } },
    });
    const changed = body(await client.callTool({ name: 'evaluate_runs', arguments: { run: 'nightly', into: 'nightly-b' } }));
    expect(changed.rules_changed).toMatchObject({ count: 1, audit: 'iris://audit' });
    expect(changed.evaluated).toBe(2);
  });
});

describe('delete_trace writes to the rule store audit log', () => {
  it('lands in the file iris://audit reads, not the default log', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const dir = mkdtempSync(join(tmpdir(), 'iris-delete-audit-'));
    const auditPath = join(dir, 'demo-audit.log');
    const store = createCustomRuleStore({ pathFor: () => join(dir, 'rules.json'), auditPath });
    const server = createIrisServer(defaultConfig, storage, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(serverTransport);
    const client = new Client({ name: 'delete-audit', version: '0.1.0' });
    await client.connect(clientTransport);
    const defaultLog = join(irisHome(), 'audit.log');
    try {
      const logged = body(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', output: OUTPUT } }));
      const traceId = logged.trace_id as string;
      expect(body(await client.callTool({ name: 'delete_trace', arguments: { trace_id: traceId } })).deleted).toBe(true);

      expect(readFileSync(auditPath, 'utf-8')).toContain(traceId);
      if (existsSync(defaultLog)) expect(readFileSync(defaultLog, 'utf-8')).not.toContain(traceId);
      const audit = await client.readResource({ uri: 'iris://audit' });
      expect((audit.contents[0] as { text: string }).text).toContain(traceId);
    } finally {
      await client.close();
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
