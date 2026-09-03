/*
 * The tool-contract fixes from the 0.5.1 acceptance backlog, driven
 * through the REAL MCP surface (in-memory transport, the SDK's own
 * validation), so what is asserted is what a client sees:
 *
 *   #373  get_traces rejects nonsense ranges; deploy_rule same-name guard;
 *         rule_results carry ruleId
 *   #376  custom_rules entries are strict; unknown trace_id is a clear error
 *   #377  definition.name optional; snake_case aliases on deploy_rule
 *   #370  eval_type="all"
 *   backlog: deploy_rule description tells the truth about when a rule
 *         fires; verify_citations source keys are snake_case; delete_rule
 *         carries the enable/disable affordance the descriptions promised
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/eval/citation-verify/verifier.js', () => ({
  verifyCitations: vi.fn(async () => ({
    overallScore: 1,
    passed: true,
    totalCitationsFound: 1,
    totalResolved: 1,
    totalJudged: 1,
    totalSupported: 1,
    totalCostUsd: 0.0012,
    citations: [
      {
        citation: { raw: '[1]', kind: 'numbered', identifier: '1', offsetStart: 10, offsetEnd: 13, contextWindow: 'claim' },
        resolveStatus: 'ok',
        source: { url: 'https://example.org/paper', status: 200, contentType: 'text/html', bytesFetched: 4321, truncated: false },
        judge: { supported: true, confidence: 0.9, rationale: 'supports', costUsd: 0.0012, latencyMs: 120, inputTokens: 100, outputTokens: 20 },
      },
    ],
  })),
}));

type Content = Array<{ type: string; text: string }>;
const text = (r: { content?: unknown }) => (r.content as Content)[0].text;
const parse = (r: { content?: unknown }) => JSON.parse(text(r));

const CLEAN_OUTPUT =
  'The quarterly report is attached. Revenue grew in every region, and the outlook remains stable for next year.';

describe('tool contracts (MCP surface)', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    // A per-test rule store so deploys in one test never leak into the next.
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-tool-contracts-'));
    const ruleStore = createCustomRuleStore({
      pathFor: () => join(ruleDir, 'custom-rules.json'),
      auditPath: join(ruleDir, 'audit.log'),
    });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'tool-contracts', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  describe('get_traces range validation (#373 item 5)', () => {
    it('rejects min_score > max_score naming both values instead of returning an empty page', async () => {
      const r = await client.callTool({ name: 'get_traces', arguments: { min_score: 0.9, max_score: 0.1 } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('min_score (0.9) must be <= max_score (0.1)');
    });

    it('rejects scores outside 0..1', async () => {
      const r = await client.callTool({ name: 'get_traces', arguments: { max_score: 7 } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/max_score/);
    });

    it('rejects an unparseable since/until with the expected format named', async () => {
      for (const args of [{ since: 'yesterday' }, { until: '08/01/2026' }]) {
        const r = await client.callTool({ name: 'get_traces', arguments: args });
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(text(r)).toContain('must be an ISO 8601 timestamp (e.g. 2026-08-01T00:00:00Z) or date (2026-08-01)');
      }
    });

    it('rejects since later than until', async () => {
      const r = await client.callTool({ name: 'get_traces', arguments: { since: '2026-02-01', until: '2026-01-01T00:00:00Z' } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('since (2026-02-01) must not be later than until (2026-01-01T00:00:00Z)');
    });

    it('rejects a negative offset', async () => {
      const r = await client.callTool({ name: 'get_traces', arguments: { offset: -1 } });
      expect(r.isError).toBe(true);
    });

    it('accepts ISO dates and timestamps with offsets, and a sane score range', async () => {
      const r = await client.callTool({
        name: 'get_traces',
        arguments: { since: '2026-01-01', until: '2026-02-01T00:00:00.000+02:00', min_score: 0.1, max_score: 0.9 },
      });
      expect(r.isError).toBeFalsy();
      expect(parse(r)).toMatchObject({ traces: [], total: 0 });
    });
  });

  describe('evaluate_output nested strictness and trace linking (#376)', () => {
    it('rejects an unknown key inside a custom_rules entry with the valid key list and the entry path', async () => {
      const r = await client.callTool({
        name: 'evaluate_output',
        arguments: {
          output: 'hello world',
          eval_type: 'custom',
          custom_rules: [{ name: 'a', type: 'contains_keywords', config: { keywords: ['hello'] }, wieght: 5 }],
        },
      });
      expect(r.isError).toBe(true);
      const t = text(r);
      expect(t).toContain('Unknown key(s) in a custom_rules entry: "wieght"');
      expect(t).toContain('Valid keys: name, type, config, weight');
      expect(t).toContain('custom_rules[0]');
      expect((await storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    });

    it('still accepts free-form config keys inside a custom rule', async () => {
      const r = await client.callTool({
        name: 'evaluate_output',
        arguments: {
          output: 'hello world',
          eval_type: 'custom',
          custom_rules: [{ name: 'a', type: 'contains_keywords', config: { keywords: ['hello'], threshold: 0.5, anything: true } }],
        },
      });
      expect(r.isError).toBeFalsy();
      expect(parse(r).passed).toBe(true);
    });

    it('names trace_id when it does not match a stored trace, and writes nothing', async () => {
      const r = await client.callTool({
        name: 'evaluate_output',
        arguments: { output: 'hello world', eval_type: 'safety', trace_id: 'f'.repeat(32) },
      });
      expect(r.isError).toBe(true);
      const t = text(r);
      expect(t).toContain(`trace_id "${'f'.repeat(32)}" does not match any stored trace`);
      expect(t).toContain('Nothing was evaluated or written');
      expect(t).not.toContain('FOREIGN KEY');
      expect((await storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    });

    it('links to a real trace as before', async () => {
      const logged = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', output: 'x' } }));
      const r = await client.callTool({
        name: 'evaluate_output',
        arguments: { output: 'hello world', eval_type: 'safety', trace_id: logged.trace_id },
      });
      expect(r.isError).toBeFalsy();
      expect((await storage.getEvalsByTraceId(LOCAL_TENANT, logged.trace_id)).length).toBe(1);
    });

    it('evaluate_with_llm_judge and verify_citations refuse an unknown trace_id before spending anything', async () => {
      const savedKey = process.env.IRIS_ANTHROPIC_API_KEY;
      const savedFetch = global.fetch;
      process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
      const fetchSpy = vi.fn(async () => { throw new Error('provider must not be called'); });
      global.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const judge = await client.callTool({
          name: 'evaluate_with_llm_judge',
          arguments: { output: 'judged', template: 'accuracy', model: 'claude-haiku-4-5', trace_id: 'e'.repeat(32) },
        });
        expect(judge.isError).toBe(true);
        expect(text(judge)).toContain('does not match any stored trace');
        expect(fetchSpy).not.toHaveBeenCalled();

        const cite = await client.callTool({
          name: 'verify_citations',
          arguments: { output: 'cited [1]', model: 'claude-haiku-4-5', trace_id: 'e'.repeat(32) },
        });
        expect(cite.isError).toBe(true);
        expect(text(cite)).toContain('does not match any stored trace');
        expect((await storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
      } finally {
        global.fetch = savedFetch;
        if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
        else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
      }
    });
  });

  describe('evaluate_output eval_type="all" (#370 item 3)', () => {
    it('runs every bundle, returns per-category scores, and applies the critical veto to the overall verdict', async () => {
      const r = await client.callTool({
        name: 'evaluate_output',
        arguments: {
          output: 'The quarterly report is attached. Revenue grew in every region. The customer SSN is 536-22-8145.',
          eval_type: 'all',
          input: 'quarterly report revenue',
          cost_usd: 0.01,
        },
      });
      expect(r.isError).toBeFalsy();
      const body = parse(r);
      expect(body.eval_type).toBe('all');
      expect(body.score).toBeGreaterThanOrEqual(0.7);
      expect(body.passed).toBe(false);
      expect(body.critical_failures).toEqual(['no_pii']);
      expect(Object.keys(body.categories)).toEqual(['completeness', 'relevance', 'safety', 'cost']);
      expect(body.categories.safety).toMatchObject({ passed: false, critical_failures: ['no_pii'] });
      expect(body.categories.completeness).toMatchObject({ passed: true });
      expect(body.categories.cost).toMatchObject({ rules_evaluated: 1, rules_skipped: 1 });
      const pii = body.rule_results.find((x: { ruleName: string }) => x.ruleName === 'no_pii');
      expect(pii.category).toBe('safety');
      expect(body.note).toBeUndefined();

      // Stored under eval_type 'all', and the dashboard's safety-violation
      // counter sees the leak.
      const stored = await storage.queryEvalResults(LOCAL_TENANT, {});
      expect(stored.total).toBe(1);
      expect(stored.results[0].eval_type).toBe('all');
      expect(stored.results[0].critical_failures).toEqual(['no_pii']);
      expect((await storage.getEvalStats(LOCAL_TENANT, '24h')).safetyViolations.pii).toBe(1);
    });

    it('the omitted-eval_type note now points at "all" as well as "safety"', async () => {
      const body = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: CLEAN_OUTPUT } }));
      expect(body.note).toContain('eval_type="safety"');
      expect(body.note).toContain('eval_type="all"');
    });

    it('the description documents the "all" bundle and the categories field', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'evaluate_output')!;
      expect(tool.description).toContain('`all` (every bundle above in one call');
      expect(tool.description).toContain('"categories?"');
      const evalType = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.eval_type;
      expect(evalType.enum).toContain('all');
    });
  });

  describe('deploy_rule (#373 item 3, #377 items 3-4, backlog accuracy)', () => {
    const definition = { type: 'min_length', config: { min: 3 } };

    it('accepts snake_case eval_type / source_moment_id and the camelCase aliases; refuses both spellings at once', async () => {
      const snake = parse(await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'snake', eval_type: 'completeness', source_moment_id: 'm-1', definition },
      }));
      expect(snake.rule).toMatchObject({ name: 'snake', evalType: 'completeness', sourceMomentId: 'm-1' });

      const camel = parse(await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'camel', evalType: 'completeness', sourceMomentId: 'm-2', definition },
      }));
      expect(camel.rule).toMatchObject({ name: 'camel', evalType: 'completeness', sourceMomentId: 'm-2' });

      const both = await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'both', eval_type: 'completeness', evalType: 'completeness', definition },
      });
      expect(both.isError).toBe(true);
      expect(text(both)).toContain('pass either eval_type or evalType, not both');

      const neither = await client.callTool({ name: 'deploy_rule', arguments: { name: 'neither', definition } });
      expect(neither.isError).toBe(true);
      expect(text(neither)).toContain('eval_type is required');
    });

    it('definition.name is optional and always overwritten by the top-level name', async () => {
      const r = parse(await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'outer-name', eval_type: 'completeness', definition: { ...definition, name: 'inner-name' } },
      }));
      expect(r.rule.definition.name).toBe('outer-name');
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'deploy_rule')!;
      const def = (tool.inputSchema as { properties: Record<string, { required?: string[]; properties: Record<string, { description?: string }> }> }).properties.definition;
      expect(def.required).not.toContain('name');
      expect(def.properties.name.description).toMatch(/overwrites it with the top-level `name`/);
    });

    it('rejects an unknown key inside definition', async () => {
      const r = await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'typo', eval_type: 'completeness', definition: { ...definition, wieght: 2 } },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Unknown key(s) in definition: "wieght"');
      expect(text(r)).toContain('Valid keys: name, type, config, weight');
    });

    it('refuses a same-name redeploy naming the existing rule, and replace:true retires it', async () => {
      const first = parse(await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'policy', eval_type: 'completeness', definition: { type: 'contains_keywords', config: { keywords: ['report'] } } },
      }));

      const dup = await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'policy', eval_type: 'completeness', definition: { type: 'contains_keywords', config: { keywords: ['zebra'] } } },
      });
      expect(dup.isError).toBe(true);
      expect(text(dup)).toContain(`A rule named "policy" is already deployed: ${first.rule.id}`);
      expect(text(dup)).toContain('replace: true');
      // Still exactly one rule, still the first one firing.
      const listed = parse(await client.callTool({ name: 'list_rules', arguments: {} }));
      expect(listed.total).toBe(1);

      const replaced = parse(await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'policy', eval_type: 'completeness', replace: true, definition: { type: 'contains_keywords', config: { keywords: ['zebra'] } } },
      }));
      expect(replaced.rule.id).not.toBe(first.rule.id);
      expect(replaced.replaced).toEqual([{ id: first.rule.id, evalType: 'completeness', severity: 'medium' }]);
      expect(replaced.warning).toContain(first.rule.id);

      // Exactly one rule named "policy" fires, and it is the new one — the
      // ruleId in rule_results says which.
      const evaluated = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: CLEAN_OUTPUT, eval_type: 'completeness' } }));
      const policy = evaluated.rule_results.filter((x: { ruleName: string }) => x.ruleName === 'policy');
      expect(policy).toHaveLength(1);
      expect(policy[0].ruleId).toBe(replaced.rule.id);
      expect(policy[0].passed).toBe(false); // 'zebra' is not in the output; the old 'report' rule is gone
      expect(parse(await client.callTool({ name: 'list_rules', arguments: {} })).rules.map((x: { id: string }) => x.id)).toEqual([replaced.rule.id]);
    });

    it('the description no longer claims a rule fires on eval_type="custom", and says exactly when it does', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'deploy_rule')!;
      expect(tool.description).not.toContain('OR eval_type="custom"');
      expect(tool.description).toContain('runs ONLY on evaluate_output calls whose eval_type equals the rule\'s eval_type, plus eval_type="all"');
      expect(tool.description).toContain('snake_case');
      expect(tool.description).toContain('"replaced?"');
    });

    it('matches the engine: a completeness rule does not fire on eval_type="custom" but does on "all"', async () => {
      const deployed = parse(await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'completeness-only', eval_type: 'completeness', definition: { type: 'contains_keywords', config: { keywords: ['report'] } } },
      }));
      const custom = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: CLEAN_OUTPUT, eval_type: 'custom' } }));
      expect(custom.rule_results.some((x: { ruleId?: string }) => x.ruleId === deployed.rule.id)).toBe(false);
      const all = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: CLEAN_OUTPUT, eval_type: 'all' } }));
      expect(all.rule_results.find((x: { ruleId?: string }) => x.ruleId === deployed.rule.id)).toMatchObject({ category: 'completeness', passed: true });
    });
  });

  describe('delete_rule enabled toggle (backlog: the toggle affordance that did not exist)', () => {
    it('disables a rule (stops firing, kept in the store), re-enables it, and reports toggled:false on an unknown id', async () => {
      const deployed = parse(await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'pausable', eval_type: 'completeness', definition: { type: 'contains_keywords', config: { keywords: ['report'] } } },
      }));
      const id: string = deployed.rule.id;
      const fires = async () =>
        parse(await client.callTool({ name: 'evaluate_output', arguments: { output: CLEAN_OUTPUT, eval_type: 'completeness' } }))
          .rule_results.some((x: { ruleId?: string }) => x.ruleId === id);
      expect(await fires()).toBe(true);

      const disabled = parse(await client.callTool({ name: 'delete_rule', arguments: { rule_id: id, enabled: false } }));
      expect(disabled).toMatchObject({ deleted: false, toggled: true, rule_id: id, enabled: false });
      expect(disabled.rule.enabled).toBe(false);
      expect(await fires()).toBe(false);
      const listed = parse(await client.callTool({ name: 'list_rules', arguments: {} }));
      expect(listed.rules.find((x: { id: string }) => x.id === id).enabled).toBe(false);
      expect(parse(await client.callTool({ name: 'list_rules', arguments: { enabled_only: true } })).total).toBe(0);

      const enabled = parse(await client.callTool({ name: 'delete_rule', arguments: { rule_id: id, enabled: true } }));
      expect(enabled).toMatchObject({ deleted: false, toggled: true, enabled: true });
      expect(await fires()).toBe(true);
      // Re-enabling twice does not stack a second registration.
      await client.callTool({ name: 'delete_rule', arguments: { rule_id: id, enabled: true } });
      const twice = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: CLEAN_OUTPUT, eval_type: 'completeness' } }));
      expect(twice.rule_results.filter((x: { ruleId?: string }) => x.ruleId === id)).toHaveLength(1);

      const unknown = parse(await client.callTool({ name: 'delete_rule', arguments: { rule_id: 'rule-ffffffff', enabled: false } }));
      expect(unknown).toEqual({ deleted: false, toggled: false, rule_id: 'rule-ffffffff' });

      // Plain delete still works and still reports as before.
      expect(parse(await client.callTool({ name: 'delete_rule', arguments: { rule_id: id } }))).toEqual({ deleted: true, rule_id: id });
    });

    it('the descriptions point at the toggle that now exists, not at a dashboard affordance', async () => {
      const { tools } = await client.listTools();
      for (const name of ['delete_rule', 'list_rules', 'deploy_rule']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(tool.description, name).not.toContain("dashboard's toggle affordance");
        expect(tool.description, name).not.toContain("dashboard's rule-list affordance");
        expect(tool.description, name).not.toContain('no MCP toggle tool');
        expect(tool.description, name).toMatch(/enabled/);
      }
    });
  });

  describe('verify_citations output shape (backlog accuracy)', () => {
    it('maps source to the documented snake_case keys', async () => {
      const savedKey = process.env.IRIS_ANTHROPIC_API_KEY;
      process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
      try {
        const r = await client.callTool({ name: 'verify_citations', arguments: { output: 'A claim [1].', model: 'claude-haiku-4-5' } });
        expect(r.isError).toBeFalsy();
        const body = parse(r);
        expect(body.citations[0].source).toEqual({
          url: 'https://example.org/paper',
          status: 200,
          content_type: 'text/html',
          bytes_fetched: 4321,
          truncated: false,
        });
        expect(body.citations[0].source.contentType).toBeUndefined();
        expect(body.citations[0].judge).toMatchObject({ cost_usd: 0.0012, latency_ms: 120, input_tokens: 100, output_tokens: 20 });
      } finally {
        if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
        else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
      }
    });
  });
});
