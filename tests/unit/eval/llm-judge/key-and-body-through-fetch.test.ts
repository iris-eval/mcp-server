/*
 * What the judge client refuses before a request, and how it reads a reply's
 * body, held to Node's own fetch against a server on this machine. A key is
 * refused exactly where fetch would not send it, for either provider and at
 * any place in the key, and the value fetch sends is the value the client
 * sends. A reply whose compressed body arrives and cannot be decoded is a
 * malformed reply, at any success status, and one cut off by its connection is
 * the provider not reached; with an error status, the status decides.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { callLLMJudge, type LLMJudgeError } from '../../../../src/eval/llm-judge/client.js';

const realFetch = globalThis.fetch;
const VERDICT = '{"score":0.9,"passed":true,"rationale":"on the subject"}';
const REPLY = {
  anthropic: JSON.stringify({ id: 'm', content: [{ type: 'text', text: VERDICT }], usage: { input_tokens: 10, output_tokens: 5 } }),
  openai: JSON.stringify({ id: 'c', choices: [{ message: { content: VERDICT }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
};
const MODEL = { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini' } as const;

let server: Server;
let base = '';
/** How the server here answers the next request. */
let answer: (res: ServerResponse) => void = (res) => res.end();
/** The key each request carried, as the server here received it. */
const received: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      received.push(String(req.headers['x-api-key'] ?? req.headers.authorization ?? ''));
      answer(res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

/** The client's requests reach the server here through Node's own fetch, with the headers and body the client made. */
function throughHere(): void {
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => realFetch(base, init)) as typeof fetch;
}

/** One judge call, read as what it answered or the kind and message it failed with. */
function judge(provider: 'anthropic' | 'openai', apiKey = 'sk-test'): Promise<string> {
  return callLLMJudge({ provider, model: MODEL[provider], systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 100, temperature: 0, apiKey }).then(
    (r) => `answered: ${r.content}`,
    (e: LLMJudgeError) => `${e.kind}: ${e.message}`,
  );
}

