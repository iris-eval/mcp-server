/*
 * The webhook reaches every door (arc 9, N-16): installed on the store,
 * it fires for an evaluation written by `evaluate_output`, by `log_trace`
 * with `evaluate`, and by `POST /api/v1/traces` with `evaluate` — without
 * any of them knowing — and never delays the caller's answer. A receiver
 * that is down changes nothing about the evaluation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { createDashboardServer } from '../../../src/dashboard/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createLogger } from '../../../src/utils/logger.js';
import { installWebhookNotifier, verifyDelivery, type WebhookInstall } from '../../../src/notify/index.js';
import { secretBytes } from '../../../src/notify/config.js';

// An SSN in the answer: no_pii, critical by default, vetoes the verdict.
const LEAKY = 'The customer record shows SSN 123-45-6789 and the refund was approved for the order.';
const CLEAN = 'The refund was approved for the order and will post within five business days.';

type Content = Array<{ type: string; text: string }>;
const parse = (r: unknown) => {
  const text = (r as { content: Content }).content[0].text;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`the tool answered: ${text}`);
  }
};

describe('the webhook on every door', () => {
  let storage: SqliteAdapter;
  let client: Client;
  let ruleDir: string;
  let server: Server;
  let base = '';
  let install: WebhookInstall;
  const bodies: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const log = { info: vi.fn(), warn: vi.fn(), event: vi.fn() };
  let status = 200;

  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push({ headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    bodies.length = 0;
    status = 200;
    log.warn.mockClear();
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.notify.webhook = { url: 'https://hooks.example.test/iris', secret: 'shh', cooldownMinutes: 0 };
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    install = installWebhookNotifier(storage, config, log, { fetch: fetchImpl, sleep: async () => undefined })!;
    expect(install).not.toBeNull();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-webhook-doors-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer, evalEngine } = createIrisServer(config, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'doors', version: '0.1.0' });
    await client.connect(clientTransport);
    server = createDashboardServer(storage, config, createLogger(config), { evalEngine }).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  });

  afterEach(async () => {
    await install.dispose();
    await client.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  const delivered = async (n: number) => {
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(n), { timeout: 5_000 });
    await install.notifier.idle();
  };
  const types = () => bodies.map((b) => b.body.type as string).sort();

  it('evaluate_output: a vetoed verdict reaches the receiver as detector_veto and verdict_fail, signed, with the evaluation id the caller got; no trace, so no agent', async () => {
    const answer = parse(await client.callTool({ name: 'evaluate_output', arguments: { input: 'Was the refund approved?', output: LEAKY } }));
    expect((answer.verdict as { basis: string }).basis).toBe('detector_veto');
    await delivered(2);
    expect(types()).toEqual(['iris.detector_veto', 'iris.verdict_fail']);
    for (const { headers, body } of bodies) {
      expect((body.data as { evaluation_id: string }).evaluation_id).toBe(answer.id);
      expect((body.data as { agent_name: string | null; trace_id: string | null }).agent_name).toBeNull();
      expect(verifyDelivery(secretBytes('shh'), headers, JSON.stringify(body)).ok).toBe(true);
    }
    // Linked to a stored trace, the moment carries its agent.
    bodies.length = 0;
    const logged = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'support-bot', input: 'Was the refund approved?', output: LEAKY } }));
    await client.callTool({ name: 'evaluate_output', arguments: { trace_id: logged.trace_id, input: 'Was the refund approved?', output: LEAKY } });
    await delivered(2);
    expect(bodies[0].body.data).toMatchObject({ trace_id: logged.trace_id, agent_name: 'support-bot' });
  });

  it('log_trace with evaluate: the same two moments, carrying the trace id, the run and the case', async () => {
    const answer = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'support-bot', input: 'Was the refund approved?', output: LEAKY, run: 'nightly-1', case_key: 'refund', evaluate: true } }));
    await delivered(2);
    expect(types()).toEqual(['iris.detector_veto', 'iris.verdict_fail']);
    expect(bodies[0].body.data).toMatchObject({ trace_id: answer.trace_id, run_id: 'nightly-1', case_key: 'refund' });
  });

  it('POST /api/v1/traces with evaluate: the HTTP door fires too; a clean answer fires nothing', async () => {
    const res = await fetch(`${base}/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_name: 'support-bot', input: 'Was the refund approved?', output: LEAKY, evaluate: true }) });
    expect(res.status).toBe(201);
    await delivered(2);
    expect(types()).toEqual(['iris.detector_veto', 'iris.verdict_fail']);
    bodies.length = 0;
    const clean = await fetch(`${base}/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_name: 'support-bot', input: 'When will the refund post?', output: CLEAN, evaluate: true }) });
    expect(clean.status).toBe(201);
    await install.notifier.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(types()).toEqual([]);
  });

  it('a receiver that is down never touches the evaluation: the caller gets its verdict, the drop is a log line', async () => {
    status = 503;
    const answer = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'support-bot', input: 'q', output: LEAKY, evaluate: true } }));
    expect(((answer.evaluation as { verdict: { state: string } }).verdict).state).toBe('fail');
    await delivered(8);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Webhook dropped (detector_veto|verdict_fail) for support-bot after 4 attempts: HTTP 503/));
    expect(typeof answer.trace_id).toBe('string');
  });

  it('after dispose, an evaluation fires nothing', async () => {
    await install.dispose();
    await client.callTool({ name: 'evaluate_output', arguments: { input: 'q', output: LEAKY } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodies).toHaveLength(0);
    // afterEach disposes again; that is harmless.
  });
});
