/*
 * `@iris-eval/mcp-server/client` — a typed client for the HTTP route (arc 8, R-1).
 *
 * The twenty lines every pipeline that talks to a running Iris rewrites:
 * `POST /api/v1/traces` with `evaluate: true`, the Bearer header, and the
 * server's own error sentence when it refuses. No new package, no
 * dependency: it uses the runtime's `fetch`.
 *
 *   import { createClient } from '@iris-eval/mcp-server/client';
 *   const iris = createClient({ baseUrl: 'http://127.0.0.1:6920', apiKey: process.env.IRIS_API_KEY });
 *   const { trace_id, evaluation } = await iris.logTrace({ agent_name: 'bot', input, output, evaluate: true });
 *   evaluation?.verdict?.state; // 'pass' | 'fail' | 'unknown'
 *
 * The body is the same object the `log_trace` tool and `iris-eval ingest`
 * accept (one schema on every door since 0.13.0); the server mints the
 * trace id. The `evaluation` is the same object `evaluate_output` returns.
 */
import type { EvalResultType, Verdict, Coverage, Interpretation, Provenance, EvalRuleResult } from './types/eval.js';
import type { Span, TokenUsage, ToolCallRecord, ToolDescriptor } from './types/trace.js';

export interface IrisClientOptions {
  /** Where the dashboard listens, e.g. `http://127.0.0.1:6920`. A trailing slash is fine. */
  baseUrl: string;
  /** The server's API key, when it was started with one (`--api-key` or `IRIS_API_KEY`). Sent as `Authorization: Bearer`. */
  apiKey?: string;
  /** The fetch to use; the runtime's global by default. */
  fetch?: typeof globalThis.fetch;
}

/** The body `POST /api/v1/traces` accepts — the `log_trace` tool's input. The server mints `trace_id`. */
export interface IngestTrace {
  agent_name: string;
  framework?: string;
  input?: string;
  output?: string;
  tool_calls?: ToolCallRecord[];
  latency_ms?: number;
  token_usage?: TokenUsage;
  cost_usd?: number;
  metadata?: Record<string, unknown>;
  timestamp?: string;
  tools?: ToolDescriptor[];
  spans?: Array<Omit<Span, 'trace_id' | 'span_id'> & { span_id?: string }>;
  /** The run this execution belongs to; pairs traces across runs by `case_key`. */
  run?: string;
  case_key?: string;
  /** Score the output in the same call; `output` is then required. */
  evaluate?: boolean;
  /** The bundle to run when `evaluate` is true; omitted means every bundle. */
  eval_type?: EvalResultType;
}

/** The evaluation `evaluate: true` returns inline — the same object `evaluate_output` returns. */
export interface EvaluationResponse {
  id: string;
  trace_id?: string;
  eval_type: string;
  score: number;
  passed: boolean;
  verdict?: Verdict;
  rule_results: EvalRuleResult[];
  coverage?: Coverage;
  interpretations?: Interpretation[];
  provenance?: Provenance;
  critical_failures?: string[];
  critical_skipped?: string[];
  suggestions?: string[];
  [key: string]: unknown;
}

export interface IngestResponse {
  trace_id: string;
  status: 'stored';
  evaluation?: EvaluationResponse;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptime_seconds?: number;
  [key: string]: unknown;
}

/** What the server said when it refused: the status and its own `error` sentence, with the body it sent. */
export class IrisClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'IrisClientError';
    this.status = status;
    this.body = body;
  }
}

export interface IrisClient {
  /** Store a trace, and score it in the same call when `evaluate` is true. */
  logTrace(trace: IngestTrace): Promise<IngestResponse>;
  /** The server's health: status, version, uptime — unauthenticated by design. */
  health(): Promise<HealthResponse>;
  /** What this server can judge: the same object `iris://capabilities` serves. */
  capabilities(): Promise<Record<string, unknown>>;
}

export function createClient(options: IrisClientOptions): IrisClient {
  // Trailing slashes off, by a loop rather than a `/\/+$/` — the regex is
  // quadratic on a string of many slashes (CodeQL js/polynomial-redos), and
  // the base URL is caller input.
  let base = options.baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('createClient needs a fetch: pass one in options.fetch, or run on Node 18 or newer.');
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    accept: 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
  });
  const read = async <T>(res: Response): Promise<T> => {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON: keep the text
    }
    if (!res.ok) {
      const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `${res.status} ${res.statusText}`;
      throw new IrisClientError(res.status, message, body);
    }
    return body as T;
  };
  return {
    async logTrace(trace) {
      const res = await fetchImpl(`${base}/api/v1/traces`, { method: 'POST', headers: headers(true), body: JSON.stringify(trace) });
      return read<IngestResponse>(res);
    },
    async health() {
      const res = await fetchImpl(`${base}/api/v1/health`, { headers: headers(false) });
      // 503 carries the same shape with status 'degraded'; read it rather than throw.
      if (res.status === 503) return (await res.json()) as HealthResponse;
      return read<HealthResponse>(res);
    },
    async capabilities() {
      const res = await fetchImpl(`${base}/api/v1/capabilities`, { headers: headers(false) });
      return read<Record<string, unknown>>(res);
    },
  };
}
