/*
 * What a caller is told of a judge call that fails, and of its deadline:
 * the recovery of each kind this change wrote says what happened and what
 * to do; every kind a judge call fails with is named wherever the kinds are
 * listed (the capabilities resource, both lists of the API reference, the
 * citation doc's table); the default deadline is the one the tool's
 * description, the judge doc and the changelog name; and each sentence on a
 * rate limit, a key, a provider that cannot be reached and the deadline is
 * held word for word.
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
  it('the recovery of each kind this change wrote (auth, rate_limit, timeout, unreachable, malformed_response) says what happened and what to do', () => {
    const recovery = (kind: LLMJudgeError['kind']): unknown => toIrisError(new LLMJudgeError('m', kind)).envelope.recovery;
    expect(recovery('auth')).toEqual([
      'The key was refused: by the provider, or before any request where it holds an ASCII control character other than a tab inside it, such as a line break, or a character above U+00FF, such as a curly quote or a zero-width space. Check that the key in the env block of your MCP config is valid, live and copied whole, then restart the session.',
    ]);
    // True of each reply of the kind, and its advice the one each row of the judge doc gives: a reply that could not be decoded, a response that is
    // not JSON, one that ended at its output limit, a model that declined, and a judge's text that held no verdict.
    expect(recovery('malformed_response')).toEqual([
      "The provider answered, and its reply could not be read as a judgment: the message says why, and where the judge's text held no verdict, it shows what stood where the verdict belongs, or the start of it.",
      'Where the message says the reply could not be decoded, or the response was not JSON or not a JSON object, retry; if it recurs, check what stands between this server and the provider (a proxy can alter a reply).',
      'Where it says the reply ended at its output limit, raise max_output_tokens; where it says the model declined to answer, retry with another input or another model.',
      'Otherwise, retry; if it recurs, pick another model.',
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
    // The second list: what a citation's judge_error can hold.
    const judgeError = reference.match(/^\| `judge_error` \|[^|]*\| ([^|]*) \|\r?$/m);
    expect(judgeError, "the API reference's judge_error row").not.toBeNull();
    const table = read('docs/semantic-citation-verify.md');
    for (const kind of KINDS) {
      expect(toIrisError(new LLMJudgeError('m', kind)).envelope, kind).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind });
      expect(served, kind).toMatch(new RegExp(`IRIS_PROVIDER_ERROR with kind [^.]*\\b${kind}\\b`));
      expect(listed?.[1].split(' · '), kind).toContain(kind);
      expect(judgeError?.[1], kind).toContain(`\`${kind}\``);
      expect(table, kind).toMatch(new RegExp(`^\\| \`${kind}\` +\\| `, 'm'));
    }
  });
});

describe('each sentence on a rate limit, a key, a provider that cannot be reached and the deadline, word for word', () => {
  const one = (s: string): string => s.replace(/\r\n/g, '\n');

  it('a rate limit is asked again only where its wait ends before the deadline: the guide, its rendering, the judge doc and the citation doc', () => {
    // The sentence whole, whether it opens a sentence of its own or follows a semicolon.
    const asked = "ate-limited call is asked again once, where the provider's wait ends before the call's deadline.";
    for (const said of [toolGuide().evaluate_with_llm_judge.does, read('website/public/llms-full.txt')]) {
      expect(said).toMatch(/[.;] [Aa] rate-limited call is asked again once, where the provider's wait ends before the call's deadline\./);
      expect(said).toContain(asked);
    }
    const judge = one(read('docs/llm-as-judge.md'));
    expect(judge).toContain("2. **Provider-side limits** — a rate limit (429) is asked again once, after the wait `Retry-After` names, where that wait ends before the call's deadline; otherwise, and on a second 429, the call fails as `rate_limit`.");
    expect(judge).toContain("| Retries once, after the wait `Retry-After` (or Anthropic's reset time) names, or 2 s where none is named, when that wait ends before the call's deadline; otherwise, and on a second 429, throws `LLMJudgeError kind=rate_limit`, with the provider's wait as `retryAfterMs` where it named one |");
    expect(read('docs/semantic-citation-verify.md')).toContain("| The provider rate-limited the call: asked again once where its wait ended before the call's deadline, else answered at once |");
  });

  it('a key, a provider that cannot be reached, and the deadline: the rows of both docs', () => {
    const judge = one(read('docs/llm-as-judge.md'));
    expect(judge).toContain('| `Anthropic API key cannot be sent in a request header` | Throws `LLMJudgeError kind=auth` before any request where the key holds an ASCII control character other than a tab inside it, such as a line break, or a character above U+00FF, such as a curly quote or a zero-width space. The key is not shown |');
    expect(judge).toContain('| `Anthropic could not be reached: fetch failed (ECONNREFUSED)` | `LLMJudgeError kind=unreachable`: the request could not be made, or a reply with a success status was cut off before its end (a reply with an error status is read by its status) |');
    expect(judge).toContain('| `Anthropic reply could not be decoded: terminated (Z_DATA_ERROR)` | `LLMJudgeError kind=malformed_response` at once; not asked again: a reply with a success status whose compressed body arrived and could not be decoded | Retry; if it recurs, check what stands between this server and the provider (a proxy can alter a reply) |');
    expect(judge).toContain("Every request, its whole reply and the wait after a rate limit share it, so the call answers before an MCP client's own 60-second timeout");
    const cite = one(read('docs/semantic-citation-verify.md'));
    expect(cite).toContain('| The key was refused: by the provider, or before any request where it holds an ASCII control character other than a tab inside it, such as a line break, or a character above U+00FF, such as a curly quote or a zero-width space |');
    // A tab and the controls from 0x80 to 0x9f are sent: no sentence on a key says "another control character", or counts a character's bytes.
    for (const [file, text] of [['docs/llm-as-judge.md', judge], ['docs/semantic-citation-verify.md', cite], ['src/tools/errors.ts', read('src/tools/errors.ts')], ['src/eval/llm-judge/client.ts', read('src/eval/llm-judge/client.ts')]]) {
      expect(text, file).not.toMatch(/another control character|past one byte/);
    }
    expect(cite).toContain('| The provider could not be reached, or a reply with a success status was cut off before its end |');
    expect(cite).toContain("| The provider's reply was not of the shape its API documents, its compressed body could not be decoded, or it held no answer: an OpenAI model declined (its `refusal`), or its reply reached its output limit before any answer (`finish_reason: \"length\"`). The message says which |");
    expect(read('src/eval/llm-judge/deadline.ts')).toContain('client built on the TypeScript SDK gives up on a request after 60 seconds');
  });

  it("the changelog's entry: each kind's retry, the key, the rate limit, the time taken, and what a caller sees after upgrading", () => {
    const entry = one(read('CHANGELOG.md')).split("- **A judge call answers inside its caller's own timeout.**")[1]?.split('\n- **')[0];
    expect(entry, 'the entry').toBeDefined();
    for (const sentence of [
      'is `IRIS_PROVIDER_ERROR` with `kind: "unreachable"`, which is retryable,',
      'when the judge could not be reached for any citation, `IRIS_JUDGE_FAILED` is retryable.',
      'An API key the runtime cannot send in a request header (one holding an ASCII control character other than a tab inside it, such as a line break, or a character above U+00FF, such as a curly quote or a zero-width space copied with it) is `IRIS_PROVIDER_ERROR` with `kind: "auth"` and no request is made, where it was the internal error with the runtime\'s sentence, which quoted the key when a line break, a carriage return or a NUL was inside it (#1080).',
      'A reply whose compressed body arrives whole and cannot be decoded is `malformed_response`, as it was, and now says it could not be decoded (#1081).',
      'The advice of that kind now follows what its message names: for such a reply, or a response that is not JSON or not a JSON object, what stands between this server and the provider; for a reply that ended at its output limit, a higher `max_output_tokens`; for a model that declined, another input or another model; otherwise another model, which it named for every reply. `verify_citations` names that kind in its advice when it fails every citation.',
      'A rate limit is asked again once only where its wait ends before the deadline; otherwise it is answered at once, with the wait the provider named in `retryAfterMs` (none where it named none).',
      "`latency_ms` runs to the end of the reply's body, where it ended when the reply began.",
      '(of eleven such shapes tried, five gave the verdict of a text block among the entries, three were already a malformed reply, and three were the internal error)',
      'a text that is not a string, at once, where the evaluator asked again and could read the verdict from a second reply;',
      'gives up at 50 seconds, where each request had 60;',
    ]) {
      expect(entry, sentence).toContain(sentence);
    }
    // What the entry said of a key and a reply before, which is not so: it is not said beside what is.
    for (const gone of [
      'A key holding another control character passes that check, and the runtime then refuses to send it',
      'told as cut off, where it was `malformed_response` (#1081)',
      'another control character',
      'past one byte',
    ]) {
      expect(entry, gone).not.toContain(gone);
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
