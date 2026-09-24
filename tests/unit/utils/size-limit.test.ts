/*
 * One request size limit for every transport. `security.requestSizeLimit`
 * used to bound HTTP bodies only; a 2 MB output was refused over HTTP and
 * evaluated over stdio. These tests pin the parser both transports read and
 * the stdio refusal itself, over real streams.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { parseSizeLimit, requestSizeLimitBytes } from '../../../src/utils/size-limit.js';
import { createStdioTransport } from '../../../src/transport/stdio.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { validateConfigFile } from '../../../src/config/schema.js';

describe('parseSizeLimit', () => {
  it('reads sizes the way express does: binary units, bare numbers as bytes', () => {
    expect(parseSizeLimit('1mb')).toBe(1024 * 1024);
    expect(parseSizeLimit('1MB')).toBe(1024 * 1024);
    expect(parseSizeLimit('500kb')).toBe(500 * 1024);
    expect(parseSizeLimit('1.5mb')).toBe(1.5 * 1024 * 1024);
    expect(parseSizeLimit('1048576')).toBe(1048576);
    expect(parseSizeLimit('2 mb')).toBe(2 * 1024 * 1024);
  });

  it('refuses what is not a size, instead of meaning "no limit"', () => {
    for (const bad of ['', 'big', '1 megabyte', '-1mb', '0', 'mb']) expect(parseSizeLimit(bad)).toBeNull();
    expect(() => requestSizeLimitBytes('big')).toThrow(/security\.requestSizeLimit "big" is not a size/);
  });

  it('the shipped default is 1 MiB', () => {
    expect(requestSizeLimitBytes(defaultConfig.security.requestSizeLimit)).toBe(1024 * 1024);
  });
});

describe('config: security.requestSizeLimit', () => {
  it('accepts a size and refuses a value that is not one, by name', () => {
    expect(() => validateConfigFile({ security: { requestSizeLimit: '2mb' } }, 'config.json')).not.toThrow();
    expect(() => validateConfigFile({ security: { requestSizeLimit: 'lots' } }, 'config.json')).toThrow(/requestSizeLimit/);
  });
});

/** A stdio transport over in-memory streams, with the server's handler recorded. */
function harness(maxMessageBytes: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const refused: number[] = [];
  const transport = createStdioTransport({ maxMessageBytes, stdin, stdout, onRefused: (bytes) => refused.push(bytes) });
  const handled: JSONRPCMessage[] = [];
  // What the SDK's connect() does: install the handler, then start.
  transport.onmessage = (m) => handled.push(m);
  const replies: string[] = [];
  stdout.on('data', (chunk: Buffer) => replies.push(...chunk.toString('utf8').split('\n').filter(Boolean)));
  return {
    transport,
    handled,
    refused,
    replies,
    async send(message: object) {
      stdin.write(JSON.stringify(message) + '\n');
      await new Promise((r) => setImmediate(r));
    },
  };
}

function toolCall(id: number, outputChars: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'evaluate_output', arguments: { output: 'x'.repeat(outputChars) } },
  };
}

describe('stdio transport size limit', () => {
  const LIMIT = 1024 * 1024;

  it('passes a message under the limit to the server untouched', async () => {
    const h = harness(LIMIT);
    await h.transport.start();
    await h.send(toolCall(1, 1000));
    expect(h.handled).toHaveLength(1);
    expect(h.replies).toHaveLength(0);
    await h.transport.close();
  });

  it('refuses a 2 MB request with a JSON-RPC error naming the size and the setting, and never runs it', async () => {
    const h = harness(LIMIT);
    await h.transport.start();
    await h.send(toolCall(7, 2 * 1024 * 1024));
    expect(h.handled).toHaveLength(0);
    expect(h.refused).toHaveLength(1);
    expect(h.refused[0]).toBeGreaterThan(LIMIT);
    const reply = JSON.parse(h.replies[0]) as { id: number; error: { code: number; message: string } };
    expect(reply.id).toBe(7);
    expect(reply.error.code).toBe(-32600);
    expect(reply.error.message).toContain(`${LIMIT}-byte limit`);
    expect(reply.error.message).toContain('security.requestSizeLimit');
    await h.transport.close();
  });

  it('keeps the session open: the next request under the limit is served', async () => {
    const h = harness(LIMIT);
    await h.transport.start();
    await h.send(toolCall(1, 2 * 1024 * 1024));
    await h.send(toolCall(2, 10));
    expect(h.handled).toHaveLength(1);
    expect((h.handled[0] as { id: number }).id).toBe(2);
    await h.transport.close();
  });

  it('drops an oversized notification without replying (a notification has no id to answer)', async () => {
    const h = harness(1000);
    await h.transport.start();
    await h.send({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'x'.repeat(2000) } });
    expect(h.handled).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
    expect(h.refused).toHaveLength(1);
    await h.transport.close();
  });

  it('with no limit given, behaves as the SDK transport', async () => {
    const stdin = new PassThrough();
    const transport = createStdioTransport({ stdin, stdout: new PassThrough() });
    const handled: JSONRPCMessage[] = [];
    transport.onmessage = (m) => handled.push(m);
    await transport.start();
    stdin.write(JSON.stringify(toolCall(1, 2 * 1024 * 1024)) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(handled).toHaveLength(1);
    await transport.close();
  });
});
