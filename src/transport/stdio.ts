import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';

/** JSON-RPC "Invalid Request": the message was read and is refused before any handler runs. */
const INVALID_REQUEST = -32600;

export interface StdioTransportOptions {
  /**
   * The largest message, in bytes, handed to the server: the same number
   * that bounds an HTTP request body (`security.requestSizeLimit`, see
   * src/utils/size-limit.ts). Absent: no limit beyond the SDK's own buffer.
   */
  maxMessageBytes?: number;
  /** Told about each refused message, with its size. */
  onRefused?: (bytes: number, limit: number) => void;
  /** Streams to use instead of the process's own; tests pass these. */
  stdin?: Readable;
  stdout?: Writable;
}

/*
 * Stdio used to have no request size limit while HTTP refused any body
 * over `security.requestSizeLimit` with a 413. A message over the limit is
 * now refused the same way on both: a request gets a JSON-RPC error naming
 * its size and the setting, and never reaches a tool; an oversized
 * notification is dropped. The session stays open, which the SDK's own
 * `maxBufferSize` would not do (it closes the transport).
 *
 * The size measured is the message's compact JSON, which is what a
 * newline-delimited stdio client writes, so it matches the bytes on the
 * wire and the body an HTTP client would send.
 *
 * The check wraps whatever handler the server installs on `onmessage`
 * (the SDK assigns it in connect()), so it holds for every message from
 * the first one on.
 */
export function createStdioTransport(options: StdioTransportOptions = {}): StdioServerTransport {
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  const limit = options.maxMessageBytes;
  if (limit === undefined) return transport;

  let handler: StdioServerTransport['onmessage'];
  const guarded = (message: JSONRPCMessage): void => {
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (bytes <= limit) {
      handler?.(message);
      return;
    }
    options.onRefused?.(bytes, limit);
    if ('method' in message && 'id' in message) {
      void transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: INVALID_REQUEST,
          message:
            `Request too large: ${bytes} bytes, over the ${limit}-byte limit (security.requestSizeLimit). ` +
            'The same limit applies over HTTP, where the request is refused with 413. Send less text, or raise the limit in the server config.',
        },
      });
    }
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => (handler ? guarded : undefined),
    set: (fn: StdioServerTransport['onmessage']) => {
      handler = fn;
    },
  });
  return transport;
}
