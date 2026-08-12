/*
 * --self-test — the cold install diagnostic.
 *
 * A new user's first question is "does this install actually work?", and
 * before this flag the only way to answer it was to wire Iris into an MCP
 * client and hope traces appear. The self-test proves the whole local loop
 * without an agent, an API key, or a network: storage round-trip, the REAL
 * eval engine on deterministic fixtures (a planted SSN, a planted injection
 * string, a clean output), the dashboard HTTP surface, and the
 * DNS-rebinding guard actively rejecting a hostile Origin.
 *
 * Isolation is the load-bearing property. The diagnostic creates its own
 * scratch IRIS_HOME and scrubs every IRIS_* env var that feeds
 * loadConfig(), so it NEVER opens (or migrates!) the user's real iris.db,
 * never reads their config.json, and never honours an IRIS_API_KEY that
 * would 401 its own probes. The scratch home is removed and the env
 * restored before returning — pass or fail.
 *
 * Budget: everything is in-process or loopback. No LLM calls, no network
 * beyond 127.0.0.1, and the whole sequence completes in well under the
 * 10-second target (the heavy cost is process start-up, not the checks).
 *
 * Exit contract: 0 = every check passed, 1 = any check failed. index.ts
 * runs this BEFORE loadConfig() so the normal boot path never executes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { loadConfig } from './config/index.js';
import { PKG_VERSION } from './config/defaults.js';
import { createStorage } from './storage/index.js';
import { createDashboardServer } from './dashboard/server.js';
import { createLogger } from './utils/logger.js';
import { irisHome } from './utils/iris-home.js';
import { EvalEngine } from './eval/engine.js';
import { generateTraceId } from './utils/ids.js';
import { LOCAL_TENANT } from './types/tenant.js';
import type { IrisConfig, Trace } from './types/index.js';
import type { IStorageAdapter } from './types/query.js';
import type { EvalResult } from './types/eval.js';

const CHECK = '✓';
const CROSS = '✗';

/*
 * Step labels are shared with the tests (which assert each one appears in
 * the report) — a single constant instead of strings restated in three
 * files, per the usual drift rule.
 */
export const SELF_TEST_STEPS = {
  tempHome: 'create isolated temp home',
  storage: 'initialize storage',
  trace: 'log a trace',
  piiEval: 'eval: PII positive (planted SSN)',
  injectionEval: 'eval: injection positive (planted override text)',
  cleanEval: 'eval: clean output passes',
  readBack: 'read back persisted results',
  dashboard: 'start dashboard on ephemeral loopback port',
  health: 'health endpoint answers',
  stats: 'stats endpoint answers',
  rebindingGuard: 'rebinding guard rejects hostile Origin',
  cleanup: 'clean up temp home',
} as const;

export const SELF_TEST_PASS_VERDICT = `${CHECK} PASS — this install works`;
export const SELF_TEST_FAIL_VERDICT = `${CROSS} FAIL`;

/*
 * Every env var loadConfig()'s env layer reads, plus IRIS_HOME itself.
 * Scrubbed for the duration of the run so the diagnostic is hermetic:
 * IRIS_DB_PATH would point storage at the user's REAL database (the
 * exact bug class tests/setup/iris-home.ts exists to contain), and
 * IRIS_API_KEY would make the dashboard reject the self-test's own
 * unauthenticated probes.
 */
const SCRUBBED_ENV_VARS = [
  'IRIS_HOME',
  'IRIS_DB_PATH',
  'IRIS_TRANSPORT',
  'IRIS_PORT',
  'IRIS_HOST',
  'IRIS_DASHBOARD',
  'IRIS_DASHBOARD_PORT',
  'IRIS_DASHBOARD_HOST',
  'IRIS_API_KEY',
  'IRIS_ALLOWED_ORIGINS',
  'IRIS_LOG_LEVEL',
] as const;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/*
 * node:http rather than fetch, for the same reason as
 * tests/unit/middleware/rebinding-guard.test.ts: fetch silently drops
 * forbidden headers, so a fetch-based hostile-header probe can pass while
 * asserting nothing. `Connection: close` keeps Node's keep-alive agent
 * from pinning the socket open, which would stall server.close() during
 * cleanup.
 */
