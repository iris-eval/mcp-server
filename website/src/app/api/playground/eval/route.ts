/*
 * /api/playground/eval — server-side eval execution for the live
 * playground (B5).
 *
 * Why server-side: runs the regex-based rules in Node.js so we can:
 *   - Bound CPU/time per request
 *   - Rate-limit by IP via existing Upstash KV infrastructure
 *   - Avoid shipping the full rule library to every page load
 *
 * Future v0.4.1 extensions:
 *   - Sandboxed worker thread for user-supplied custom rules (eval-safe
 *     Zod schema execution); for v0.4 we only run the vendored library
 *   - Telemetry: anonymized "playground used" event for product metrics
 *
 * Rate limit: 30 requests / minute / IP. Hashed with RATE_LIMIT_SALT
 * (the same env var the waitlist route requires) so the IP itself is
 * never persisted to KV.
 */
import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { evaluateOutput, type EvalCategory } from '../../../../lib/eval/rules';

const ALLOWED_ORIGINS = [
  'https://iris-eval.com',
  'https://www.iris-eval.com',
];
if (process.env.VERCEL_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:8890', 'http://localhost:3000');
}

// 30 evals / minute / IP. Generous enough for legit exploration; tight
// enough to make scripted abuse uneconomical.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SEC = 60;
const MAX_OUTPUT_BYTES = 50_000; // ~12.5k tokens worth of text — generous demo cap
const MAX_INPUT_BYTES = 20_000;
const MAX_EXPECTED_BYTES = 10_000;

function getCorsOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  return origin && ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
  };
}

function hashIP(ip: string): string {
  const salt = process.env.RATE_LIMIT_SALT;
  if (!salt) throw new Error('RATE_LIMIT_SALT env var required for /api/playground/eval');
  return createHash('sha256').update(ip + salt).digest('hex').slice(0, 16);
}

const VALID_CATEGORIES: ReadonlyArray<EvalCategory | 'all'> = [
  'safety',
  'relevance',
  'completeness',
  'cost',
  'all',
];

interface PlaygroundEvalRequest {
  output?: unknown;
  input?: unknown;
  expected?: unknown;
  category?: unknown;
  costUsd?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
}

function validate(body: PlaygroundEvalRequest): { ok: true; data: ValidatedRequest } | { ok: false; error: string } {
  if (typeof body.output !== 'string' || body.output.length === 0) {
    return { ok: false, error: 'output must be a non-empty string' };
  }
  if (Buffer.byteLength(body.output, 'utf8') > MAX_OUTPUT_BYTES) {
    return { ok: false, error: `output exceeds ${MAX_OUTPUT_BYTES} bytes` };
  }
  if (body.input !== undefined && body.input !== null && body.input !== '') {
    if (typeof body.input !== 'string') return { ok: false, error: 'input must be a string' };
    if (Buffer.byteLength(body.input, 'utf8') > MAX_INPUT_BYTES) {
      return { ok: false, error: `input exceeds ${MAX_INPUT_BYTES} bytes` };
    }
  }
  if (body.expected !== undefined && body.expected !== null && body.expected !== '') {
    if (typeof body.expected !== 'string') return { ok: false, error: 'expected must be a string' };
    if (Buffer.byteLength(body.expected, 'utf8') > MAX_EXPECTED_BYTES) {
      return { ok: false, error: `expected exceeds ${MAX_EXPECTED_BYTES} bytes` };
    }
  }
  const category = (body.category ?? 'all') as string;
  if (!VALID_CATEGORIES.includes(category as EvalCategory | 'all')) {
    return { ok: false, error: `category must be one of ${VALID_CATEGORIES.join(' | ')}` };
  }
  if (body.costUsd !== undefined && body.costUsd !== null && body.costUsd !== '') {
    if (typeof body.costUsd !== 'number' || !Number.isFinite(body.costUsd) || body.costUsd < 0) {
      return { ok: false, error: 'costUsd must be a non-negative number' };
    }
  }
  if (body.promptTokens !== undefined && body.promptTokens !== null && body.promptTokens !== '') {
    if (typeof body.promptTokens !== 'number' || !Number.isInteger(body.promptTokens) || body.promptTokens < 0) {
      return { ok: false, error: 'promptTokens must be a non-negative integer' };
    }
  }
  if (body.completionTokens !== undefined && body.completionTokens !== null && body.completionTokens !== '') {
    if (typeof body.completionTokens !== 'number' || !Number.isInteger(body.completionTokens) || body.completionTokens < 0) {
      return { ok: false, error: 'completionTokens must be a non-negative integer' };
    }
  }
  return {
    ok: true,
    data: {
      output: body.output,
      input: typeof body.input === 'string' && body.input.length > 0 ? body.input : undefined,
      expected: typeof body.expected === 'string' && body.expected.length > 0 ? body.expected : undefined,
      category: category as EvalCategory | 'all',
      costUsd: typeof body.costUsd === 'number' ? body.costUsd : undefined,
      promptTokens: typeof body.promptTokens === 'number' ? body.promptTokens : undefined,
      completionTokens: typeof body.completionTokens === 'number' ? body.completionTokens : undefined,
    },
  };
}

