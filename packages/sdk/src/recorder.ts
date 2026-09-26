/*
 * The recorder: spans in, OTLP/HTTP JSON out to Iris's `POST /v1/traces`.
 *
 * Every integration in this package (the provider wrappers, the AI SDK
 * middleware) and `@iris-eval/langchain` hands its spans to a recorder, and
 * the recorder is the only thing that talks to the network. It keeps three
 * promises:
 *
 *   1. It never breaks, slows or changes the application. `record()` is a
 *      synchronous push onto a bounded queue — no I/O, no serialization on
 *      the caller's path; the queue drops its oldest trace when full; every
 *      timer is unref'd; nothing it does can throw into the caller.
 *   2. It speaks plain OTLP. The body is an ExportTraceServiceRequest, the
 *      span attributes are the GenAI semantic conventions, and nothing about
 *      it is specific to Iris except the endpoint and three `iris.*`
 *      resource attributes that ask for a verdict.
 *   3. It returns what Iris said. Each answer names the Iris trace each OTLP
 *      trace became and, when evaluation was asked for, its verdict; those
 *      land in `results` and the `onResult` callback.
 *
 * No dependencies: the runtime's fetch, and the wire format by hand, as the
 * server's own exporter does.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { AttributeValue, Attributes } from './genai.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

/** The bundles Iris can run; `all` (the default) runs every one. */
export type EvalType = 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom' | 'all';

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTLP SpanKind: 1 internal, 3 client. */
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Attributes;
  status?: { code: 'ok' | 'error'; message?: string };
}

export interface TraceRecord {
  /** Resource attributes: `service.name` names the agent. */
  resource: Attributes;
  spans: SpanRecord[];
}

/** What Iris answered for one trace: the `iris-eval.stored[]` entry of its OTLP response. */
export interface StoredTrace {
  trace_id: string;
  otel_trace_id: string;
  agent_name: string;
  spans: number;
  steps: number;
  lacked: string[];
  /** The same object `evaluate_output` returns; null when there was nothing to score. Absent when evaluation was not asked for. */
  evaluation?: {
    id: string;
    eval_type: string;
    score: number;
    passed: boolean;
    verdict?: { state: 'pass' | 'fail' | 'unknown'; [key: string]: unknown };
    rule_results: Array<{ ruleName: string; passed: boolean; [key: string]: unknown }>;
    [key: string]: unknown;
  } | null;
  evaluation_error?: string;
}

export interface RecorderStats {
  /** Traces handed to `record`. */
  recorded: number;
  /** Traces Iris accepted. */
  sent: number;
  /** Traces lost to a full queue, an unreachable server or a refusal. */
  dropped: number;
}

export interface RecorderOptions {
  /** Iris's dashboard address, e.g. `http://127.0.0.1:6920`. Default: `IRIS_URL`, else the port a running server recorded in `runtime.json` under `IRIS_HOME` (or `~/.iris`). */
  url?: string;
  /** The server's API key, when it has one. Default: `IRIS_API_KEY`. */
  apiKey?: string;
  /** Ask Iris to score every trace this recorder sends (`iris.evaluate`). Default true. */
  evaluate?: boolean;
  /** The bundle to run when scoring. Default: every bundle. */
  evalType?: EvalType;
  /** Traces held while Iris is slow or away; the oldest goes first when full. Default 1000. */
  maxQueue?: number;
  /** How long a batch may wait before it is sent, in ms. Default 250. */
  flushIntervalMs?: number;
  /** Per-request timeout, in ms. Default 5000. */
  timeoutMs?: number;
  /** Called with each trace Iris stored, and its verdict when one was asked for. */
  onResult?: (result: StoredTrace) => void;
  /** Called on a delivery failure. Default: one console.warn per kind of failure, then quiet. */
  onError?: (error: Error) => void;
  /** The fetch to use; the runtime's global by default. */
  fetch?: typeof globalThis.fetch;
}

/** Bytes one request may carry: under the server's 1 MB body limit with room for the envelope. */
const MAX_BATCH_BYTES = 900_000;
const MAX_RESULTS = 1000;

export const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
export const newTraceId = (): string => hex(16);
export const newSpanId = (): string => hex(8);
/** Now, in nanoseconds since the epoch, with sub-millisecond precision from the monotonic clock. */
const origin = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
export const nowNanos = (): bigint => origin + process.hrtime.bigint();

/* ---------- OTLP JSON ---------- */

function anyValue(v: AttributeValue): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { arrayValue: { values: (v as Array<string | number>).map((x) => anyValue(x)) } };
}

const keyValues = (attrs: Attributes) => Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }));

