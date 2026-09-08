/*
 * The typed error model (arc 7, D-1).
 *
 * Every API failure used to surface as `new Error('API error: 503 Service
 * Unavailable')` — one string for a stopped server, a missing row, a wrong
 * key and a bug on the server — and the page rendered whatever string it
 * got. A reader cannot act on "API error"; they can act on "Iris did not
 * answer" or "this server needs an API key". The kind is the contract:
 * the sentence, the retry policy and the widget's rendering all key on it.
 */

export type ApiErrorKind =
  /** No response at all: the server is stopped, unreachable, or this page is on the wrong port. */
  | 'unreachable'
  /** 401 or 403: the server has a key and this browser has no session for it. */
  | 'unauthorized'
  /** 404: nothing by that id — deleted, or swept by retention. */
  | 'not-found'
  /** 429: the per-address limiter; carries when to retry. */
  | 'rate-limited'
  /** 5xx: the request reached the server and failed there. */
  | 'server-error'
  /** 400 / 422: the server refused the request's shape, with its reason when it gave one. */
  | 'bad-request';

export interface ApiErrorInit {
  status?: number;
  retryAfterMs?: number;
  /** The server's own words, when its body carried an `error` or plain text. */
  detail?: string;
}

/** One sentence per kind, written for the person reading the widget, not for a log. */
export function sentenceFor(kind: ApiErrorKind, path: string, init: ApiErrorInit = {}): string {
  switch (kind) {
    case 'unreachable':
      return 'Iris did not answer. The server may be stopped, or this page is open on a different port than the one it serves on.';
    case 'unauthorized':
      return 'This server needs an API key. Sign in with ?key=<api key> on any dashboard page, or send Authorization: Bearer <api key>.';
    case 'not-found':
      return 'Nothing here by that id. It may have been deleted, or swept by retention.';
    case 'rate-limited':
      return `Rate limited — retry in ${Math.round((init.retryAfterMs ?? 0) / 1000)}s`;
    case 'server-error':
      return `Iris answered ${init.status ?? 'an error'} on ${path || 'this request'}: the request reached the server and failed there.${init.detail ? ` ${init.detail}` : ''}`;
    case 'bad-request':
      return `The request was refused${init.status ? ` (${init.status})` : ''}${init.detail ? `: ${init.detail}` : '.'}`;
  }
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly path: string;
  readonly detail?: string;

  constructor(kind: ApiErrorKind, path: string, init: ApiErrorInit = {}) {
    super(sentenceFor(kind, path, init));
    this.name = 'ApiError';
    this.kind = kind;
    this.path = path;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.detail = init.detail;
  }
}

/**
 * 429 with its schedule. A subclass so the code that has keyed on
 * `instanceof RateLimitError` since 0.5 keeps working; its kind is the
 * model's `rate-limited`.
 */
export class RateLimitError extends ApiError {
  declare readonly kind: 'rate-limited';
  readonly policy?: string;

  constructor(retryAfterMs: number, policy?: string, path = '') {
    super('rate-limited', path, { status: 429, retryAfterMs: Math.max(retryAfterMs, 1000) });
    this.name = 'RateLimitError';
    this.policy = policy;
  }
}

export function parseRetryAfter(res: Response): number {
  const reset = res.headers.get('ratelimit-reset');
  if (reset) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const n = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(date - Date.now(), 0);
  }
  return 30_000; // conservative 30s fallback
}

/** The server's own words from a failed response: an `error` field when the body is JSON, else its text, else nothing. */
async function detailOf(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      const json = JSON.parse(text) as { error?: unknown; message?: unknown };
      const said = typeof json.error === 'string' ? json.error : typeof json.message === 'string' ? json.message : undefined;
      return said ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return undefined;
  }
}

/** A failed HTTP response, classified. Reads the body once for the server's reason. */
export async function toApiError(res: Response, path: string): Promise<ApiError> {
  if (res.status === 429) return new RateLimitError(parseRetryAfter(res), res.headers.get('ratelimit-policy') ?? undefined, path);
  if (res.status === 401 || res.status === 403) return new ApiError('unauthorized', path, { status: res.status });
  if (res.status === 404) return new ApiError('not-found', path, { status: 404, detail: await detailOf(res) });
  if (res.status >= 500) return new ApiError('server-error', path, { status: res.status, detail: await detailOf(res) });
  return new ApiError('bad-request', path, { status: res.status, detail: await detailOf(res) });
}

/** `fetch` itself threw: nothing answered. */
export function networkError(path: string, cause: unknown): ApiError {
  return new ApiError('unreachable', path, { detail: cause instanceof Error ? cause.message : undefined });
}

/** Anything a fetcher threw, as an ApiError — a non-HTTP throw is "unreachable" with its message as the detail. */
export function asApiError(err: unknown, path = ''): ApiError {
  if (err instanceof ApiError) return err;
  return networkError(path, err);
}
