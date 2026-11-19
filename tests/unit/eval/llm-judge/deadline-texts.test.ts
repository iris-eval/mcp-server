/*
 * What a caller is told of a judge call that fails, and of its deadline:
 * each kind's recovery says what happened and what to do; every kind a
 * judge call fails with is named wherever the kinds are listed (the
 * capabilities resource, the API reference, the citation doc's table); and
 * the default deadline is the one the tool's description, the judge doc and
 * the changelog name.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LLMJudgeError } from '../../../../src/eval/llm-judge/client.js';
import { DEFAULT_JUDGE_DEADLINE_MS } from '../../../../src/eval/llm-judge/deadline.js';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../../src/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { toolGuide } from '../../../../src/tools/guide.js';
import { toIrisError } from '../../../../src/tools/errors.js';

const root = resolve(__dirname, '..', '..', '..', '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** Every kind a judge call fails with. `unknown` is declared and never thrown. */
const KINDS = ['auth', 'rate_limit', 'bad_request', 'server_error', 'timeout', 'unreachable', 'malformed_response'] as const;
// A kind added to LLMJudgeError and not to this list fails to compile here.
type Unlisted = Exclude<LLMJudgeError['kind'], (typeof KINDS)[number] | 'unknown'>;
const everyKindListed: [Unlisted] extends [never] ? true : false = true;

describe('what a caller is told of a judge call that fails', () => {
  it("each kind's recovery says what happened and what to do", () => {
    const recovery = (kind: LLMJudgeError['kind']): unknown => toIrisError(new LLMJudgeError('m', kind)).envelope.recovery;
    expect(recovery('auth')).toEqual([
      'The key was refused: by the provider, or before any request where it holds a character a request header cannot carry. Check that the key in the env block of your MCP config is valid, live and copied whole, then restart the session.',
    ]);
    expect(recovery('rate_limit')).toEqual([
      "The provider rate-limited the call. Wait (retryAfterMs, where the provider named a wait) and retry. Iris asks once more itself only where the provider's wait ends before the call's deadline.",
    ]);
    expect(recovery('timeout')).toEqual([
      "The provider did not answer within timeout_ms, which every request, its reply and the wait after a rate limit share. Retry, or raise timeout_ms within your client's own request timeout.",
    ]);
    expect(recovery('unreachable')).toEqual([
      'Iris could not reach the provider, or its reply was cut off before its end. Check that this server can reach it (its network, a proxy), then retry.',
    ]);
  });

  it('every kind a judge call fails with is named wherever the kinds are listed', () => {
    expect(everyKindListed).toBe(true);
    const served = toolGuide().evaluate_with_llm_judge.errors;
    const reference = read('docs/api-reference.md');
    const listed = reference.match(/`IRIS_PROVIDER_ERROR` \(`kind`: ([^)]*)\)/);
    expect(listed, 'the API reference lists the kinds').not.toBeNull();
    const table = read('docs/semantic-citation-verify.md');
    for (const kind of KINDS) {
      expect(toIrisError(new LLMJudgeError('m', kind)).envelope, kind).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind });
      expect(served, kind).toMatch(new RegExp(`IRIS_PROVIDER_ERROR with kind [^.]*\\b${kind}\\b`));
      expect(listed?.[1].split(' · '), kind).toContain(kind);
      expect(table, kind).toMatch(new RegExp(`^\\| \`${kind}\` +\\| `, 'm'));
    }
  });
});

describe("the deadline's default is the one every text names", () => {
  let client: Client;
  let storage: SqliteAdapter;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(defaultConfig, storage);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(s);
    client = new Client({ name: 'deadline-texts', version: '0.1.0' });
    await client.connect(c);
  });
  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it("the tool's description of timeout_ms, the judge doc, the citation doc and the changelog", async () => {
    const { tools } = await client.listTools();
    const judge = tools.find((t) => t.name === 'evaluate_with_llm_judge');
    const timeout = (judge?.inputSchema as { properties?: Record<string, { description?: string }> }).properties?.timeout_ms?.description;
    expect(timeout).toBe(`The call's deadline in ms, which every request to the provider, its reply and the wait after a rate limit share; default ${DEFAULT_JUDGE_DEADLINE_MS}`);
    const ms = DEFAULT_JUDGE_DEADLINE_MS.toLocaleString('en-US');
    expect(read('docs/llm-as-judge.md')).toContain(`the call's deadline (\`timeout_ms\`, default ${ms}) passed`);
    expect(read('docs/llm-as-judge.md')).toContain(`| \`Anthropic did not answer within ${DEFAULT_JUDGE_DEADLINE_MS} ms\``);
    expect(read('docs/semantic-citation-verify.md')).toContain(`The judge call did not answer within its deadline (${DEFAULT_JUDGE_DEADLINE_MS / 1000} seconds)`);
    expect(read('CHANGELOG.md')).toContain(`the evaluator's second request has what the first left, and the default is ${ms} ms.`);
  });
});
