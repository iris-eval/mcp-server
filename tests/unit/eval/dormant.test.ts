/*
 * A quarantined critical rule is named on the verdict (coverage.dormant),
 * on list_rules (quarantined[]), on GET /api/v1/rules/custom and on the
 * HTTP evaluate path — a gate reads the verdict, never list_rules.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { createDashboardServer } from '../../../src/dashboard/server.js';
import { createLogger } from '../../../src/utils/logger.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { dormantRulesFrom } from '../../../src/eval/dormant.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const QUARANTINED = { id: 'rule-dead01', name: 'must-cite-source', description: 'from a future version', evalType: 'safety', severity: 'critical', definition: { type: 'regex_match', config: {} }, enabled: true, createdAt: 'not-a-date', updatedAt: 'not-a-date', version: 1 };

describe('dormant rules', () => {
  let dir: string;
  let storage: SqliteAdapter;
  let client: Client;
  let dashboard: Server | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iris-dormant-'));
    // Seed one healthy rule through the store (so it is in the store's own shape),
    // then plant the quarantined entry beside it by hand.
    const seed = createCustomRuleStore({ pathFor: () => join(dir, 'custom-rules.json'), auditPath: join(dir, 'audit.log') });
    seed.deploy(LOCAL_TENANT, { name: 'short-enough', evalType: 'completeness', severity: 'low', definition: { name: 'short-enough', type: 'max_length', config: { max_length: 5000 } } });
    const file = JSON.parse(readFileSync(join(dir, 'custom-rules.json'), 'utf8')) as { rules: unknown[] };
    file.rules.push(QUARANTINED);
    writeFileSync(join(dir, 'custom-rules.json'), JSON.stringify(file));
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
  });
  afterEach(async () => {
    await client?.close();
    if (dashboard) await new Promise<void>((resolve) => dashboard!.close(() => resolve()));
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dormantRulesFrom keeps only the entries that would have gated', () => {
    expect(dormantRulesFrom([QUARANTINED, { ...QUARANTINED, id: 'rule-low', severity: 'low' }, 'garbage', null])).toEqual([
      { ruleId: 'rule-dead01', name: 'must-cite-source', reason: expect.stringContaining('critical rule is not running') },
    ]);
  });

  it('the verdict, list_rules and the HTTP surfaces all name the quarantined critical rule', async () => {
    const store = createCustomRuleStore({ pathFor: () => join(dir, 'custom-rules.json'), auditPath: join(dir, 'audit.log') });
    expect(store.list(LOCAL_TENANT).map((r) => r.name)).toEqual(['short-enough']);
    expect(store.quarantined(LOCAL_TENANT)).toHaveLength(1);

    const server = createIrisServer(defaultConfig, storage, store);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(s);
    client = new Client({ name: 'dormant', version: '0.1.0' });
    await client.connect(c);

    const text = (r: unknown) => (r as { content: Array<{ type: string; text: string }> }).content[0].text;
    const evaluated = JSON.parse(text(await client.callTool({ name: 'evaluate_output', arguments: { output: 'A clean answer about the weather in Paris this week.', eval_type: 'safety' } }))) as {
      coverage: { dormant?: Array<{ ruleId: string; name: string }> };
    };
    expect(evaluated.coverage.dormant).toEqual([{ ruleId: 'rule-dead01', name: 'must-cite-source', reason: expect.any(String) }]);

    const listed = JSON.parse(text(await client.callTool({ name: 'list_rules', arguments: {} }))) as { quarantined: unknown[]; total: number };
    expect(listed.total).toBe(1);
    expect(listed.quarantined).toHaveLength(1);

    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    dashboard = createDashboardServer(storage, config, createLogger(config), { evalEngine: server.evalEngine, customRuleStore: store }).start();
    await new Promise<void>((resolve, reject) => {
      dashboard!.once('listening', resolve);
      dashboard!.once('error', reject);
    });
    const port = (dashboard.address() as { port: number }).port;
    const custom = (await (await fetch(`http://127.0.0.1:${port}/api/v1/rules/custom`)).json()) as { rules: unknown[]; quarantined: unknown[] };
    expect(custom.rules).toHaveLength(1);
    expect(custom.quarantined).toHaveLength(1);
    const ingested = (await (
      await fetch(`http://127.0.0.1:${port}/api/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_name: 'dormant', output: 'A clean answer about the weather in Paris this week.', evaluate: true, eval_type: 'safety' }),
      })
    ).json()) as { evaluation: { coverage: { dormant?: Array<{ ruleId: string }> } } };
    expect(ingested.evaluation.coverage.dormant?.map((d) => d.ruleId)).toEqual(['rule-dead01']);
  });
});
