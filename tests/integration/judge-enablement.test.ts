/*
 * The judge is a clear option with an easy workflow (founder ruling,
 * 2026-09-04). With the environment scrubbed: the tool returns
 * IRIS_JUDGE_NOT_ENABLED whose recovery names the variable and the
 * restart, the capabilities resource says enabled false with the steps,
 * the health route says enabled false, and the self-test prints the
 * not-enabled line. With a dummy key and no network: capabilities and
 * health say enabled true with the provider name and never the key, and
 * the self-test prints the enabled line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createLogger } from '../../src/utils/logger.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { runSelfTest, SELF_TEST_STEPS } from '../../src/self-test.js';
import { errorEnvelopeSchema } from '../../src/tools/respond.js';

const KEYS = ['IRIS_ANTHROPIC_API_KEY', 'IRIS_OPENAI_API_KEY'] as const;
const DUMMY = 'sk-ant-dummy-key-for-tests-0123456789';

describe('judge enablement — every surface agrees', () => {
  const saved: Record<string, string | undefined> = {};
  let storage: SqliteAdapter;
  let client: Client;
  let dashboard: Server;
  let port = 0;

  async function boot(): Promise<void> {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const server = createIrisServer(defaultConfig, storage);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(s);
    client = new Client({ name: 'judge-enablement', version: '0.1.0' });
    await client.connect(c);
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    dashboard = createDashboardServer(storage, config, createLogger(config), { evalEngine: server.evalEngine, customRuleStore: server.customRuleStore }).start();
    await new Promise<void>((resolve, reject) => {
      dashboard.once('listening', resolve);
      dashboard.once('error', reject);
    });
    port = (dashboard.address() as { port: number }).port;
  }

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    await client?.close();
    await new Promise<void>((resolve) => dashboard?.close(() => resolve()));
    await storage?.close();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function capabilities(): Promise<{ judge: { enabled: boolean; provider: string | null; howToEnable: string[] } }> {
    const read = await client.readResource({ uri: 'iris://capabilities' });
    return JSON.parse((read.contents[0] as { text: string }).text);
  }
  async function health(): Promise<{ judge: { enabled: boolean; provider: string | null }; mode: string }> {
    return (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json() as Promise<{ judge: { enabled: boolean; provider: string | null }; mode: string }>;
  }
  async function selfTestOutput(): Promise<string> {
    const lines: string[] = [];
    await runSelfTest((l) => lines.push(l));
    return lines.join('\n');
  }

  it('without a key: the error, the capabilities resource, health and the self-test all say how to enable it', async () => {
    await boot();
    const r = (await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'x', template: 'accuracy', model: 'claude-haiku-4-5' } })) as { isError?: boolean; content?: unknown };
    expect(r.isError).toBe(true);
    const parsed = errorEnvelopeSchema.parse(JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text));
    expect(parsed.error.code).toBe('IRIS_JUDGE_NOT_ENABLED');
    const recovery = parsed.error.recovery.join('\n');
    expect(recovery).toContain('IRIS_ANTHROPIC_API_KEY');
    expect(recovery).toContain('IRIS_OPENAI_API_KEY');
    expect(recovery).toMatch(/restart/i);

    const caps = await capabilities();
    expect(caps.judge.enabled).toBe(false);
    expect(caps.judge.provider).toBeNull();
    expect(caps.judge.howToEnable.length).toBeGreaterThanOrEqual(4);

    const h = await health();
    expect(h.judge).toEqual({ enabled: false, provider: null });
    expect(h.mode).toBe('real');

    const out = await selfTestOutput();
    expect(out).toContain(`✓ ${SELF_TEST_STEPS.judge} — not enabled`);
    expect(out).toContain('config env block');
  }, 30_000);

  it('with a key in this process and no network: enabled true with the provider name, never the key', async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = DUMMY;
    await boot();
    const caps = await capabilities();
    expect(caps.judge.enabled).toBe(true);
    expect(caps.judge.provider).toBe('anthropic');
    expect(JSON.stringify(caps)).not.toContain(DUMMY);

    const h = await health();
    expect(h.judge).toEqual({ enabled: true, provider: 'anthropic' });
    expect(JSON.stringify(h)).not.toContain(DUMMY);

    const out = await selfTestOutput();
    expect(out).toContain(`✓ ${SELF_TEST_STEPS.judge} — enabled (anthropic`);
    expect(out).not.toContain(DUMMY);
  }, 30_000);
});