function otlpSpan(s: SpanRecord): Record<string, unknown> {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: s.startTimeUnixNano.toString(),
    endTimeUnixNano: s.endTimeUnixNano.toString(),
    attributes: keyValues(s.attributes),
    ...(s.status ? { status: { code: s.status.code === 'ok' ? 1 : 2, ...(s.status.message ? { message: s.status.message } : {}) } } : {}),
  };
}

/** One ExportTraceServiceRequest for a batch: one ResourceSpans per distinct resource. */
export function exportRequest(traces: readonly TraceRecord[]): Record<string, unknown> {
  const byResource = new Map<string, { resource: Attributes; spans: SpanRecord[] }>();
  for (const t of traces) {
    const key = JSON.stringify(Object.entries(t.resource).sort(([a], [b]) => a.localeCompare(b)));
    const group = byResource.get(key) ?? { resource: t.resource, spans: [] };
    group.spans.push(...t.spans);
    byResource.set(key, group);
  }
  return {
    resourceSpans: [...byResource.values()].map((g) => ({
      resource: { attributes: keyValues(g.resource) },
      scopeSpans: [{ scope: { name: SDK_NAME, version: SDK_VERSION }, spans: g.spans.map(otlpSpan) }],
    })),
  };
}

/* ---------- where Iris is ---------- */

/** `IRIS_URL`, else the port a running server recorded in runtime.json — the rule the Python client applies. */
export function findServer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.IRIS_URL) return env.IRIS_URL.replace(/\/+$/, '');
  try {
    const home = env.IRIS_HOME ? env.IRIS_HOME : join(homedir(), '.iris');
    const runtime = JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')) as { dashboardPort?: unknown };
    const port = runtime.dashboardPort;
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  } catch {
    // No runtime.json: no running server recorded one.
  }
  return undefined;
}

/** The running program's name: the agent name when none is given. */
export function programName(): string {
  const script = process.argv[1];
  if (!script) return 'node';
  const name = basename(script, extname(script));
  return name === 'index' || name === 'main' ? basename(join(script, '..')) || name : name;
}

/* ---------- the recorder ---------- */

export class IrisRecorder {
  readonly stats: RecorderStats = { recorded: 0, sent: 0, dropped: 0 };
  /** The last thousand traces Iris stored, oldest first. */
  readonly results: StoredTrace[] = [];
  readonly evaluate: boolean;
  readonly evalType?: EvalType;

  private readonly options: RecorderOptions;
  /** Traces waiting to be sent; `bytes` is measured on the sending side, never on the caller's. */
  private readonly queue: Array<{ trace: TraceRecord; bytes?: number }> = [];
  private readonly maxQueue: number;
  private readonly interval: number;
  private readonly timeout: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly warned = new Set<string>();
  private exitHook: (() => void) | undefined;
  private closed = false;
  /** Calls whose response is still being read; flush waits for them, so a trace finished a moment ago is not left behind. */
  private readonly settling = new Set<Promise<unknown>>();

  constructor(options: RecorderOptions = {}) {
    this.options = options;
    this.evaluate = options.evaluate ?? true;
    this.evalType = options.evalType;
    this.maxQueue = Math.max(1, options.maxQueue ?? 1000);
    this.interval = Math.max(0, options.flushIntervalMs ?? 250);
    this.timeout = Math.max(1, options.timeoutMs ?? 5000);
  }

  /** The resource attributes every trace carries: the agent, this SDK, and the ask for a verdict. */
  resource(agentName: string, extra: Attributes = {}): Attributes {
    return {
      'service.name': agentName,
      'telemetry.sdk.name': SDK_NAME,
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.version': SDK_VERSION,
      ...(this.evaluate ? { 'iris.evaluate': true } : {}),
      ...(this.evaluate && this.evalType ? { 'iris.eval_type': this.evalType } : {}),
      ...extra,
    };
  }