describe("a key is refused before any request exactly where Node's fetch would not send it", () => {
  it('every code unit from 0x00 to 0xff and five past it, at the start of the key, inside it and at its end, for each provider', async () => {
    const units = [...Array.from({ length: 256 }, (_, unit) => unit), 0x100, 0x2019, 0x200b, 0xfeff, 0xfffd];
    const header = {
      anthropic: (key: string): Record<string, string> => ({ 'x-api-key': key }),
      openai: (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` }),
    };
    const refused: Record<string, number> = {};
    for (const provider of ['anthropic', 'openai'] as const) {
      answer = (res) => res.end(REPLY[provider]);
      for (const at of ['start', 'inside', 'end'] as const) {
        for (const unit of units) {
          const c = String.fromCharCode(unit);
          const apiKey = at === 'start' ? `${c}sk-test` : at === 'inside' ? `sk-te${c}st` : `sk-test${c}`;
          const what = `${provider}, 0x${unit.toString(16)} at the ${at}`;
          // What Node's fetch does with the key's header, called directly.
          const before = received.length;
          const sent = await realFetch(base, { method: 'POST', headers: header[provider](apiKey), body: '{}' }).then(
            (r) => r.text().then(() => true),
            () => false,
          );
          expect(received.length - before, what).toBe(sent ? 1 : 0);
          throughHere();
          const answered = await judge(provider, apiKey);
          globalThis.fetch = realFetch;
          if (sent) {
            expect(answered, what).toBe(`answered: ${VERDICT}`);
            // The server here received from the client the value it received from fetch.
            expect(received.length - before, what).toBe(2);
            expect(received[received.length - 1], what).toBe(received[received.length - 2]);
          } else {
            expect(answered, what).toMatch(/^auth: (Anthropic|OpenAI) API key cannot be sent in a request header: .* No request was made\.$/);
            expect(received.length - before, what).toBe(0);
            refused[`${provider} ${at}`] = (refused[`${provider} ${at}`] ?? 0) + 1;
          }
        }
      }
    }
    // Inside a key, fetch sends none of the 32 ASCII control characters but a tab (0x00 to 0x08, 0x0a to 0x1f, 0x7f), nor the five past 0xff.
    // At an end, a line break and a carriage return are dropped and the key is sent, but at the start of OpenAI's, which follows "Bearer ".
    expect(refused).toEqual({ 'anthropic start': 35, 'anthropic inside': 37, 'anthropic end': 35, 'openai start': 37, 'openai inside': 37, 'openai end': 35 });
  }, 120_000);
});

describe('a reply whose compressed body arrives and cannot be decoded is a malformed reply, and one cut off is the provider not reached', () => {
  const DICTIONARY = Buffer.from('a dictionary the reader of this body does not have');
  const replying = (status: number, headers: Record<string, string>, body: Buffer | string) => (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  };

  it.each([200, 201, 206, 299])('with status %i', async (status) => {
    throughHere();
    const decoded = (code: string): string => `malformed_response: Anthropic reply could not be decoded: terminated (${code})`;

    answer = replying(status, { 'content-encoding': 'gzip' }, REPLY.anthropic);
    expect(await judge('anthropic'), 'a plain body marked gzip').toBe(decoded('Z_DATA_ERROR'));
    answer = replying(status, { 'content-encoding': 'deflate' }, deflateSync(REPLY.anthropic, { dictionary: DICTIONARY }));
    expect(await judge('anthropic'), 'a deflate body made with a preset dictionary').toBe(decoded('Z_NEED_DICT'));
    answer = replying(status, { 'content-encoding': 'br' }, REPLY.anthropic);
    expect(await judge('anthropic'), 'a plain body marked br').toMatch(/^malformed_response: Anthropic reply could not be decoded: terminated \(ERR__ERROR_[A-Z0-9_]+\)$/);
    const flipped = gzipSync(REPLY.anthropic);
    flipped[flipped.length - 6] ^= 0xff;
    answer = replying(status, { 'content-encoding': 'gzip' }, flipped);
    expect(await judge('anthropic'), 'a gzip body with a byte of its check changed').toBe(decoded('Z_DATA_ERROR'));
    answer = replying(status, { 'content-encoding': 'gzip' }, REPLY.openai);
    expect(await judge('openai'), "OpenAI's plain body marked gzip").toBe('malformed_response: OpenAI reply could not be decoded: terminated (Z_DATA_ERROR)');

    // A body in each encoding that decodes is answered.
    for (const [encoding, body] of [['gzip', gzipSync(REPLY.anthropic)], ['deflate', deflateSync(REPLY.anthropic)], ['br', brotliCompressSync(REPLY.anthropic)]] as const) {
      answer = replying(status, { 'content-encoding': encoding }, body);
      expect(await judge('anthropic'), encoding).toBe(`answered: ${VERDICT}`);
    }

    // A body its connection cuts off, plain or compressed, is the provider not reached.
    for (const [what, headers, body] of [
      ['a plain body', {}, Buffer.from(REPLY.anthropic)],
      ['a gzip body', { 'content-encoding': 'gzip' }, gzipSync(REPLY.anthropic)],
    ] as const) {
      answer = (res) => {
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length + 100), ...headers });
        res.write(body.subarray(0, Math.floor(body.length / 2)), () => res.socket?.destroy());
      };
      expect(await judge('anthropic'), `${what}, cut off`).toBe('unreachable: Anthropic reply was cut off before its end: terminated (UND_ERR_SOCKET)');
    }
  });

  it('with an error status, a body that cannot be decoded is read as empty, and the status decides', async () => {
    throughHere();
    answer = replying(503, { 'content-encoding': 'gzip' }, REPLY.anthropic);
    expect(await judge('anthropic')).toMatch(/^server_error: /);
    answer = replying(400, { 'content-encoding': 'br' }, REPLY.anthropic);
    expect(await judge('anthropic')).toMatch(/^bad_request: /);
  });
});
