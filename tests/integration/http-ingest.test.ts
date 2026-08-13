/*
 * POST /api/v1/traces — deterministic capture over HTTP.
 *
 * Every test here drives the REAL dashboard server (createDashboardServer
 * + start()) over a REAL socket, so the request passes through the same
 * middleware stack production traffic does: DNS-rebinding guard, CORS,
 * auth, tenant resolution, rate limiter. Asserting against the route in
 * isolation would leave the guard wiring untested — and a guard that is
 * mounted but bypassed in tests is exactly the inert-guard failure the
 * rebinding middleware documents.
 *
 * node:http (not fetch) for anything header-sensitive: `Host` is a
 * forbidden header name in fetch and gets dropped SILENTLY, so a
 * fetch-based test of the Host branch passes while asserting nothing.
 * See tests/unit/middleware/rebinding-guard.test.ts for the history.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { EvalRuleResult } from '../../src/types/eval.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface BootedServer {
  storage: SqliteAdapter;
  server: Server;
  port: number;
  base: string;
}

const booted: BootedServer[] = [];

afterEach(async () => {
  for (const b of booted.splice(0)) {
    b.server.closeAllConnections?.();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
    await b.storage.close();
  }
});

async function bootServer(opts?: { withEvalEngine?: boolean; apiKey?: string }): Promise<BootedServer> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = {
    ...defaultConfig,
    dashboard: { ...defaultConfig.dashboard, port: 0 },
    security: { ...defaultConfig.security, apiKey: opts?.apiKey },
  };
  const evalEngine =
    opts?.withEvalEngine === false
      ? undefined
      : new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);
  const dashboard = createDashboardServer(storage, config, mockLogger, { evalEngine });
  const server = dashboard.start();
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const entry = { storage, server, port, base: `http://127.0.0.1:${port}` };
  booted.push(entry);
  return entry;
}

async function postTrace(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Raw node:http POST — the only way to actually send a chosen Host header. */
function rawPost(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/traces',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        responded = true;
        res.resume();
        res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    // A 413 can arrive while the request body is still being written; the
    // server then drops the socket and the client emits EPIPE/ECONNRESET
    // AFTER the response. Only a pre-response error is a test failure.
    req.on('error', (err) => {
      if (!responded) reject(err);
    });
    req.end(body);
  });
}

