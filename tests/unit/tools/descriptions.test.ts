/*
 * Every tool description comes from one template: five fixed headings in
 * order, a Returns heading generated from the output schema, a word cap,
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
import { DESCRIPTION_HEADINGS, DESCRIPTION_WORD_CAP, describeTool, wordCount } from '../../../src/tools/describe.js';
import { z } from 'zod';

const root = resolve(__dirname, '..', '..', '..');
const claims = JSON.parse(readFileSync(resolve(root, '.claims.json'), 'utf8')) as { proof?: { judge?: { status?: string } } };
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

  it('nine of nine carry the five headings in order', () => {
    expect(tools.length).toBe(9);
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

  it('none exceeds the word cap', () => {
    for (const t of tools) expect(wordCount(t.description ?? ''), t.name).toBeLessThanOrEqual(DESCRIPTION_WORD_CAP);
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
      for (const p of props) expect(returns, `${t.name}: ${p}`).toContain(`\`${p}\``);
    }
  });

  it('describeTool refuses an undescribed output field and an overlong description', () => {
    const base = { summary: 's', does: 'd', whenNot: 'w', errors: 'e', siblings: { log_trace: 'x', get_traces: 'y' } };
    expect(() => describeTool({ ...base, returns: z.looseObject({ a: z.string() }) })).toThrow(/no description/);
    expect(() => describeTool({ ...base, does: 'word '.repeat(DESCRIPTION_WORD_CAP), returns: z.looseObject({ a: z.string().describe('a') }) })).toThrow(/the cap is/);
  });
});
