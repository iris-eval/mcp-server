/*
 * A server whose config promotes a rule starts.
 *
 * eval.criticalRules is how a deployment makes one more rule veto. The
 * instructions an agent reads at connection quote the effective critical
 * list, and from 0.18.0 one more name could put that text past its
 * ceiling; from 0.20.0 any built-in rule did, and createIrisServer threw
 * before a single tool was registered. The unit tests hold the text; this
 * holds the door a deployment actually walks through: the server is built
 * from the config, a client connects, reads the promotion in the
 * instructions, and sees the promoted rule veto.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { builtInRuleRoster } from '../../src/eval/criticality.js';
import { createIrisServer } from '../../src/server.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';

const SCRUB = ['IRIS_ANTHROPIC_API_KEY', 'IRIS_OPENAI_API_KEY'] as const;

describe('a server whose config promotes rules to critical', () => {
  let storage: SqliteAdapter;
  let ruleDir: string;
  const saved: Record<string, string | undefined> = {};
  const clients: Client[] = [];

  beforeEach(async () => {
    // No judge key: the instructions are at their longest then, which is the case that refused to start.
    for (const k of SCRUB) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-critical-start-'));
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    for (const k of SCRUB) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const start = async (criticalRules: string[]): Promise<{ client: Client; instructions: string }> => {
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const server = createIrisServer({ ...defaultConfig, eval: { ...defaultConfig.eval, criticalRules } }, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(serverTransport);
    const client = new Client({ name: 'critical-start', version: '0.1.0' });
    await client.connect(clientTransport);
    clients.push(client);
    return { client, instructions: server.instructions };
  };

  it('starts with one rule promoted, tells the agent so, and the promoted rule vetoes', async () => {
    const { client, instructions } = await start(['no_stub_output']);
    expect(client.getInstructions()).toBe(instructions);
    expect(instructions).toMatch(/Critical on this server: [a-z_, ]*\bno_stub_output\b/);
    const res = (await client.callTool({ name: 'evaluate_output', arguments: { output: 'TODO: write the summary.' } })) as { structuredContent?: { verdict?: { state: string; basis: string; by: string[] } } };
    expect(res.structuredContent?.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['no_stub_output'] });
  });

  it('starts with every built-in rule promoted, one at a time and all at once', async () => {
    const promotable = builtInRuleRoster()
      .filter((r) => !r.critical)
      .map((r) => r.name);
    for (const name of promotable) {
      const { instructions } = await start([name]);
      expect(instructions, name).toContain(name);
    }
    const { instructions } = await start(promotable);
    expect(instructions).toMatch(/Critical on this server: .* and \d+ more \(configurable; list_rules shows the effective value\)/);
  });
});