describe('POST /api/v1/traces — store', () => {
  it('stores a valid payload and returns 201 with a queryable server-minted trace_id', async () => {
    const { base } = await bootServer();
    const timestamp = '2026-08-11T12:00:00.000Z';

    const { status, json } = await postTrace(base, {
      agent_name: 'ingest-test-agent',
      framework: 'openai',
      input: 'What is the refund policy?',
      output: 'Refunds are available within 30 days of purchase.',
      latency_ms: 812,
      token_usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      cost_usd: 0.0021,
      metadata: { requestId: 'req-1', env: 'test' },
      tool_calls: [{ tool_name: 'lookup_policy', input: { topic: 'refunds' } }],
      spans: [{ name: 'openai.chat.completions.create', kind: 'LLM', status_code: 'OK', start_time: timestamp }],
      timestamp,
    });

    expect(status).toBe(201);
    expect(json.status).toBe('stored');
    expect(json.trace_id).toMatch(/^[0-9a-f]{32}$/);
    // Store-only request carries no evaluation block.
    expect(json.evaluation).toBeUndefined();

    // The row is queryable through the same API a dashboard user hits.
    const res = await fetch(`${base}/api/v1/traces/${json.trace_id as string}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      trace: Record<string, unknown>;
      spans: Array<Record<string, unknown>>;
      evals: unknown[];
    };
    expect(detail.trace.agent_name).toBe('ingest-test-agent');
    expect(detail.trace.framework).toBe('openai');
    expect(detail.trace.output).toBe('Refunds are available within 30 days of purchase.');
    expect(detail.trace.timestamp).toBe(timestamp);
    expect(detail.trace.cost_usd).toBeCloseTo(0.0021);
    expect((detail.trace.token_usage as { total_tokens: number }).total_tokens).toBe(160);
    expect((detail.trace.tool_calls as Array<{ tool_name: string }>)[0].tool_name).toBe('lookup_policy');
    expect(detail.spans).toHaveLength(1);
    expect(detail.spans[0].name).toBe('openai.chat.completions.create');
    expect(detail.spans[0].trace_id).toBe(json.trace_id);
    expect(detail.spans[0].span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(detail.evals).toHaveLength(0);
  });

  it('ignores a client-supplied trace_id — the server mints its own', async () => {
    const { base } = await bootServer();
    const { status, json } = await postTrace(base, {
      agent_name: 'minting-test',
      trace_id: 'attacker-chosen-id',
    });
    expect(status).toBe(201);
    expect(json.trace_id).not.toBe('attacker-chosen-id');

    const res = await fetch(`${base}/api/v1/traces/attacker-chosen-id`);
    expect(res.status).toBe(404);
  });

  it('rejects a payload without agent_name with 400 and a pointed zod issue', async () => {
    const { base, storage } = await bootServer();
    const { status, json } = await postTrace(base, { output: 'orphan output' });
    expect(status).toBe(400);
    expect(json.error).toBe('Invalid trace payload');
    const issues = json.details as Array<{ path: unknown[] }>;
    expect(issues.some((i) => i.path.includes('agent_name'))).toBe(true);

    // Nothing was stored.
    const { total } = await storage.queryTraces(LOCAL_TENANT, {});
    expect(total).toBe(0);
  });

  it('rejects a malformed span with 400 (zod, not a 500 from storage)', async () => {
    const { base } = await bootServer();
    const { status, json } = await postTrace(base, {
      agent_name: 'bad-span',
      spans: [{ kind: 'LLM' }], // missing required name + start_time
    });
    expect(status).toBe(400);
    expect(json.error).toBe('Invalid trace payload');
  });

  it('refuses a body over the configured 1mb limit with 413', async () => {
    const { port } = await bootServer();
    const body = JSON.stringify({ agent_name: 'oversized', output: 'a'.repeat(1_200_000) });
    const { status } = await rawPost(port, body, {});
    expect(status).toBe(413);
  });
});

describe('POST /api/v1/traces — evaluate: true', () => {
  it('runs the deterministic engine and stores a linked eval_results row', async () => {
    const { base } = await bootServer();
    const { status, json } = await postTrace(base, {
      agent_name: 'safety-check',
      input: 'Summarize the customer record',
      output: 'Customer SSN is 536-22-8145, contact at dana.whitfield@harborline.io.',
      evaluate: true,
      eval_type: 'safety',
    });

    expect(status).toBe(201);
    expect(json.status).toBe('stored');
    const evaluation = json.evaluation as {
      id: string;
      eval_type: string;
      score: number;
      passed: boolean;
      rule_results: EvalRuleResult[];
      rules_evaluated: number;
      insufficient_data: boolean;
      critical_failures?: string[];
    };
    expect(evaluation.eval_type).toBe('safety');
    expect(evaluation.insufficient_data).toBe(false);
    expect(evaluation.rules_evaluated).toBeGreaterThan(0);
    // The SSN + email above genuinely trip the production PII rule —
    // deterministic, so asserted exactly.
    const pii = evaluation.rule_results.find((r) => r.ruleName === 'no_pii');
    expect(pii).toBeDefined();
    expect(pii!.passed).toBe(false);

    /*
     * The critical-rule veto, asserted on the HTTP capture path — not just
     * the per-rule verdict.
     *
     * This test used to stop at `pii.passed === false`, which is the one
     * assertion that cannot catch the bug the veto exists to fix. The whole
     * point of the feature is that no_pii failing while the other safety
     * rules pass leaves the WEIGHTED score above the 0.7 threshold — so
     * before the veto this exact payload returned `passed: true` with a
     * failing no_pii buried in rule_results, and every automated gate keys
     * on `passed`. Asserting the score clears the threshold FIRST is what
     * makes the `passed:false` assertion meaningful: it proves the verdict
     * came from the veto rather than from a low average.
     */
    expect(evaluation.score).toBeGreaterThanOrEqual(0.7);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.critical_failures).toContain('no_pii');

    // The eval row landed in storage, linked to the trace — and the veto
    // reason SURVIVED the round trip (it used to be response-only, so a
    // stored vetoed eval was indistinguishable from a low-scoring one).
    const res = await fetch(`${base}/api/v1/traces/${json.trace_id as string}`);
    const detail = (await res.json()) as {
      evals: Array<{
        id: string;
        trace_id: string;
        eval_type: string;
        passed: boolean;
        critical_failures?: string[];
      }>;
    };
    expect(detail.evals).toHaveLength(1);
    expect(detail.evals[0].id).toBe(evaluation.id);
    expect(detail.evals[0].trace_id).toBe(json.trace_id);
    expect(detail.evals[0].eval_type).toBe('safety');
    expect(detail.evals[0].passed).toBe(false);
    expect(detail.evals[0].critical_failures).toContain('no_pii');
  });

  it('rejects evaluate:true without output — nothing to score', async () => {
    const { base } = await bootServer();
    const { status, json } = await postTrace(base, {
      agent_name: 'no-output',
      evaluate: true,
    });
    expect(status).toBe(400);
    const issues = json.details as Array<{ path: unknown[] }>;
    expect(issues.some((i) => i.path.includes('output'))).toBe(true);
  });

  it('refuses with 501 and stores NOTHING when no eval engine is wired', async () => {
    const { base } = await bootServer({ withEvalEngine: false });
    const { status } = await postTrace(base, {
      agent_name: 'engine-less',
      output: 'some output',
      evaluate: true,
    });
    expect(status).toBe(501);

    // Refused BEFORE the insert — storing without the requested eval
    // would be a silently skipped gate.
    const res = await fetch(`${base}/api/v1/traces`);
    const { total } = (await res.json()) as { total: number };
    expect(total).toBe(0);
  });
});

describe('POST /api/v1/traces — guards', () => {
  it('REJECTS a hostile Origin with 403 before any write happens', async () => {
    const { port, storage } = await bootServer();
    const body = JSON.stringify({ agent_name: 'rebind-attempt' });
    const { status } = await rawPost(port, body, { Origin: 'http://evil.attacker.com' });
    expect(status).toBe(403);

    const { total } = await storage.queryTraces(LOCAL_TENANT, {});
    expect(total).toBe(0);
  });

  it('REJECTS a foreign Host header with 403 (DNS rebinding, loopback bind)', async () => {
    const { port, storage } = await bootServer();
    const body = JSON.stringify({ agent_name: 'rebind-attempt' });
    const { status } = await rawPost(port, body, { Host: 'attacker-controlled.example.com' });
    expect(status).toBe(403);

    const { total } = await storage.queryTraces(LOCAL_TENANT, {});
    expect(total).toBe(0);
  });

  it("allows the server's own loopback origin", async () => {
    const { base, port } = await bootServer();
    const { status } = await postTrace(
      base,
      { agent_name: 'same-origin' },
      { Origin: `http://localhost:${port}` },
    );
    expect(status).toBe(201);
  });

  it('requires a Bearer token when the server has an api key', async () => {
    const { base } = await bootServer({ apiKey: 'test-ingest-key' });

    const unauthenticated = await postTrace(base, { agent_name: 'auth-test' });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await postTrace(
      base,
      { agent_name: 'auth-test' },
      { authorization: 'Bearer test-ingest-key' },
    );
    expect(authenticated.status).toBe(201);
  });
});

describe('runtime.json discovery handshake', () => {
  it('writes the bound port to ${IRIS_HOME}/runtime.json on start', async () => {
    const { port } = await bootServer();
    // IRIS_HOME points at the vitest scratch home (tests/setup/iris-home.ts),
    // never the developer's real ~/.iris.
    const raw = readFileSync(join(process.env.IRIS_HOME as string, 'runtime.json'), 'utf8');
    const runtime = JSON.parse(raw) as { dashboardPort: number; pid: number; startedAt: string };
    expect(runtime.dashboardPort).toBe(port);
    expect(runtime.pid).toBe(process.pid);
    expect(new Date(runtime.startedAt).getTime()).not.toBeNaN();
  });
});
