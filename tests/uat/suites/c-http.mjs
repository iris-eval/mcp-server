/*
 * Suite C — HTTP surface.
 *
 * A real `node dist/index.js --dashboard --dashboard-port 0` process on
 * an ephemeral loopback port, seeded through its own ingest endpoint so
 * the totals the harness asserts on are ones it can compute exactly.
 *
 * Every request goes through node:http (see lib/http.mjs) — required for
 * the Host/Origin probes, and used uniformly so there is only one header
 * behaviour in play.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../lib/proc.mjs';
import { getJson, postJson, raw } from '../lib/http.mjs';
import { assert, assertEq } from '../lib/report.mjs';
import { WORK_DIR } from '../lib/env.mjs';

/** Absolute-path shapes that must never appear in an HTTP response body. */
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/][^"'\s]{3,})|(?:\/(?:home|Users|root|var|opt)\/[^"'\s]{3,})/;

const SEED_AGENT = 'uat-http-agent';
const SEED_COUNT = 6;

function seedTrace(i) {
  return {
    agent_name: SEED_AGENT,
    framework: 'uat',
    input: `UAT prompt ${i}`,
    output:
      i % 3 === 0
        ? 'short'
        : `UAT output ${i}. This response is long enough to satisfy the minimum-length rule and contains two sentences.`,
    latency_ms: 100 + i,
    cost_usd: 0.001 * (i + 1),
    token_usage: { prompt_tokens: 100 + i, completion_tokens: 50 + i, total_tokens: 150 + 2 * i },
    metadata: { suite: 'uat-c', index: i },
  };
}

export async function runSuiteC(t) {
  t.beginSuite('C', 'HTTP surface');

  const home = join(WORK_DIR, 'c-http');
  mkdirSync(home, { recursive: true });

  let srv;
  try {
    srv = await startServer({
      argsFor: (p) => ['--dashboard', '--dashboard-port', String(p)],
      irisHome: home,
      label: '--dashboard server',
      timeoutMs: 60_000,
    });
  } catch (err) {
    t.fail('C1', 'dashboard HTTP server starts on an ephemeral port', err.message);
    return;
  }
  const port = srv.port;
  const state = { traceIds: [], evalCount: 0, ruleId: undefined };

  try {
    await t.check('C1', 'GET /api/v1/health returns 200 with a connected store', async () => {
      const res = await raw({ port, path: '/api/v1/health' });
      assertEq(res.status, 200, 'health status');
      assertEq(res.json.status, 'ok', 'health.status');
      assertEq(res.json.storage, 'connected', 'health.storage');
      assert(typeof res.json.version === 'string' && res.json.version.length > 0, 'health.version missing');
      return `v${res.json.version}, storage connected`;
    });

    await t.check('C2', 'POST /api/v1/traces with a valid body returns 201 and the trace is queryable', async () => {
      for (let i = 0; i < SEED_COUNT; i++) {
        const res = await postJson(port, '/api/v1/traces', seedTrace(i), 201);
        assertEq(res.json.status, 'stored', `seed ${i} status`);
        assert(/^[a-f0-9]{32}$/.test(res.json.trace_id), `seed ${i} trace_id shape: ${res.json.trace_id}`);
        state.traceIds.push(res.json.trace_id);
      }
      const listed = await getJson(port, `/api/v1/traces?agent_name=${SEED_AGENT}&limit=50`);
      assertEq(listed.total, SEED_COUNT, 'queryable trace count');
      const ids = new Set(listed.traces.map((x) => x.trace_id));
      const missing = state.traceIds.filter((id) => !ids.has(id));
      assert(missing.length === 0, `posted but not queryable: ${missing.join(', ')}`);
      return `${SEED_COUNT} posted, ${listed.total} queryable`;
    });

    await t.check('C3', 'POST /api/v1/traces with an invalid body returns 400 JSON', async () => {
      const res = await postJson(port, '/api/v1/traces', {});
      assertEq(res.status, 400, 'status for a body missing agent_name');
      assert(res.json !== undefined, `400 body was not JSON: ${res.body.slice(0, 200)}`);
      assert(res.json.error, '400 body carried no error field');
      const typed = await postJson(port, '/api/v1/traces', { agent_name: 12345 });
      assertEq(typed.status, 400, 'status for a wrongly-typed agent_name');
      return 'both malformed bodies rejected with JSON 400';
    });

    await t.check('C4', 'POST /api/v1/traces?evaluate=true returns an evaluation block', async () => {
      const pass = await postJson(
        port,
        '/api/v1/traces',
        {
          agent_name: SEED_AGENT,
          output: 'This evaluated output is comfortably long enough. It also contains a second sentence.',
          evaluate: true,
          eval_type: 'completeness',
        },
        201,
      );
      state.traceIds.push(pass.json.trace_id);
      state.evalCount += 1;
      const ev = pass.json.evaluation;
      assert(ev, `no evaluation block: ${JSON.stringify(pass.json).slice(0, 200)}`);
      assert(typeof ev.score === 'number' && ev.score >= 0 && ev.score <= 1, `score out of range: ${ev.score}`);
      assert(Array.isArray(ev.rule_results) && ev.rule_results.length > 0, 'evaluation.rule_results was empty');
      assertEq(ev.eval_type, 'completeness', 'evaluation.eval_type');
      assertEq(ev.passed, true, 'a comfortably long two-sentence output should pass completeness');

      // A deliberately failing eval too, so the /failures ranking below
      // has something real to rank. A ranked list asserted only for
      // shape against an empty result set proves nothing.
      const fail = await postJson(
        port,
        '/api/v1/traces',
        { agent_name: SEED_AGENT, output: 'no.', evaluate: true, eval_type: 'completeness' },
        201,
      );
      state.traceIds.push(fail.json.trace_id);
      state.evalCount += 1;
      state.failingTraceId = fail.json.trace_id;
      assertEq(fail.json.evaluation.passed, false, 'a 3-character output should fail completeness');
      return `pass ${ev.score.toFixed(3)} / fail ${fail.json.evaluation.score.toFixed(3)}`;
    });

    await t.check('C5', 'POST /api/v1/traces with evaluate=true but no output returns 400', async () => {
      const res = await postJson(port, '/api/v1/traces', { agent_name: SEED_AGENT, evaluate: true });
      assertEq(res.status, 400, 'status');
      assert(/output/i.test(res.body), `400 body did not name the offending field: ${res.body.slice(0, 200)}`);
      return 'rejected, names "output"';
    });

    await t.check('C6', 'GET /api/v1/summary totals agree with /traces and /health', async () => {
      const expected = state.traceIds.length;
      const summary = await getJson(port, '/api/v1/summary?hours=1');
      const traces = await getJson(port, '/api/v1/traces?limit=200');
      const health = await getJson(port, '/api/v1/health');
      assertEq(summary.total_traces, expected, 'summary.total_traces');
      assertEq(traces.total, expected, 'traces.total');
      assertEq(health.trace_count, expected, 'health.trace_count');
      assert(Array.isArray(summary.top_agents) && summary.top_agents[0]?.agent_name === SEED_AGENT, 'summary.top_agents did not surface the seeded agent');
      return `all three report ${expected}`;
    });

    await t.check('C7', 'GET /api/v1/eval-stats reports the evaluations that were actually created', async () => {
      const stats = await getJson(port, '/api/v1/eval-stats?period=all');
      assertEq(stats.totalEvals, state.evalCount, 'eval-stats.totalEvals');
      assert(typeof stats.passRate === 'number' || typeof stats.avgScore === 'number', `unexpected eval-stats shape: ${JSON.stringify(stats).slice(0, 200)}`);
      return `totalEvals=${stats.totalEvals}`;
    });

    await t.check('C8', 'GET /api/v1/failures ranks the trace that actually failed its eval', async () => {
      const out = await getJson(port, '/api/v1/failures?limit=20');
      const list = Array.isArray(out) ? out : (out.failures ?? out.moments);
      assert(Array.isArray(list), `no failures array in response: ${JSON.stringify(out).slice(0, 200)}`);
      assert(list.length > 0, 'ranked list was empty despite a deliberately failing eval');
      const found = list.find((f) => (f.traceId ?? f.trace_id ?? f.trace?.trace_id) === state.failingTraceId);
      assert(found, `the failing trace ${state.failingTraceId} is not in the ranked list of ${list.length}`);
      assert(typeof found.rankScore === 'number', 'ranked entry carries no rankScore');
      return `${list.length} ranked, failing trace present (rankScore ${found.rankScore.toFixed(3)})`;
    });

    await t.check('C9', 'GET /api/v1/traces/:id returns trace + spans + evals; an unknown id 404s', async () => {
      const id = state.traceIds[0];
      const detail = await getJson(port, `/api/v1/traces/${id}`);
      assertEq(detail.trace.trace_id, id, 'detail.trace.trace_id');
      assert(Array.isArray(detail.spans), 'detail.spans is not an array');
      assert(Array.isArray(detail.evals), 'detail.evals is not an array');
      const missing = await raw({ port, path: '/api/v1/traces/00000000000000000000000000000000' });
      assertEq(missing.status, 404, 'unknown trace id status');
      assert(missing.json?.error, '404 body carried no JSON error field');
      return 'detail 200, unknown id 404';
    });

    await t.check('C10', 'every read endpoint answers 200 with JSON', async () => {
      const paths = [
        '/api/v1/health',
        '/api/v1/summary',
        '/api/v1/traces',
        '/api/v1/evaluations',
        '/api/v1/eval-stats',
        '/api/v1/eval-stats/trend',
        '/api/v1/eval-stats/rules',
        '/api/v1/eval-stats/failures',
        '/api/v1/filters',
        '/api/v1/moments',
        '/api/v1/failures',
        '/api/v1/rules/custom',
        '/api/v1/preferences',
        '/api/v1/audit',
      ];
      const bad = [];
      for (const p of paths) {
        const res = await raw({ port, path: p });
        const ct = String(res.headers['content-type'] ?? '');
        if (res.status !== 200) bad.push(`${p} → ${res.status}`);
        else if (!ct.includes('application/json')) bad.push(`${p} → content-type ${ct}`);
        else if (res.json === undefined) bad.push(`${p} → unparseable body`);
      }
      assert(bad.length === 0, bad.join(' | '));
      return `${paths.length}/${paths.length} endpoints 200 + JSON`;
    });

    await t.check('C11', 'GET /api/v1/moments/:id returns a hydrated moment', async () => {
      const id = state.traceIds[0];
      const res = await raw({ port, path: `/api/v1/moments/${id}` });
      assertEq(res.status, 200, 'moment detail status');
      assert(res.json, 'moment detail body was not JSON');
      const missing = await raw({ port, path: '/api/v1/moments/00000000000000000000000000000000' });
      assertEq(missing.status, 404, 'unknown moment id status');
      return 'detail 200, unknown id 404';
    });

    // ---- Rules CRUD over HTTP -------------------------------------------
    await t.check('C12', 'POST /api/v1/rules/custom creates a rule (201) and GET lists it', async () => {
      const res = await postJson(
        port,
        '/api/v1/rules/custom',
        {
          name: 'uat-http-rule',
          description: 'UAT harness rule deployed over HTTP.',
          evalType: 'custom',
          severity: 'medium',
          definition: { name: 'uat-http-rule', type: 'min_length', config: { min_length: 40 } },
        },
        201,
      );
      assert(/^rule-[a-z0-9]+$/.test(res.json.rule.id), `rule id shape: ${res.json.rule.id}`);
      state.ruleId = res.json.rule.id;
      const list = await getJson(port, '/api/v1/rules/custom');
      assert(list.rules.some((r) => r.id === state.ruleId), 'created rule is not listed');
      return `${state.ruleId}`;
    });

    await t.check('C13', 'POST /api/v1/rules/custom with an invalid definition returns 400 JSON', async () => {
      const res = await postJson(port, '/api/v1/rules/custom', {
        name: 'uat bad rule!!',
        evalType: 'custom',
        definition: { name: 'x', type: 'not_a_type', config: {} },
      });
      assertEq(res.status, 400, 'status');
      assert(res.json?.error, `400 body carried no error field: ${res.body.slice(0, 200)}`);
      return 'rejected with JSON 400';
    });

    await t.check('C14', 'POST /api/v1/rules/custom/preview dry-runs against history', async () => {
      const res = await postJson(
        port,
        '/api/v1/rules/custom/preview',
        {
          definition: { name: 'uat-preview', type: 'min_length', config: { min_length: 40 } },
          evalType: 'custom',
          windowDays: 7,
          maxTraces: 100,
        },
        200,
      );
      const r = res.json;
      assert(typeof r.tracesEvaluated === 'number', `no tracesEvaluated: ${JSON.stringify(r).slice(0, 200)}`);
      assert(typeof r.wouldFail === 'number' && typeof r.wouldPass === 'number', 'preview is missing wouldFail/wouldPass');
      assert(Array.isArray(r.examples), 'preview.examples is not an array');
      assert(r.tracesEvaluated > 0, `preview evaluated 0 traces despite ${state.traceIds.length} seeded`);
      assertEq(r.wouldPass + r.wouldFail + r.wouldSkip, r.tracesEvaluated, 'preview counts do not sum to tracesEvaluated');
      // The seeded corpus contains deliberate short outputs ("short"),
      // so a 40-char minimum must find at least one failure — otherwise
      // the preview is reporting on nothing.
      assert(r.wouldFail > 0, `preview found 0 failures despite ${SEED_COUNT / 3} deliberately short outputs`);
      return `evaluated ${r.tracesEvaluated}, wouldFail ${r.wouldFail}`;
    });

    await t.check('C15', 'DELETE /api/v1/rules/custom/:id returns 204 then 404 on repeat', async () => {
      assert(state.ruleId, 'no rule id from C12');
      const del = await raw({ port, method: 'DELETE', path: `/api/v1/rules/custom/${state.ruleId}` });
      assertEq(del.status, 204, 'first delete status');
      const again = await raw({ port, method: 'DELETE', path: `/api/v1/rules/custom/${state.ruleId}` });
      assertEq(again.status, 404, 'repeat delete status');
      const list = await getJson(port, '/api/v1/rules/custom');
      assert(!list.rules.some((r) => r.id === state.ruleId), 'deleted rule is still listed');
      return '204 then 404, delisted';
    });

    // ---- Hostile headers -------------------------------------------------
    await t.check('C16', 'a hostile Origin is rejected with 403 (and the server\'s own Origin is not)', async () => {
      const own = await raw({ port, path: '/api/v1/health', headers: { Origin: `http://127.0.0.1:${port}` } });
      assertEq(own.status, 200, "the server's own Origin must still pass");
      const hostile = await raw({ port, path: '/api/v1/health', headers: { Origin: 'http://evil.attacker.example' } });
      assertEq(hostile.status, 403, 'hostile Origin status');
      // Both directions, or the check is theatre: a guard that 403s
      // everything would "reject the hostile Origin" too.
      const write = await raw({
        port,
        method: 'POST',
        path: '/api/v1/rules/custom',
        headers: { Origin: 'http://evil.attacker.example' },
        body: { name: 'evil', evalType: 'custom', definition: { name: 'evil', type: 'min_length', config: { min_length: 1 } } },
      });
      assertEq(write.status, 403, 'hostile-Origin WRITE status');
      return 'own 200, hostile read 403, hostile write 403';
    });

    await t.check('C17', 'a forged Host header is rejected with 403', async () => {
      const forged = await raw({
        port,
        path: '/api/v1/health',
        headers: { Host: 'attacker.example' },
      });
      assertEq(forged.status, 403, 'forged Host status');
      const forgedPort = await raw({
        port,
        path: '/api/v1/health',
        headers: { Host: `127.0.0.1:${port + 1}` },
      });
      assertEq(forgedPort.status, 403, 'wrong-port Host status');
      const legit = await raw({ port, path: '/api/v1/health', headers: { Host: `127.0.0.1:${port}` } });
      assertEq(legit.status, 200, 'the real Host must still pass');
      return 'forged host 403, wrong port 403, real host 200';
    });

    // ---- Error-body hygiene ---------------------------------------------
    await t.check('C18', 'a 404 response body contains no absolute filesystem path', async () => {
      const probes = ['/definitely-not-a-route', '/api/v1/not-a-route', '/api/v1/traces/../../etc/passwd'];
      const leaks = [];
      for (const p of probes) {
        const res = await raw({ port, path: p });
        const m = res.body.match(ABS_PATH_RE);
        if (m) leaks.push(`${p} (${res.status}) leaked "${m[0].slice(0, 80)}"`);
      }
      assert(leaks.length === 0, leaks.join(' | '));
      return `${probes.length} 404 probes clean`;
    });

    await t.check('C19', 'error responses are JSON, never an HTML stack trace', async () => {
      const probes = [
        { path: '/api/v1/traces?limit=99999', expect: 400 },
        { path: '/api/v1/audit?limit=0', expect: 400 },
        { path: '/api/v1/health', headers: { Origin: 'http://evil.attacker.example' }, expect: 403 },
        { path: '/api/v1/traces/00000000000000000000000000000000', expect: 404 },
      ];
      const bad = [];
      for (const p of probes) {
        const res = await raw({ port, path: p.path, headers: p.headers ?? {} });
        if (res.status !== p.expect) bad.push(`${p.path} → ${res.status} (expected ${p.expect})`);
        else if (/<html|<!DOCTYPE|<pre>/i.test(res.body)) bad.push(`${p.path} → HTML body`);
        else if (res.json === undefined) bad.push(`${p.path} → non-JSON body: ${res.body.slice(0, 80)}`);
      }
      assert(bad.length === 0, bad.join(' | '));
      return `${probes.length} error responses all JSON`;
    });

    await t.check('C20', 'no successful API response discloses the install path', async () => {
      const paths = [
        '/api/v1/health',
        '/api/v1/summary',
        '/api/v1/traces',
        '/api/v1/evaluations',
        '/api/v1/eval-stats',
        '/api/v1/filters',
        '/api/v1/moments',
        '/api/v1/failures',
        '/api/v1/rules/custom',
        '/api/v1/preferences',
        '/api/v1/audit',
      ];
      const leaks = [];
      for (const p of paths) {
        const res = await raw({ port, path: p });
        const m = res.body.match(ABS_PATH_RE);
        if (m) leaks.push(`${p} leaked "${m[0].slice(0, 90)}"`);
      }
      assert(leaks.length === 0, leaks.join(' | '));
      return `${paths.length} endpoints disclose no filesystem path`;
    });
  } finally {
    await srv.stop();
  }
}
