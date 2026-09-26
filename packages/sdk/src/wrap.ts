/*
 * wrapOpenAI / wrapAnthropic — every model call the client makes, recorded.
 *
 * The wrapper does not patch the client or proxy its methods. Both official
 * SDKs take a `fetch` option and both clone themselves with `withOptions`,
 * so the wrapper returns `client.withOptions({ fetch })`: a real client of
 * the same class, with every method the original has (create, parse, the
 * stream helpers, runTools, with_raw_response …), whose HTTP goes through a
 * fetch that watches the three model endpoints and passes everything else
 * through untouched. The original client is not changed.
 *
 * Each call to `/chat/completions`, `/responses` or `/messages` becomes one
 * OpenTelemetry GenAI span, recorded after the response has been read — for
 * a stream, when the stream ends or is cancelled — so the caller never waits
 * on Iris. A failed call is recorded too, with its error, and the error the
 * caller sees is the provider's, unchanged.
 */
import type { Api, Attributes, Json, StreamAssembler } from './genai.js';
import { assemblerFor, genAiSpan } from './genai.js';
import type { EvalType, IrisRecorder, SpanRecord } from './recorder.js';
import { defaultRecorder, newSpanId, newTraceId, nowNanos, programName } from './recorder.js';

export interface WrapOptions {
  /** Where the spans go. Default: one process-wide recorder, configured from `IRIS_URL` / `IRIS_API_KEY`. */
  recorder?: IrisRecorder;
  /** The agent these calls belong to (`service.name`). Default: the running program's name. */
  agentName?: string;
  /** The conversation these calls belong to (`gen_ai.conversation.id`); Iris groups a session's turns. */
  sessionId?: string;
  /** The batch these calls belong to (`iris.run`), for comparing runs. */
  run?: string;
  /** Ask Iris for a verdict on each call. Default: the recorder's setting (true). */
  evaluate?: boolean;
  /** The bundle to run. Default: the recorder's setting (every bundle). */
  evalType?: EvalType;
  /**
   * OpenAI Chat Completions streams carry no token usage unless asked. When
   * a streamed call does not set `stream_options`, the wrapper asks
   * (`include_usage: true`) and removes the usage-only final chunk before
   * your code sees the stream, so the chunks you read are the ones you would
   * have read unwrapped. Set false for an OpenAI-compatible server that
   * refuses `stream_options`. Default true.
   */
  streamUsage?: boolean;
}

const WRAPPED = Symbol.for('iris-eval.sdk.wrapped');

interface FetchCapable {
  fetch?: typeof globalThis.fetch;
  withOptions?: (options: Record<string, unknown>) => unknown;
}

function apiOf(path: string, method: string): Api | undefined {
  if (method !== 'POST') return undefined;
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/messages')) return 'messages';
  return undefined;
}

let warnedUnwrappable = false;

function wrapClient<T extends object>(client: T, provider: string, options: WrapOptions): T {
  const target = client as T & FetchCapable & { [WRAPPED]?: true };
  if (target[WRAPPED]) return client;
  if (typeof target.withOptions !== 'function') {
    if (!warnedUnwrappable) {
      warnedUnwrappable = true;
      console.warn(`iris: this ${provider} client has no withOptions(); it is returned unwrapped and its calls are not recorded`); // eslint-disable-line no-console
    }
    return client;
  }
  const inner = target.fetch ?? globalThis.fetch;
  const clone = target.withOptions({ fetch: recordingFetch(inner, options) }) as T;
  Object.defineProperty(clone, WRAPPED, { value: true });
  return clone;
}

/** Record every OpenAI call (`chat.completions`, `responses`) this client makes. Returns a new client of the same class. */
export function wrapOpenAI<T extends object>(client: T, options: WrapOptions = {}): T {
  return wrapClient(client, 'OpenAI', options);
}

/** Record every Anthropic call (`messages`) this client makes. Returns a new client of the same class. */
export function wrapAnthropic<T extends object>(client: T, options: WrapOptions = {}): T {
  return wrapClient(client, 'Anthropic', options);
}

/* ---------- the fetch ---------- */

interface Call {
  api: Api;
  request: Json;
  start: bigint;
  url: URL;
}

function urlOf(input: RequestInfo | URL): URL | undefined {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url);
  } catch {
    return undefined;
  }
  return undefined;
}

/** The fetch the wrapped client uses: the three model endpoints are watched, every other request passes straight through. */
export function recordingFetch(inner: typeof globalThis.fetch, options: WrapOptions): typeof globalThis.fetch {
  return async function irisFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
    const api = url ? apiOf(url.pathname, method) : undefined;
    if (!api || !url || typeof init?.body !== 'string') return inner(input, init);

    let request: Json;
    try {
      request = JSON.parse(init.body) as Json;
    } catch {
      return inner(input, init);
    }
    let sent = init;
    let swallowUsage = false;
    if (api === 'chat' && request.stream === true && request.stream_options === undefined && options.streamUsage !== false) {
      const asked = { ...request, stream_options: { include_usage: true } };
      sent = { ...init, body: JSON.stringify(asked) };
      swallowUsage = true;
    }

    const call: Call = { api, request, start: nowNanos(), url };
    let res: Response;
    try {
      res = await inner(input, sent);
    } catch (err) {
      safely(() => finish(call, options, undefined, { type: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) }));
      throw err;
    }

    const recorder = options.recorder ?? defaultRecorder();
    if (!res.ok) {
      const copy = res.clone();
      recorder.track(
        copy
          .text()
          .then((text) => finish(call, options, undefined, { type: String(res.status), message: providerMessage(text) ?? `HTTP ${res.status}` }))
          .catch(() => undefined),
      );
      return res;
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      return recordStream(res, call, options, swallowUsage);
    }
    const copy = res.clone();
    recorder.track(
      copy
        .json()
        .then((body: unknown) => finish(call, options, body as Json))
        .catch(() => undefined),
    );
    return res;
  };
}