interface ValidatedRequest {
  output: string;
  input?: string;
  expected?: string;
  category: EvalCategory | 'all';
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export async function OPTIONS(request: Request) {
  const origin = getCorsOrigin(request);
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: Request) {
  const origin = getCorsOrigin(request);
  const headers = corsHeaders(origin);

  if (!origin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
  }

  // Rate limit only when KV is configured. In dev without KV the route
  // still works (no rate limit) so local exploration isn't blocked.
  let redis: Redis | null = null;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN && process.env.RATE_LIMIT_SALT) {
    redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }

  let body: PlaygroundEvalRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }

  const validation = validate(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers });
  }
  const data = validation.data;

  let ipHash: string | null = null;
  if (redis) {
    try {
      const clientIP =
        (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
        request.headers.get('x-real-ip') ||
        'unknown';
      ipHash = hashIP(clientIP);
      const rateLimitKey = `playground:eval:rl:${ipHash}`;
      const currentCount = await redis.get<number>(rateLimitKey);
      if (currentCount && currentCount >= RATE_LIMIT_MAX) {
        // Anonymized rate-limit log (ip hash, never the raw IP). Surfaces
        // sustained abuse patterns in Vercel logs without exfiltrating PII.
        console.warn(
          `[playground] rate-limit hit ip_hash=${ipHash} count=${currentCount}`,
        );
        return NextResponse.json(
          { error: 'Too many requests. Try again in a minute.' },
          { status: 429, headers },
        );
      }
      const pipeline = redis.pipeline();
      pipeline.incr(rateLimitKey);
      pipeline.expire(rateLimitKey, RATE_LIMIT_WINDOW_SEC);
      await pipeline.exec();
    } catch (err) {
      // Rate limit failure is logged but does not block — defense-in-depth
      // says we'd rather serve a degraded experience than 500-out the demo.
      console.warn('[playground] rate limit error:', (err as Error).message);
    }
  }

  const startMs = Date.now();
  let summary: ReturnType<typeof evaluateOutput>;
  try {
    summary = evaluateOutput(
      {
        output: data.output,
        input: data.input,
        expected: data.expected,
        costUsd: data.costUsd,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
      },
      data.category,
    );
  } catch (err) {
    // Engine errors should not crash the route. Surface as 500 with a
    // safe message + log the full error for debugging.
    console.error('[playground] eval engine error:', (err as Error).message, (err as Error).stack);
    return NextResponse.json(
      { error: 'Eval engine failed unexpectedly' },
      { status: 500, headers },
    );
  }

  // Anonymized success telemetry: anonymous ip hash, category, output
  // length bucket, pass/fail, eval duration. No content captured.
  const durationMs = Date.now() - startMs;
  const lengthBucket =
    data.output.length < 200
      ? 'sm'
      : data.output.length < 2000
        ? 'md'
        : data.output.length < 10_000
          ? 'lg'
          : 'xl';
  console.log(
    `[playground] eval ip_hash=${ipHash ?? 'unrl'} category=${data.category} len=${lengthBucket} passed=${summary.passed} duration_ms=${durationMs}`,
  );

  return NextResponse.json(
    {
      ...summary,
      vendoredFromVersion: 'v0.3.1',
    },
    { status: 200, headers },
  );
}