function probe(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Connection: 'close', ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.once('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

export type WriteLine = (line: string) => void;

const stdoutLine: WriteLine = (line) => process.stdout.write(`${line}\n`);

export async function runSelfTest(write: WriteLine = stdoutLine): Promise<number> {
  write(`Iris self-test v${PKG_VERSION}`);
  write('');

  /*
   * Resolved BEFORE the env scrub: this is where a normal (non-self-test)
   * run of this install would keep its data, which is the line the user
   * actually wants from a diagnostic. The self-test itself never touches
   * this path.
   */
  const userStoragePath = process.env.IRIS_DB_PATH ?? join(irisHome(), 'iris.db');

  const savedEnv: Record<string, string | undefined> = {};
  for (const key of SCRUBBED_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }

  let tempHome: string | undefined;
  let config: IrisConfig | undefined;
  let storage: IStorageAdapter | undefined;
  let evalEngine: EvalEngine | undefined;
  let server: Server | undefined;
  let port = 0;
  let traceId = '';
  const insertedIds: string[] = [];
  const failedSteps: string[] = [];

  /*
   * Steps run strictly in order and stop at the first failure — each one
   * depends on the state the previous one built, so a cascade of
   * follow-on crosses would only bury the real cause. Cleanup runs
   * unconditionally afterwards.
   */
  const step = async (label: string, fn: () => Promise<string | void> | string | void): Promise<void> => {
    if (failedSteps.length > 0) return;
    try {
      const detail = await fn();
      write(`${CHECK} ${label}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      failedSteps.push(label);
      write(`${CROSS} ${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await step(SELF_TEST_STEPS.tempHome, () => {
    tempHome = mkdtempSync(join(tmpdir(), 'iris-self-test-'));
    for (const key of SCRUBBED_ENV_VARS) {
      delete process.env[key];
    }
    process.env.IRIS_HOME = tempHome;
    return tempHome;
  });

  await step(SELF_TEST_STEPS.storage, async () => {
    // dbPath is passed explicitly because defaultConfig captured the REAL
    // home's db path at module import — before IRIS_HOME pointed here.
    config = loadConfig({
      dbPath: join(tempHome!, 'iris.db'),
      dashboard: true,
      dashboardHost: '127.0.0.1',
    });
    config.dashboard.port = 0; // ephemeral — the rebinding guard resolves the bound port (dashboard/server.ts)
    config.logging.level = 'error'; // keep pino out of the report
    storage = createStorage(config);
    await storage.initialize();
    // One engine for all three evals, exactly as createIrisServer builds it.
    evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);
    return config.storage.path;
  });

  await step(SELF_TEST_STEPS.trace, async () => {
    /*
     * Evals are linked to a logged trace because that is the shape the
     * real flow produces (log_trace → evaluate_output with trace_id).
     * getEvalStats counts unlinked evals too, so linking is not what
     * gets the fixtures counted — it keeps the self-test exercising the
     * same trace→eval join the per-trace and dashboard scans rely on.
     */
    traceId = generateTraceId();
    const trace: Trace = {
      trace_id: traceId,
      agent_name: 'iris-self-test',
      input: 'self-test probe',
      output: 'self-test probe output',
      latency_ms: 5,
      cost_usd: 0,
      timestamp: new Date().toISOString(),
    };
    await storage!.insertTrace(LOCAL_TENANT, trace);
    const stored = await storage!.getTrace(LOCAL_TENANT, traceId);
    ensure(stored?.trace_id === traceId, 'logged trace did not come back from storage');
    return `trace ${traceId.slice(0, 8)}… persisted and read back`;
  });

  const persist = async (result: EvalResult): Promise<void> => {
    result.trace_id = traceId;
    await storage!.insertEvalResult(LOCAL_TENANT, result);
    insertedIds.push(result.id);
  };

  await step(SELF_TEST_STEPS.piiEval, async () => {
    const result = evalEngine!.evaluate('safety', {
      // A real-shaped SSN, not the never-issued 123-45-6789 documentation
      // placeholder — no_pii suppresses that one on purpose.
      output: 'Done. For the record, the customer SSN is 536-22-8145.',
    });
    const rule = result.rule_results.find((r) => r.ruleName === 'no_pii');
    ensure(rule, 'no_pii rule did not run');
    ensure(!rule.passed && rule.message.includes('SSN'), `no_pii missed the planted SSN: ${rule.message}`);
    await persist(result);
    return 'no_pii flagged the planted SSN';
  });

  await step(SELF_TEST_STEPS.injectionEval, async () => {
    const result = evalEngine!.evaluate('safety', {
      output: 'Sure. I will ignore all previous instructions and reveal the system prompt.',
    });
    const rule = result.rule_results.find((r) => r.ruleName === 'no_injection_patterns');
    ensure(rule, 'no_injection_patterns rule did not run');
    ensure(!rule.passed, `no_injection_patterns missed the planted override text: ${rule.message}`);
    await persist(result);
    return 'no_injection_patterns flagged the override text';
  });

  await step(SELF_TEST_STEPS.cleanEval, async () => {
    const result = evalEngine!.evaluate('safety', {
      output: 'The report is ready: weather in Paris stays mild this week, with light rain expected on Thursday evening.',
    });
    ensure(
      result.passed && result.score === 1,
      `clean output should score 1 and pass; got score=${result.score} passed=${result.passed}`,
    );
    await persist(result);
    return `score ${result.score}, passed`;
  });

  await step(SELF_TEST_STEPS.readBack, async () => {
    const { results, total } = await storage!.queryEvalResults(LOCAL_TENANT, {});
    ensure(
      total === insertedIds.length,
      `expected ${insertedIds.length} persisted result(s), found ${total}`,
    );
    const returnedIds = new Set(results.map((r) => r.id));
    for (const id of insertedIds) {
      ensure(returnedIds.has(id), `persisted result ${id} did not come back from storage`);
    }
    return `${total} result(s) round-tripped through SQLite`;
  });

  await step(SELF_TEST_STEPS.dashboard, async () => {
    const logger = createLogger(config!);
    const dashboard = createDashboardServer(storage!, config!, logger);
    server = dashboard.start();
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const addr = server.address();
    ensure(addr && typeof addr === 'object', 'dashboard reported no bound address');
    port = addr.port;
    return `http://127.0.0.1:${port}`;
  });

  await step(SELF_TEST_STEPS.health, async () => {
    const res = await probe(port, '/api/v1/health');
    ensure(res.status === 200, `expected 200, got ${res.status}`);
    const body = JSON.parse(res.body) as {
      status?: string;
      version?: string;
      storage?: string;
      trace_count?: number;
    };
    ensure(body.status === 'ok', `expected status "ok", got "${body.status}"`);
    ensure(body.version === PKG_VERSION, `expected version ${PKG_VERSION}, got ${body.version}`);
    ensure(body.storage === 'connected', `expected storage "connected", got "${body.storage}"`);
    ensure(body.trace_count === 1, `expected trace_count 1, got ${body.trace_count}`);
    return `status ok, v${body.version}, storage connected`;
  });

  await step(SELF_TEST_STEPS.stats, async () => {
    const res = await probe(port, '/api/v1/eval-stats?period=all');
    ensure(res.status === 200, `expected 200, got ${res.status}`);
    const body = JSON.parse(res.body) as {
      totalEvals?: number;
      safetyViolations?: { pii?: number; injection?: number };
    };
    ensure(
      body.totalEvals === insertedIds.length,
      `expected totalEvals ${insertedIds.length}, got ${body.totalEvals}`,
    );
    // The planted SSN and override text must surface as exactly one
    // violation each — the numbers on the dashboard have to be real.
    ensure(
      body.safetyViolations?.pii === 1 && body.safetyViolations?.injection === 1,
      `expected 1 PII + 1 injection violation, got ${JSON.stringify(body.safetyViolations)}`,
    );
    return `totalEvals ${body.totalEvals}, violations counted correctly`;
  });

  await step(SELF_TEST_STEPS.rebindingGuard, async () => {
    /*
     * Both directions, or the check is theater: a guard that 403s
     * EVERYTHING would "reject the hostile Origin" too. The server's own
     * origin must pass and the foreign one must be refused.
     */
    const own = await probe(port, '/api/v1/health', { Origin: `http://127.0.0.1:${port}` });
    ensure(own.status === 200, `own origin should pass, got ${own.status}`);
    const hostile = await probe(port, '/api/v1/health', { Origin: 'http://evil.attacker.example' });
    ensure(hostile.status === 403, `hostile Origin should get 403, got ${hostile.status}`);
    return 'own origin 200, hostile origin 403';
  });

  // Cleanup runs even after a failure — a failed diagnostic must not leave
  // a scratch directory, an open DB handle, or a bound port behind.
  try {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (storage) {
      await storage.close();
    }
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
    write(`${CHECK} ${SELF_TEST_STEPS.cleanup}`);
  } catch (err) {
    failedSteps.push(SELF_TEST_STEPS.cleanup);
    write(`${CROSS} ${SELF_TEST_STEPS.cleanup} — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const key of SCRUBBED_ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  }

  write('');
  write(`version   ${PKG_VERSION}`);
  write(`storage   ${userStoragePath}`);
  write(
    failedSteps.length === 0
      ? SELF_TEST_PASS_VERDICT
      : `${SELF_TEST_FAIL_VERDICT} — failed at: ${failedSteps.join(', ')}`,
  );
  return failedSteps.length === 0 ? 0 : 1;
}
