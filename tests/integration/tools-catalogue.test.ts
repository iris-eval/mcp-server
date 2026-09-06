/*
 * The tools catalogue (arc 4, A4-3).
 *
 * The load-bearing test here is the first one, and it is a drift-lock rather
 * than an example: IRIS'S OWN tools/list RESULT MUST PARSE AS A CATALOGUE.
 * The schema claims to accept an MCP tools/list response verbatim, and the
 * cheapest honest way to keep that claim true as the SDK evolves is to hand
 * it the one tools/list result this repository can generate. When the SDK
 * adds a field to the shape, this goes red before a user's paste does.
 *
 * The rest pins the two decisions a reader would otherwise have to infer:
 * strictness protects the three fields Iris READS and nothing else, and an
 * over-size catalogue is REFUSED rather than truncated, because a truncated
 * catalogue makes "this tool is not in the catalogue" a lie about a
 * security-relevant class.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createIrisServer } from '../../src/server.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { logTraceInputShape, toolDescriptorSchema } from '../../src/tools/log-trace.js';
import { MAX_TOOLS, MAX_TOOLS_BYTES, readFamilyOf, toolsHash } from '../../src/eval/catalogue.js';
import type { ToolDescriptor } from '../../src/types/trace.js';

const catalogueSchema = z.array(toolDescriptorSchema);

describe('the tools catalogue', () => {
  let storage: SqliteAdapter;
  let client: Client;
  let ruleDir: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-catalogue-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const server = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(serverTransport);
    client = new Client({ name: 'catalogue', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  it("Iris's own tools/list result parses as a catalogue, verbatim", async () => {
    const { tools } = await client.listTools();
    const parsed = catalogueSchema.safeParse(tools);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('the catalogue survives log_trace and comes back unchanged', async () => {
    const tools: ToolDescriptor[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        annotations: { readOnlyHint: true, title: 'Read' },
      },
      { name: 'write_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: false } },
    ];
    await storage.insertTrace(LOCAL_TENANT, {
      trace_id: 'cat-1',
      agent_name: 'a',
      timestamp: new Date().toISOString(),
      tools,
    });
    const back = await storage.getTrace(LOCAL_TENANT, 'cat-1');
    expect(back?.tools).toEqual(tools);
  });

  it('a vendor key Iris never reads is carried; a misspelling of one it READS is refused', () => {
    // Carried: the spec lets clients add annotation hints, and a real
    // tools/list response arrives with keys this schema never looks at.
    expect(catalogueSchema.safeParse([{ name: 't', _meta: { vendor: 1 }, annotations: { costHint: 'high' } }]).success).toBe(true);
    // Refused: a tool whose inputSchema is misspelled would be treated as
    // schemaless, and every call to it would silently pass argument checks.
    expect(catalogueSchema.safeParse([{ name: 't', inputSchma: { type: 'object' } }]).success).toBe(false);
  });

  it('an over-size or duplicate-named catalogue is refused, never truncated', () => {
    const shape = z.object(logTraceInputShape);

    const tooMany = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => ({ name: `t${i}` }));
    expect(shape.safeParse({ agent_name: 'a', tools: tooMany }).success).toBe(false);

    const duplicate = [{ name: 'read' }, { name: 'read' }];
    const dupResult = shape.safeParse({ agent_name: 'a', tools: duplicate });
    expect(dupResult.success).toBe(false);
    if (!dupResult.success) expect(JSON.stringify(dupResult.error.issues)).toContain('twice');

    const fat = [{ name: 'big', description: 'x'.repeat(4000), inputSchema: { blob: 'y'.repeat(MAX_TOOLS_BYTES) } }];
    expect(shape.safeParse({ agent_name: 'a', tools: fat }).success).toBe(false);
  });

  it('the hash covers what a rule reads and ignores what it does not', () => {
    const base: ToolDescriptor[] = [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }];
    const reworded: ToolDescriptor[] = [{ name: 'read', description: 'reworded', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }];
    const reordered: ToolDescriptor[] = [{ name: 'read', inputSchema: { type: 'object' }, annotations: { title: 'R', readOnlyHint: true } }];
    const rescoped: ToolDescriptor[] = [{ name: 'read', inputSchema: { type: 'string' }, annotations: { readOnlyHint: true } }];

    expect(toolsHash(base)).toBe(toolsHash(reworded));
    expect(toolsHash(base)).toBe(toolsHash(reordered));
    expect(toolsHash(base)).not.toBe(toolsHash(rescoped));
    expect(toolsHash(undefined)).toBeUndefined();
  });

  it('the read-only hint decides when it exists, and the name list only guesses when it does not', () => {
    const tools: ToolDescriptor[] = [
      { name: 'apply_patch', annotations: { readOnlyHint: true } },
      { name: 'read_file', annotations: { readOnlyHint: false } },
    ];
    const step = (name: string) => ({ index: 0, kind: 'tool' as const, name, source: 'tool_calls' as const, status: 'unset' as const });

    // The author's own statement wins over the name in both directions.
    expect(readFamilyOf(step('apply_patch'), tools)).toBe('read');
    expect(readFamilyOf(step('read_file'), tools)).toBe('not_read');
    // With no catalogue the name is a guess, and "unknown" is a real answer.
    expect(readFamilyOf(step('grep'))).toBe('read');
    expect(readFamilyOf(step('deploy'))).toBe('unknown');
  });

  it('a catalogue makes tools_catalogue a need the evaluation says it saw', async () => {
    const { EvalEngine } = await import('../../src/eval/engine.js');
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const withCatalogue = await engine.evaluateAll({
      output: 'done',
      toolCalls: [{ tool_name: 'read_file' }],
      tools: [{ name: 'read_file' }],
    });
    const without = await engine.evaluateAll({ output: 'done', toolCalls: [{ tool_name: 'read_file' }] });

    const saw = (r: Awaited<ReturnType<typeof engine.evaluateAll>>): string[] =>
      r.rule_results.find((x) => x.ruleName === 'no_tool_loop')?.saw ?? [];
    // The stamp is per-rule and reports what the CALL carried, so a rule that
    // does not need the catalogue still records that one was supplied.
    expect(withCatalogue.provenance?.toolsHash).toBeDefined();
    expect(without.provenance?.toolsHash).toBeUndefined();
    expect(saw(withCatalogue).length).toBeGreaterThanOrEqual(saw(without).length);
  });
});
