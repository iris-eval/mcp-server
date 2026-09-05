/*
 * The agent-native contract, driven over a real in-memory transport.
 *
 * Nine of nine tools advertise an output schema; every success carries
 * structuredContent that deep-equals the parsed text; every resource_link
 * a response emits reads back through resources/read; the instructions
 * are present, true to the registrations, and under the ceiling; the
 * resources list and templates list equal the registry; the prompt
 * renders. The judge tools run with the environment scrubbed, so what
 * they return here is the enablement error — validated as an envelope —
 * and their output schemas are still advertised.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { TOOL_NAMES } from '../../src/tools/index.js';
import { FIXED_RESOURCE_URIS, RESOURCE_TEMPLATES, RESOURCE_URIS } from '../../src/resources/uris.js';
import { PROMPT_NAMES } from '../../src/prompts.js';
import { INSTRUCTIONS_MAX_CHARS } from '../../src/instructions.js';
import { errorEnvelopeSchema } from '../../src/tools/respond.js';
import { evaluateOutputResponseSchema } from '../../src/eval/response-schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = resolve(__dirname, '..', '..');
const t13 = JSON.parse(readFileSync(resolve(root, 'tests', 'fixtures', 'real-transcripts', 't-13-grep-no-match.json'), 'utf-8')) as {
  input: string;
  output: string;
  tool_calls: Array<{ tool_name: string; input?: unknown; output?: unknown; error?: string }>;
  cost_usd: number;
};

type Item = { type: string; text?: string; uri?: string; name?: string };
type Result = { content?: unknown; structuredContent?: unknown; isError?: boolean };
const items = (r: Result) => r.content as Item[];
const text = (r: Result) => items(r).find((c) => c.type === 'text')!.text!;
const links = (r: Result) => items(r).filter((c) => c.type === 'resource_link');

const SCRUB = ['IRIS_ANTHROPIC_API_KEY', 'IRIS_OPENAI_API_KEY'] as const;

describe('the agent-native contract', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;
  let instructions: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of SCRUB) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-response-schema-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const server = createIrisServer(defaultConfig, storage, ruleStore);
    instructions = server.instructions;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(serverTransport);
    client = new Client({ name: 'contract', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
    for (const k of SCRUB) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('tools/list advertises an output schema on nine of nine, and the names equal the registry', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.outputSchema, `${t.name} has no outputSchema`).toBeDefined();
      expect((t.outputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('every success carries structuredContent equal to the parsed text, and every link reads back', async () => {
    const logged = await client.callTool({ name: 'log_trace', arguments: { agent_name: 'contract', input: t13.input, output: t13.output, tool_calls: t13.tool_calls, cost_usd: t13.cost_usd } });
    const traceId = (JSON.parse(text(logged as unknown as Result)) as { trace_id: string }).trace_id;
    const deployed = await client.callTool({
      name: 'deploy_rule',
      arguments: { name: 'contract-rule', eval_type: 'completeness', definition: { type: 'min_length', config: { min_length: 5 } } },
    });
    const ruleId = (JSON.parse(text(deployed as unknown as Result)) as { rule: { id: string } }).rule.id;
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'evaluate_output', arguments: { output: t13.output, input: t13.input, trace_id: traceId, cost_usd: t13.cost_usd, eval_type: 'all' } },
      { name: 'get_traces', arguments: { include_summary: true } },
      { name: 'list_rules', arguments: {} },
      { name: 'delete_rule', arguments: { rule_id: ruleId, enabled: false } },
      { name: 'delete_rule', arguments: { rule_id: ruleId } },
      { name: 'delete_trace', arguments: { trace_id: traceId } },
    ];
    const seen: Result[] = [logged as unknown as Result, deployed as unknown as Result];
    for (const call of calls) {
      const r = (await client.callTool(call)) as unknown as Result;
      expect(r.isError, `${call.name}: ${text(r)}`).toBeFalsy();
      seen.push(r);
      if (call.name === 'evaluate_output') {
        const parsed = evaluateOutputResponseSchema.safeParse(JSON.parse(text(r)));
        expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
        expect(links(r).map((l) => l.uri)).toEqual([`iris://evaluations/${parsed.success ? parsed.data.id : ''}`, `iris://traces/${traceId}`]);
      }
      // Links are read BEFORE the deletes below remove what they point at.
      if (call.name !== 'delete_rule' && call.name !== 'delete_trace') {
        for (const link of links(r)) {
          const read = await client.readResource({ uri: link.uri! });
          expect(read.contents.length, link.uri).toBeGreaterThan(0);
          expect(() => JSON.parse((read.contents[0] as { text: string }).text)).not.toThrow();
        }
      }
    }
    for (const r of seen) {
      expect(r.structuredContent, text(r).slice(0, 80)).toEqual(JSON.parse(text(r)));
    }
  });

  it('the judge tools advertise their schema and, without a key, return the enablement envelope', async () => {
    for (const name of ['evaluate_with_llm_judge', 'verify_citations'] as const) {
      const args = name === 'evaluate_with_llm_judge' ? { output: 'judge me [1]', template: 'accuracy', model: 'claude-haiku-4-5' } : { output: 'judge me [1]', model: 'claude-haiku-4-5' };
      const r = (await client.callTool({ name, arguments: args })) as unknown as Result;
      expect(r.isError, name).toBe(true);
      const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text(r)));
      expect(parsed.success, name).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.error.code).toBe('IRIS_JUDGE_NOT_ENABLED');
      expect(parsed.data.error.field).toBe('IRIS_ANTHROPIC_API_KEY');
      expect(parsed.data.error.recovery.join(' ')).toMatch(/Restart the MCP session/);
      expect(parsed.data.error.recovery.join(' ')).toMatch(/"env" block/);
      expect(r.structuredContent).toEqual(JSON.parse(text(r)));
      expect(links(r).map((l) => l.uri)).toEqual(['iris://capabilities']);
    }
  });

  it('the instructions are present, true to the registrations, quote the effective critical list, and fit the ceiling', async () => {
    const got = client.getInstructions();
    expect(got).toBe(instructions);
    expect(got!.length).toBeGreaterThan(0);
    expect(got!.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((t) => t.name));
    for (const m of got!.matchAll(/\b([a-z]+_[a-z_]+)\b/g)) {
      const token = m[1];
      if (/^(log|get|delete|evaluate|list|deploy|verify)_/.test(token)) expect(toolNames.has(token), token).toBe(true);
    }
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    const registered = new Set([...resources.map((r) => r.uri), ...resourceTemplates.map((r) => r.uriTemplate)]);
    const mentioned = [...got!.matchAll(/iris:\/\/[A-Za-z0-9_/{}:.-]+/g)].map((m) => m[0].replace(/[.,;:)]+$/, ''));
    expect(mentioned.length).toBeGreaterThanOrEqual(5);
    for (const uri of mentioned) expect(registered.has(uri), uri).toBe(true);
    for (const rule of ['no_pii', 'no_injection_patterns', 'no_blocklist_words']) expect(got).toContain(rule);
    expect(got).toContain('not enabled');
    expect(got).toContain(String(defaultConfig.eval.defaultThreshold));
  });

  it('resources/list and resources/templates/list equal the registry; a missing trace is the protocol error, not a 200 body', async () => {
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resources.map((r) => r.uri).sort()).toEqual([...FIXED_RESOURCE_URIS].sort());
    expect(resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual([...RESOURCE_TEMPLATES].sort());
    expect([...FIXED_RESOURCE_URIS, ...RESOURCE_TEMPLATES].sort()).toEqual([...RESOURCE_URIS].sort());
    for (const uri of FIXED_RESOURCE_URIS) {
      const read = await client.readResource({ uri });
      expect(() => JSON.parse((read.contents[0] as { text: string }).text), uri).not.toThrow();
    }
    await expect(client.readResource({ uri: `iris://traces/${'0'.repeat(32)}` })).rejects.toThrow(/Resource not found/);
    await expect(client.readResource({ uri: 'iris://evaluations/nope' })).rejects.toThrow(/Resource not found/);
  });

  it('iris://capabilities says what this server can do, names no key, and lists the registrations', async () => {
    const read = await client.readResource({ uri: 'iris://capabilities' });
    const caps = JSON.parse((read.contents[0] as { text: string }).text) as Record<string, unknown> & {
      judge: { enabled: boolean; provider: string | null; howToEnable: string[] };
      rules: Array<{ name: string; needs: string[]; proof: unknown }>;
      tools: string[];
      resources: string[];
      prompts: string[];
    };
    expect(caps.judge.enabled).toBe(false);
    expect(caps.judge.provider).toBeNull();
    expect(caps.judge.howToEnable.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(caps)).not.toMatch(/sk-ant-[A-Za-z0-9]{8}/);
    expect(caps.tools.sort()).toEqual([...TOOL_NAMES].sort());
    expect(caps.resources.sort()).toEqual([...RESOURCE_URIS].sort());
    expect(caps.prompts).toEqual([...PROMPT_NAMES]);
    const pii = caps.rules.find((r) => r.name === 'no_pii')!;
    expect(pii.needs).toEqual(['output']);
    expect(pii.proof).not.toBeNull();
  });

  it('the prompt renders the walk with the version', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual([...PROMPT_NAMES]);
    const got = await client.getPrompt({ name: PROMPT_NAMES[0], arguments: { what: 'trace-file' } });
    const body = (got.messages[0].content as { text: string }).text;
    expect(body).toContain(defaultConfig.server.version);
    expect(body).toContain('log_trace');
    expect(body).toContain('trace file');
  });
});