  /** Queue one trace. Never throws, never waits. */
  record(trace: TraceRecord): void {
    try {
      if (this.closed) return;
      this.stats.recorded += 1;
      if (this.queue.length >= this.maxQueue) {
        this.queue.shift();
        this.stats.dropped += 1;
        this.fail('queue-full', new Error(`iris: the queue is full (${this.maxQueue} traces); the oldest was dropped`));
      }
      this.queue.push({ trace });
      this.installExitHook();
      this.schedule();
    } catch (err) {
      this.fail('internal', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** A call whose trace will be recorded when this settles: `flush` waits for it. */
  track(pending: Promise<unknown>): void {
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    this.settling.add(settled);
    void settled.then(() => this.settling.delete(settled));
  }

  /** Send everything queued; resolves when it is delivered or `timeoutMs` passes. Never rejects. */
  async flush(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const timeLeft = () => new Promise((r) => setTimeout(r, Math.max(1, deadline - Date.now())).unref?.());
    if (this.settling.size > 0) await Promise.race([Promise.all([...this.settling]), timeLeft()]);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while ((this.queue.length > 0 || this.inFlight) && Date.now() < deadline) {
      const step = this.inFlight ?? this.drain();
      await Promise.race([step, timeLeft()]);
    }
  }

  /** Flush, then stop taking traces. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    await this.flush(timeoutMs);
    this.closed = true;
    if (this.exitHook) process.removeListener('beforeExit', this.exitHook);
    this.exitHook = undefined;
  }

  private schedule(): void {
    if (this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.interval);
    this.timer.unref?.();
  }

  /** A process that is done with its own work sends what is queued before it exits. */
  private installExitHook(): void {
    if (this.exitHook) return;
    this.exitHook = () => {
      if (this.queue.length > 0 && !this.inFlight) void this.drain();
    };
    process.on('beforeExit', this.exitHook);
  }

  private drain(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return Promise.resolve();
    let size = 0;
    const batch: TraceRecord[] = [];
    while (this.queue.length > 0) {
      const next = this.queue[0];
      next.bytes ??= JSON.stringify(exportRequest([next.trace])).length;
      if (next.bytes > MAX_BATCH_BYTES) {
        this.queue.shift();
        this.stats.dropped += 1;
        this.fail('too-large', new Error(`iris: a trace of ${next.bytes} bytes is over the ${MAX_BATCH_BYTES}-byte request budget and was not sent`));
        continue;
      }
      if (size + next.bytes > MAX_BATCH_BYTES) break;
      this.queue.shift();
      size += next.bytes;
      batch.push(next.trace);
    }
    if (batch.length === 0) return Promise.resolve();
    this.inFlight = this.send(batch).finally(() => {
      this.inFlight = undefined;
      if (this.queue.length > 0) this.schedule();
    });
    return this.inFlight;
  }

  private async send(batch: TraceRecord[]): Promise<void> {
    const base = (this.options.url ?? findServer())?.replace(/\/+$/, '');
    if (!base) {
      this.stats.dropped += batch.length;
      this.fail('no-server', new Error('iris: no server to send to. Set IRIS_URL (for example http://127.0.0.1:6920), pass { url }, or start one with `npx -y @iris-eval/mcp-server --dashboard`.'));
      return;
    }
    const apiKey = this.options.apiKey ?? process.env.IRIS_API_KEY;
    const doFetch = this.options.fetch ?? globalThis.fetch;
    try {
      const res = await doFetch(`${base}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `${SDK_NAME}/${SDK_VERSION}`, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(exportRequest(batch)),
        signal: AbortSignal.timeout(this.timeout),
      });
      const text = await res.text();
      if (!res.ok) {
        this.stats.dropped += batch.length;
        let message = text.slice(0, 300);
        try {
          const body = JSON.parse(text) as { error?: unknown };
          if (typeof body.error === 'string') message = body.error;
        } catch {
          // not JSON: the text as it came
        }
        this.fail(`http-${res.status}`, new Error(`iris: ${base}/v1/traces answered ${res.status}: ${message}`));
        return;
      }
      const body = JSON.parse(text) as { 'iris-eval'?: { stored?: StoredTrace[] } };
      const stored = body['iris-eval']?.stored ?? [];
      this.stats.sent += stored.length;
      for (const entry of stored) {
        this.results.push(entry);
        if (this.results.length > MAX_RESULTS) this.results.shift();
        try {
          this.options.onResult?.(entry);
        } catch (err) {
          this.fail('on-result', err instanceof Error ? err : new Error(String(err)));
        }
      }
    } catch (err) {
      this.stats.dropped += batch.length;
      const cause = err instanceof Error ? err.message : String(err);
      this.fail('unreachable', new Error(`iris: could not reach ${base}/v1/traces: ${cause}`));
    }
  }

  private fail(kind: string, error: Error): void {
    try {
      if (this.options.onError) {
        this.options.onError(error);
        return;
      }
    } catch {
      // A throwing onError is the caller's; it never reaches their model call.
    }
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    console.warn(error.message); // eslint-disable-line no-console
  }
}

let shared: IrisRecorder | undefined;

/** The process-wide recorder the wrappers use when none is passed. */
export function defaultRecorder(): IrisRecorder {
  shared ??= new IrisRecorder();
  return shared;
}
