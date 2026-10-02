/*
 * The audit log says what a rule was, and a change that cannot be recorded
 * is not made.
 *
 * An entry held the rule's id, name and severity and never its content, so
 * a rule swapped for another under the same name left two entries nobody
 * could tell apart. And the append sat inside `try { } catch { }`: on a
 * read-only or full disk a rule could be deployed, disabled or deleted, or
 * a trace removed, with no record at all, in the one file that says who
 * changed the rules a verdict was produced under.
 *
 * Each entry now carries the sha256 of the rule's definition and severity
 * (the same hash the ruleset fingerprint carries), the entry is written
 * BEFORE the change, and a failed write refuses the change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditWriteError, createCustomRuleStore } from '../../src/custom-rule-store.js';
import { ruleContentHash } from '../../src/eval/rules/custom.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { CustomRuleDefinition } from '../../src/types/eval.js';

let dir: string;
let rulesPath: string;
let auditPath: string;
/** A path no file can be created at: its parent is a regular file. */
let unwritable: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-audit-'));
  rulesPath = join(dir, 'custom-rules.json');
  auditPath = join(dir, 'audit.log');
  writeFileSync(join(dir, 'a-file'), 'not a directory');
  unwritable = join(dir, 'a-file', 'audit.log');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const BLOCKS: CustomRuleDefinition = { name: 'no-competitor', type: 'regex_no_match', config: { pattern: 'Acme' } };
const NO_OP: CustomRuleDefinition = { name: 'no-competitor', type: 'regex_no_match', config: { pattern: 'zzzz-never-present' } };
const deployInput = (definition: CustomRuleDefinition) => ({ name: definition.name, evalType: 'custom' as const, severity: 'high' as const, definition });
const entries = (): Array<{ action: string; ruleId?: string; details?: { contentSha256?: string; enabled?: boolean } }> =>
  readFileSync(auditPath, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { action: string; ruleId?: string; details?: { contentSha256?: string; enabled?: boolean } });

describe('an audit entry says what the rule was', () => {
  it('deploy, toggle and delete each carry the hash of the definition and severity', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const rule = store.deploy(LOCAL_TENANT, deployInput(BLOCKS));
    store.setEnabled(LOCAL_TENANT, rule.id, false);
    store.delete(LOCAL_TENANT, rule.id);
    const hash = ruleContentHash(BLOCKS, 'high');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entries().map((e) => [e.action, e.details?.contentSha256])).toEqual([
      ['rule.deploy', hash],
      ['rule.toggle', hash],
      ['rule.delete', hash],
    ]);
  });

  it('a rule swapped for another under the same name leaves two hashes: the swap is visible', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const first = store.deploy(LOCAL_TENANT, deployInput(BLOCKS));
    store.delete(LOCAL_TENANT, first.id);
    store.deploy(LOCAL_TENANT, deployInput(NO_OP));
    const [deployed, removed, redeployed] = entries();
    expect(removed.details?.contentSha256).toBe(deployed.details?.contentSha256);
    expect(redeployed.details?.contentSha256).not.toBe(deployed.details?.contentSha256);
    expect(redeployed.details?.contentSha256).toBe(ruleContentHash(NO_OP, 'high'));
  });
});

describe('a change that cannot be recorded is not made', () => {
  it('deploy is refused, and nothing is written or held in memory', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath: unwritable });
    expect(() => store.deploy(LOCAL_TENANT, deployInput(BLOCKS))).toThrow(AuditWriteError);
    expect(store.list(LOCAL_TENANT)).toEqual([]);
    expect(existsSync(rulesPath)).toBe(false);
    expect(store.changesSinceStart(LOCAL_TENANT)).toBeNull();
  });

  it('delete and toggle are refused, and the rule stays as it was, in memory and on disk', () => {
    const rule = createCustomRuleStore({ pathFor: () => rulesPath, auditPath }).deploy(LOCAL_TENANT, deployInput(BLOCKS));
    const before = readFileSync(rulesPath, 'utf-8');
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath: unwritable });
    expect(() => store.delete(LOCAL_TENANT, rule.id)).toThrow(AuditWriteError);
    expect(() => store.setEnabled(LOCAL_TENANT, rule.id, false)).toThrow(/could not be written, so the change was refused/);
    expect(store.get(LOCAL_TENANT, rule.id)).toMatchObject({ id: rule.id, enabled: true });
    expect(readFileSync(rulesPath, 'utf-8')).toBe(before);
  });
});

describe('over the MCP tools', () => {
  let client: Client;
  let storage: SqliteAdapter;

  async function connect(audit: string): Promise<void> {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const ruleStore = createCustomRuleStore({ pathFor: () => rulesPath, auditPath: audit });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(s);
    client = new Client({ name: 'audit-fail-closed', version: '0.1.0' });
    await client.connect(c);
  }
  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  const textOf = (r: unknown): string => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '');

  it('deploy_rule answers IRIS_STORAGE_ERROR and deploys nothing', async () => {
    await connect(unwritable);
    const r = await client.callTool({ name: 'deploy_rule', arguments: { name: 'no-competitor', eval_type: 'custom', severity: 'high', definition: { type: 'regex_no_match', config: { pattern: 'Acme' } } } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('IRIS_STORAGE_ERROR');
    expect(textOf(r)).toContain('so the change was refused');
    const listed = await client.callTool({ name: 'list_rules', arguments: {} });
    expect(textOf(listed)).not.toContain('no-competitor');
  });

  it('delete_trace is refused, and the trace is still there', async () => {
    await connect(unwritable);
    const logged = JSON.parse(textOf(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'support-bot', input: 'q', output: 'The refund window is thirty days.' } }))) as { trace_id: string };
    const r = await client.callTool({ name: 'delete_trace', arguments: { trace_id: logged.trace_id } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('IRIS_STORAGE_ERROR');
    expect(await storage.getTrace(LOCAL_TENANT, logged.trace_id)).not.toBeNull();
  });

  it('delete_trace records the deletion before it deletes, and an unknown trace writes no entry', async () => {
    await connect(auditPath);
    const logged = JSON.parse(textOf(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'support-bot', input: 'q', output: 'The refund window is thirty days.' } }))) as { trace_id: string };
    const missing = JSON.parse(textOf(await client.callTool({ name: 'delete_trace', arguments: { trace_id: 'f'.repeat(32) } }))) as { deleted: boolean };
    expect(missing.deleted).toBe(false);
    expect(existsSync(auditPath)).toBe(false);
    const done = JSON.parse(textOf(await client.callTool({ name: 'delete_trace', arguments: { trace_id: logged.trace_id } }))) as { deleted: boolean };
    expect(done.deleted).toBe(true);
    expect(readFileSync(auditPath, 'utf-8')).toContain(`"action":"trace.delete"`);
    expect(await storage.getTrace(LOCAL_TENANT, logged.trace_id)).toBeNull();
  });
});