function providerMessage(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as Json;
    const error = body.error;
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // not JSON
  }
  return text ? text.slice(0, 300) : undefined;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Recording never fails the call it records.
  }
}

/** One finished call → one span → one trace on the recorder. */
function finish(call: Call, options: WrapOptions, response?: Json, error?: { type: string; message: string }): void {
  safely(() => {
    const recorder = options.recorder ?? defaultRecorder();
    const extra: Attributes = options.sessionId ? { 'gen_ai.conversation.id': options.sessionId } : {};
    const port = call.url.port ? Number(call.url.port) : call.url.protocol === 'https:' ? 443 : 80;
    const span = genAiSpan({ api: call.api, request: call.request, response, error, serverAddress: call.url.hostname, serverPort: port }, extra);
    const record: SpanRecord = {
      traceId: newTraceId(),
      spanId: newSpanId(),
      name: span.name,
      kind: 3,
      startTimeUnixNano: call.start,
      endTimeUnixNano: nowNanos(),
      attributes: span.attributes,
      status: error ? { code: 'error', message: error.message } : { code: 'ok' },
    };
    recorder.record({ resource: resourceFor(recorder, options), spans: [record] });
  });
}

export function resourceFor(recorder: IrisRecorder, options: Pick<WrapOptions, 'agentName' | 'run' | 'evaluate' | 'evalType'>): Attributes {
  const evaluate = options.evaluate ?? recorder.evaluate;
  const evalType = options.evalType ?? recorder.evalType;
  const resource = recorder.resource(options.agentName ?? programName());
  delete resource['iris.evaluate'];
  delete resource['iris.eval_type'];
  if (evaluate) {
    resource['iris.evaluate'] = true;
    if (evalType) resource['iris.eval_type'] = evalType;
  }
  if (options.run) resource['iris.run'] = options.run;
  return resource;
}

/* ---------- streams ---------- */

/** The events after which a Responses or Messages stream has nothing more to say; Chat Completions ends with `[DONE]`. */
const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'message_stop']);

/** Split an SSE byte stream into events; `\n\n` or `\r\n\r\n` ends one. */
function eventEnd(buffer: string): { end: number; next: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { end: crlf, next: crlf + 4 };
  return { end: lf, next: lf + 2 };
}

function dataOf(event: string): string | undefined {
  const lines = event.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (lines.length === 0) return undefined;
  return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
}

/**
 * The response the SDK reads: the same bytes, in the same chunks, as they
 * arrive — read once, here, and parsed on the side into the assembler. When
 * the wrapper asked for usage the caller did not, the usage-only chunk is
 * cut out, so events are then passed on whole rather than as they arrive.
 */
function recordStream(res: Response, call: Call, options: WrapOptions, swallowUsage: boolean): Response {
  const assembler: StreamAssembler = assemblerFor(call.api);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let done = false;
  // The stream said it was finished. An SDK stops reading there and cancels
  // the body, and a cancel after the end is not a call cut short.
  let terminal = false;

  const feed = (event: string): boolean => {
    const data = dataOf(event);
    if (data === '[DONE]') terminal = true;
    if (data === undefined || data === '[DONE]') return true;
    try {
      const parsed = JSON.parse(data) as Json;
      if (TERMINAL_EVENTS.has(parsed.type)) terminal = true;
      assembler.add(parsed);
      // The chunk the wrapper asked for and the caller did not: usage, and no choices.
      if (swallowUsage && Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage) return false;
    } catch {
      // A line the parser does not know is passed on, not judged.
    }
    return true;
  };
  const end = (error?: { type: string; message: string }) => {
    if (done) return;
    done = true;
    finish(call, options, assembler.result(), error);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: finished } = await reader.read();
        if (finished) {
          const rest = buffer + decoder.decode();
          buffer = '';
          if (rest.trim().length > 0 && feed(rest) && swallowUsage) controller.enqueue(encoder.encode(rest));
          safely(() => end());
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        if (!swallowUsage) controller.enqueue(value);
        for (let cut = eventEnd(buffer); cut; cut = eventEnd(buffer)) {
          const event = buffer.slice(0, cut.next);
          buffer = buffer.slice(cut.next);
          const keep = feed(event.slice(0, cut.end));
          if (swallowUsage && keep) controller.enqueue(encoder.encode(event));
        }
      } catch (err) {
        safely(() => end({ type: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) }));
        controller.error(err);
      }
    },
    async cancel(reason) {
      safely(() => end(terminal ? undefined : { type: 'cancelled', message: 'the stream was cancelled before it finished' }));
      await reader.cancel(reason);
    },
  });
  const wrapped = new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  // The SDK reads the URL in its error messages; a constructed Response has none of its own.
  Object.defineProperty(wrapped, 'url', { value: res.url });
  return wrapped;
}
