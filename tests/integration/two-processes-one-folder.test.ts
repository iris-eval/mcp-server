/*
 * Two server processes on one data folder.
 *
 * `install` gives every MCP client its own server process, and they all
 * point at the same home. Each process read the deployed rules once, at
 * start, and wrote its own copy back on every change. So a rule deployed
 * through one client was not applied by the others, two processes stamped
 * different ruleset hashes on the same output at the same moment, and the
 * next deploy from a process that started earlier deleted every rule
 * deployed since.
 *
 * This starts two real servers over stdio on one home and holds each of
 * those: a rule deployed through A decides B's next evaluation, both stamp
 * one ruleset hash, a deploy through B keeps A's rule, a rule switched off
 * through A stops firing in B, and B's verdict says the rules under it
 * changed.
 *
 * A server looks for another process's changes at most once every 20 ms
 * (eval/shared-state.ts, CHECK_EVERY_MS), so each step here that crosses
 * from one server to the other waits that long first. A person or an agent
 * moving between clients never arrives sooner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Json = Record<string, unknown>;
const serverPath = resolve(import.meta.dirname, '../../src/index.ts');
/** Longer than CHECK_EVERY_MS: the other server's next evaluation looks at the file again. */
const acrossProcesses = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

function body(result: unknown): Json {
  const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
  return JSON.parse(text) as Json;
}

describe('two server processes on one data folder', () => {
  let home: string;
  const clients: Client[] = [];

  async function server(name: string): Promise<Client> {
    const client = new Client({ name, version: '0.1.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', serverPath],
        env: { ...getDefaultEnvironment(), IRIS_HOME: home, IRIS_LOG_LEVEL: 'error' },
      }),
    );
    clients.push(client);
    return client;
  }

  const call = async (client: Client, name: string, args: Json): Promise<Json> => {
    const result = await client.callTool({ name, arguments: args });
    expect((result as { isError?: boolean }).isError, JSON.stringify(result)).toBeFalsy();
    return body(result);
  };
  const judge = (client: Client, output: string): Promise<Json> => call(client, 'evaluate_output', { output, eval_type: 'custom' });
  const ran = (evaluation: Json): string[] => (evaluation.rule_results as Array<{ ruleName: string }>).map((r) => r.ruleName);
  const deploy = (client: Client, name: string, pattern: string): Promise<Json> =>
    call(client, 'deploy_rule', { name, eval_type: 'custom', severity: 'high', definition: { type: 'regex_no_match', config: { pattern } } });
  const stored = (): string[] => (JSON.parse(readFileSync(join(home, 'custom-rules.json'), 'utf8')) as { rules: Array<{ name: string }> }).rules.map((r) => r.name).sort();

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'iris-two-processes-'));
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // An exiting server can hold its database for a moment on Windows; a scratch directory left under the OS temp dir is harmless.
    }
  });

  it('a rule deployed through one process decides the other process\'s next evaluation, and neither process deletes the other\'s rules', async () => {
    const a = await server('client-a');
    const b = await server('client-b');

    // Both have read the (empty) rules file by now: each has judged once.
    expect(ran(await judge(a, 'We recommend Acme.'))).toEqual([]);
    expect(ran(await judge(b, 'We recommend Acme.'))).toEqual([]);

    const first = await deploy(a, 'no-competitor', 'Acme');
    await acrossProcesses();

    // B never restarted. Its next evaluation runs A's rule and fails on it.
    const inB = await judge(b, 'We recommend Acme.');
    expect(ran(inB)).toEqual(['no-competitor']);
    expect(inB.passed).toBe(false);

    // One ruleset, one hash, whichever process is asked.
    const inA = await judge(a, 'We recommend Acme.');
    expect((inB.provenance as Json).rulesetHash).toBe((inA.provenance as Json).rulesetHash);

    // B's verdict says the rules under it changed, though the change was made through A.
    expect(inB.rules_changed).toMatchObject({ count: 1, audit: 'iris://audit' });

    // A deploy through B is made on what the file holds now, so A's rule survives it; then one more through A.
    await deploy(b, 'no-other-competitor', 'Globex');
    await deploy(a, 'no-third-competitor', 'Initech');
    expect(stored()).toEqual(['no-competitor', 'no-other-competitor', 'no-third-competitor']);
    await acrossProcesses();
    for (const client of [a, b]) {
      expect(ran(await judge(client, 'A plain answer.')).sort()).toEqual(['no-competitor', 'no-other-competitor', 'no-third-competitor']);
    }

    // Switched off through A, it stops firing in B.
    await call(a, 'delete_rule', { rule_id: first.id ?? (first.rule as Json | undefined)?.id, enabled: false });
    await acrossProcesses();
    const after = await judge(b, 'We recommend Acme.');
    expect(ran(after).sort()).toEqual(['no-other-competitor', 'no-third-competitor']);
    expect(after.passed).toBe(true);

    // Deleted through B, it is gone for A too, and the other two are still there.
    await call(b, 'delete_rule', { rule_id: first.id ?? (first.rule as Json | undefined)?.id });
    expect(stored()).toEqual(['no-other-competitor', 'no-third-competitor']);
    const listed = await call(a, 'list_rules', {});
    expect(JSON.stringify(listed)).not.toContain('"no-competitor"');
    expect(JSON.stringify(listed)).toContain('no-third-competitor');
  }, 240_000);
});
