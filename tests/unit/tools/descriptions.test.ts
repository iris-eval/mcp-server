/*
 * Every tool description comes from one template: five fixed headings in
 * order, a Returns heading generated from the output schema, a size cap,
 * siblings that are registered tools, and none of the phrases the truth
 * patch removed (era stamps, status numbers, a hosted tier, "calibrated"
 * while the judge measurement is pending).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { DESCRIPTION_BYTE_CAP, DESCRIPTION_HEADINGS, describeTool, descriptionBytes } from '../../../src/tools/describe.js';
import { z } from 'zod';

const root = resolve(__dirname, '..', '..', '..');
const claims = JSON.parse(readFileSync(resolve(root, '.claims.json'), 'utf8')) as {
  proof?: { judge?: { status?: string } };
  mcpTools: { count: number };
};
const judgeMeasured = claims.proof?.judge?.status === 'measured';

describe('tool descriptions', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let tools: Array<{ name: string; description?: string }>;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(defaultConfig, storage);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(s);
    client = new Client({ name: 'descriptions', version: '0.1.0' });
    await client.connect(c);
    tools = (await client.listTools()).tools;
  });
  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('every registered tool carries the five headings in order', () => {
    // Read from the truthbase, never typed: a literal here passes today and
    // rots at the next tool, which is the exact drift this repo keeps finding.
    expect(tools.length).toBe(claims.mcpTools.count);
    for (const t of tools) {
      const d = t.description ?? '';
      let last = -1;
      for (const h of DESCRIPTION_HEADINGS) {
        const at = d.indexOf(h);
        expect(at, `${t.name} lacks "${h}"`).toBeGreaterThan(last);
        last = at;
      }
    }
  });

  it('none exceeds the size cap', () => {
    // tools/list is paid for in context on every session of the agent being
    // evaluated; the long form of each tool is served in iris://capabilities.
    for (const t of tools) expect(descriptionBytes(t.description ?? ''), t.name).toBeLessThanOrEqual(DESCRIPTION_BYTE_CAP);
  });

  it('none carries an era stamp, a status number, a hosted tier, or an unmeasured "calibrated"', () => {
    for (const t of tools) {
      const d = t.description ?? '';
      expect(d, `${t.name}: era stamp`).not.toMatch(/\bv0\.\d/);
      expect(d, `${t.name}: status number`).not.toMatch(/\b[1-5]\d\d\b/);
      expect(d, `${t.name}: cloud tier`).not.toMatch(/cloud tier/i);
      if (!judgeMeasured) expect(d, `${t.name}: calibrated`).not.toMatch(/\bcalibrated\b/i);
    }
  });

  it('every sibling named is a registered tool, and every tool names at least two', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const t of tools) {
      const d = t.description ?? '';
      const siblings = d.slice(d.indexOf('Siblings.'));
      const named = [...siblings.matchAll(/\b(log|get|delete|evaluate|list|deploy|verify)_[a-z_]+\b/g)].map((m) => m[0]);
      expect(named.length, t.name).toBeGreaterThanOrEqual(2);
      for (const n of named) expect(names.has(n), `${t.name} names ${n}`).toBe(true);
      expect(named, `${t.name} names itself`).not.toContain(t.name);
    }
  });

  it('the Returns heading is generated from the output schema and names every top-level field', async () => {
    const { tools: withSchemas } = await client.listTools();
    for (const t of withSchemas) {
      const props = Object.keys((t.outputSchema as { properties?: Record<string, unknown> })?.properties ?? {});
      expect(props.length, t.name).toBeGreaterThan(0);
      const returns = (t.description ?? '').slice((t.description ?? '').indexOf('Returns.'), (t.description ?? '').indexOf('Errors.'));
      const named = new Set(returns.replace(/^Returns\. JSON: /, '').replace(/\.\s*$/, '').split(', '));
      for (const p of props) expect(named.has(p), `${t.name}: ${p}`).toBe(true);
    }
  });

  it('tools/list stays inside its context budget', async () => {
    // The whole list is sent to every session of the agent being evaluated.
    // It was 104,567 bytes before the long form moved to iris://capabilities;
    // a new tool or a regrown description has to fit here or say why not.
    const bytes = Buffer.byteLength(JSON.stringify(await client.listTools()), 'utf8');
    expect(bytes).toBeLessThanOrEqual(48_000);
  });

  it('iris://capabilities carries the long form of every tool: behaviour, errors, parameters, output fields', async () => {
    const { tools: listed } = await client.listTools();
    const read = await client.readResource({ uri: 'iris://capabilities' });
    const caps = JSON.parse((read.contents[0] as { text: string }).text) as {
      toolGuide: Record<string, { does: string; whenNot: string; errors: string; parameters?: Record<string, string>; returns: Record<string, string> }>;
    };
    for (const t of listed) {
      const g = caps.toolGuide[t.name];
      expect(g, t.name).toBeDefined();
      for (const part of [g.does, g.whenNot, g.errors]) expect(part.length, t.name).toBeGreaterThan(20);
      // Every advertised output field has its meaning in the guide.
      const fields = Object.keys((t.outputSchema as { properties: Record<string, unknown> }).properties);
      expect(Object.keys(g.returns).sort(), t.name).toEqual(fields.sort());
      for (const f of fields) expect(g.returns[f].length, `${t.name}.${f}`).toBeGreaterThan(0);
      // A long-form parameter names a parameter the tool takes.
      const params = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const p of Object.keys(g.parameters ?? {})) expect(params, `${t.name}: ${p}`).toContain(p.split('.')[0]);
    }
  });

  it('describeTool refuses an undescribed output field and an overlong description', () => {
    const base = { summary: 's', does: 'd', whenNot: 'w', errors: 'e', siblings: { log_trace: 'x', get_traces: 'y' } };
    expect(() => describeTool({ ...base, returns: z.looseObject({ a: z.string() }) })).toThrow(/no description/);
    expect(() => describeTool({ ...base, does: 'x'.repeat(DESCRIPTION_BYTE_CAP), returns: z.looseObject({ a: z.string().describe('a') }) })).toThrow(/the cap is/);
  });
});
