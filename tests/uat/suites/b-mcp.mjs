/*
 * Suite B — MCP tool surface over REAL stdio.
 *
 * Uses the MCP SDK client shipped in the iris repo's node_modules, so
 * the harness speaks the same protocol version the server was built
 * against. Every tool is invoked through the transport — no in-process
 * shortcuts — because the thing under test is the tool CONTRACT (name,
 * schema, result shape), not the function behind it.
 *
 * Two sessions run against ONE scratch IRIS_HOME. The second is a
 * deliberate restart: it separates "a deployed rule never fires" from
 * "a deployed rule needs a restart to fire", which are different bugs
 * with different fixes.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, assertEq } from '../lib/report.mjs';
import { IRIS_ENTRY, IRIS_NODE_MODULES, IRIS_REPO, WORK_DIR, baseChildEnv } from '../lib/env.mjs';

const SDK = join(IRIS_NODE_MODULES, '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
const CALL_TIMEOUT_MS = 20_000;

/** Marker string the deployed UAT rule forbids. Unique so nothing else can match it. */
const FORBIDDEN = 'UAT-FORBIDDEN-TOKEN-9f3a';
const RULE_NAME = 'uat-forbidden-token';

const DETERMINISTIC_OUTPUT =
  'The quarterly report shows 18% revenue growth. Operating margins improved to 23%. ' +
  'Enterprise retention held steady across every measured segment this period.';

async function connect(irisHome, label) {
  const { Client } = await import(pathToFileURL(join(SDK, 'index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(join(SDK, 'stdio.js')).href);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [IRIS_ENTRY],
    cwd: IRIS_REPO,
    env: baseChildEnv(irisHome),
    stderr: 'pipe',
  });
  let stderr = '';
  const client = new Client({ name: `iris-uat-${label}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  if (transport.stderr) {
    transport.stderr.on('data', (d) => {
      stderr += String(d);
    });
  }
  return {
    client,
    stderr: () => stderr,
    async close() {
      try {
        await client.close();
      } catch {
        /* transport already down */
      }
    },
  };
}

/** Call a tool and return {isError, text, json}. Never throws on a tool-level error. */
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: res.isError === true, text, json, raw: res };
}

/** Call a tool expecting success; throws with the tool's own error text otherwise. */
async function callOk(client, name, args) {
  const r = await call(client, name, args);
  assert(!r.isError, `${name} returned isError — ${r.text.slice(0, 300)}`);
  assert(r.json !== undefined, `${name} result was not JSON: ${r.text.slice(0, 300)}`);
  return r.json;
}

export async function runSuiteB(t, claims) {
  t.beginSuite('B', 'MCP tool surface (stdio)');

  const home = join(WORK_DIR, 'b-mcp');
  mkdirSync(home, { recursive: true });

  const expectedTools = [...claims.mcpTools.names].sort();
  const state = { traceId: undefined, ruleId: undefined, baselineScore: undefined };

  let s1;
  try {
    s1 = await connect(home, 'session1');
  } catch (err) {
    t.fail('B1', 'MCP stdio session connects', err.message);
    return;
  }

  await t.check('B1', 'advertised tool list exactly matches .claims.json mcpTools.names', async () => {
    const { tools } = await s1.client.listTools();
    const actual = tools.map((x) => x.name).sort();
    const missing = expectedTools.filter((n) => !actual.includes(n));
    const extra = actual.filter((n) => !expectedTools.includes(n));
    assert(
      missing.length === 0 && extra.length === 0,
      `tool-list drift — missing: [${missing.join(', ')}] extra: [${extra.join(', ')}]`,
    );
    return `${actual.length} tools, exact match`;
  });

  await t.check('B2', 'every advertised tool carries a description and an input schema', async () => {
    const { tools } = await s1.client.listTools();
    const bad = tools
      .filter((x) => !x.description || !x.inputSchema || x.inputSchema.type !== 'object')
      .map((x) => x.name);
    assert(bad.length === 0, `tools with a missing description or malformed inputSchema: ${bad.join(', ')}`);
    return `${tools.length} tools well-formed`;
  });

  await t.check('B3', 'log_trace stores a trace and returns a 32-hex trace_id', async () => {
    const out = await callOk(s1.client, 'log_trace', {
      agent_name: 'uat-agent',
      framework: 'uat',
      input: 'What are the quarterly numbers?',
      output: DETERMINISTIC_OUTPUT,
      latency_ms: 42,
      cost_usd: 0.0012,
      token_usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      metadata: { suite: 'uat-b' },
    });
    assertEq(out.status, 'stored', 'log_trace status');
    assert(/^[a-f0-9]{32}$/.test(out.trace_id), `trace_id is not 32-hex: ${out.trace_id}`);
    state.traceId = out.trace_id;
    return `trace ${out.trace_id.slice(0, 12)}…`;
  });

  await t.check('B4', 'get_traces returns the trace just logged', async () => {
    assert(state.traceId, 'no trace_id from B3 — cannot query');
    const out = await callOk(s1.client, 'get_traces', { agent_name: 'uat-agent', limit: 10 });
    assert(Array.isArray(out.traces), `expected a traces array, got ${JSON.stringify(out).slice(0, 200)}`);
    const found = out.traces.find((x) => x.trace_id === state.traceId);
    assert(found, `logged trace ${state.traceId} not returned by get_traces (total=${out.total})`);
    assertEq(found.agent_name, 'uat-agent', 'round-tripped agent_name');
    assertEq(found.output, DETERMINISTIC_OUTPUT, 'round-tripped output text');
    return `found, total=${out.total}`;
  });

  await t.check('B5', 'evaluate_output returns a well-formed score + rule_results', async () => {
    const out = await callOk(s1.client, 'evaluate_output', {
      output: DETERMINISTIC_OUTPUT,
      eval_type: 'completeness',
      trace_id: state.traceId,
    });
    assert(typeof out.score === 'number' && out.score >= 0 && out.score <= 1, `score out of range: ${out.score}`);
    assert(typeof out.passed === 'boolean', `passed is not a boolean: ${out.passed}`);
    assert(Array.isArray(out.rule_results) && out.rule_results.length > 0, 'rule_results was empty');
    const malformed = out.rule_results.filter(
      (r) => typeof r.ruleName !== 'string' || typeof r.passed !== 'boolean' || typeof r.score !== 'number',
    );
    assert(malformed.length === 0, `malformed rule_results entries: ${JSON.stringify(malformed).slice(0, 200)}`);
    assertEq(out.rules_evaluated, out.rule_results.filter((r) => !r.skipped).length, 'rules_evaluated vs rule_results');
    state.baselineScore = out.score;
    return `score ${out.score.toFixed(4)}, ${out.rule_results.length} rules`;
  });

  await t.check('B6', 'evaluate_output is deterministic across repeated calls', async () => {
    assert(state.baselineScore !== undefined, 'no baseline score from B5');
    const a = await callOk(s1.client, 'evaluate_output', { output: DETERMINISTIC_OUTPUT, eval_type: 'completeness' });
    const b = await callOk(s1.client, 'evaluate_output', { output: DETERMINISTIC_OUTPUT, eval_type: 'completeness' });
    assertEq(a.score, state.baselineScore, 'repeat call 1 score');
    assertEq(b.score, state.baselineScore, 'repeat call 2 score');
    assert(a.id !== b.id, 'two evaluations reused the same eval id');
    return `score stable at ${a.score.toFixed(4)} over 3 calls`;
  });

  await t.check('B7', 'evaluate_output safety rules catch a planted PII string', async () => {
    const out = await callOk(s1.client, 'evaluate_output', {
      output: 'Sure — the customer SSN is 123-45-6789 and I have emailed it to the vendor.',
      eval_type: 'safety',
    });
    const pii = out.rule_results.find((r) => /pii/i.test(r.ruleName));
    assert(pii, `no PII rule in rule_results: ${out.rule_results.map((r) => r.ruleName).join(', ')}`);
    assertEq(pii.passed, false, 'planted SSN should fail the PII rule');
    return `${pii.ruleName} failed as expected`;
  });

  await t.check('B8', 'get_traces include_summary returns consistent aggregate stats', async () => {
    const out = await callOk(s1.client, 'get_traces', { agent_name: 'uat-agent', limit: 10, include_summary: true });
    assert(out.summary, `no summary block in response: ${JSON.stringify(out).slice(0, 200)}`);
    assert(typeof out.summary.total_traces === 'number', 'summary.total_traces is not a number');
    assert(typeof out.summary.eval_pass_rate === 'number', 'summary.eval_pass_rate is not a number');
    assert(out.summary.total_traces >= out.traces.length, `summary.total_traces (${out.summary.total_traces}) < returned traces (${out.traces.length})`);
    return `total_traces=${out.summary.total_traces}, pass_rate=${out.summary.eval_pass_rate}`;
  });

  await t.check('B9', 'deploy_rule persists a valid custom rule and returns its id', async () => {
    const out = await callOk(s1.client, 'deploy_rule', {
      name: RULE_NAME,
      description: 'UAT harness rule — forbids a unique marker token.',
      evalType: 'custom',
      severity: 'high',
      definition: { name: RULE_NAME, type: 'regex_no_match', config: { pattern: FORBIDDEN } },
    });
    assert(out.rule, `no rule in response: ${JSON.stringify(out).slice(0, 200)}`);
    assert(/^rule-[a-z0-9]+$/.test(out.rule.id), `rule id has the wrong shape: ${out.rule.id}`);
    assertEq(out.rule.enabled, true, 'newly deployed rule should be enabled');
    assertEq(out.rule.version, 1, 'newly deployed rule version');
    state.ruleId = out.rule.id;
    return `${out.rule.id}`;
  });

  await t.check('B10', 'list_rules includes the deployed rule', async () => {
    assert(state.ruleId, 'no rule id from B9');
    const out = await callOk(s1.client, 'list_rules', {});
    const found = (out.rules ?? []).find((r) => r.id === state.ruleId);
    assert(found, `deployed rule not listed (total=${out.total})`);
    assertEq(found.name, RULE_NAME, 'listed rule name');
    return `listed, total=${out.total}, enabled=${out.enabled_count}`;
  });

  await t.check('B11', 'a rule deployed via deploy_rule FIRES on a matching evaluate_output (same session)', async () => {
    assert(state.ruleId, 'no rule id from B9');
    const out = await callOk(s1.client, 'evaluate_output', {
      output: `Here is the summary. ${FORBIDDEN} appears in this output.`,
      eval_type: 'custom',
    });
    const hit = (out.rule_results ?? []).find((r) => r.ruleName === RULE_NAME);
    assert(
      hit,
      `the deployed rule did not fire — rule_results=${JSON.stringify(out.rule_results)}, ` +
        `rules_evaluated=${out.rules_evaluated}, insufficient_data=${out.insufficient_data}`,
    );
    assertEq(hit.passed, false, 'forbidden token present, so the rule must fail');
    return `${RULE_NAME} fired and failed as expected`;
  });

  await s1.close();

  // ---- Session 2: restart against the same IRIS_HOME --------------------
  let s2;
  try {
    s2 = await connect(home, 'session2');
  } catch (err) {
    t.fail('B12', 'deployed rule survives a server restart', err.message);
    return;
  }

  await t.check('B12', 'a deployed rule survives a restart and fires after it', async () => {
    assert(state.ruleId, 'no rule id from B9');
    const listed = await callOk(s2.client, 'list_rules', {});
    const found = (listed.rules ?? []).find((r) => r.id === state.ruleId);
    assert(found, 'the deployed rule did not survive the restart');
    const out = await callOk(s2.client, 'evaluate_output', {
      output: `Here is the summary. ${FORBIDDEN} appears in this output.`,
      eval_type: 'custom',
    });
    const hit = (out.rule_results ?? []).find((r) => r.ruleName === RULE_NAME);
    assert(hit, `after restart the rule still did not fire — rule_results=${JSON.stringify(out.rule_results)}`);
    assertEq(hit.passed, false, 'forbidden token present, so the rule must fail');
    return 'persisted and fires after restart';
  });

  await t.check('B13', 'delete_rule removes the rule and list_rules stops returning it', async () => {
    assert(state.ruleId, 'no rule id from B9');
    const del = await callOk(s2.client, 'delete_rule', { rule_id: state.ruleId });
    assertEq(del.deleted, true, 'delete_rule deleted flag');
    const listed = await callOk(s2.client, 'list_rules', {});
    const still = (listed.rules ?? []).find((r) => r.id === state.ruleId);
    assert(!still, 'rule is still listed after delete_rule');
    return 'deleted and delisted';
  });

  await t.check('B14', 'delete_rule on an unknown id reports deleted=false rather than crashing', async () => {
    const del = await call(s2.client, 'delete_rule', { rule_id: 'rule-deadbeef' });
    assert(!del.isError, `delete_rule on a missing id errored: ${del.text.slice(0, 200)}`);
    assertEq(del.json.deleted, false, 'deleted flag for an unknown rule');
    return 'deleted=false';
  });

  await t.check('B15', 'delete_trace removes the trace and get_traces stops returning it', async () => {
    assert(state.traceId, 'no trace id from B3');
    const del = await callOk(s2.client, 'delete_trace', { trace_id: state.traceId });
    assertEq(del.deleted, true, 'delete_trace deleted flag');
    const out = await callOk(s2.client, 'get_traces', { agent_name: 'uat-agent', limit: 10 });
    const still = (out.traces ?? []).find((x) => x.trace_id === state.traceId);
    assert(!still, 'trace is still returned after delete_trace');
    return 'deleted and no longer queryable';
  });

  await t.check('B16', 'evaluate_with_llm_judge without an API key fails gracefully and fast', async () => {
    const t0 = Date.now();
    const r = await call(s2.client, 'evaluate_with_llm_judge', {
      output: DETERMINISTIC_OUTPUT,
      template: 'accuracy',
      model: 'claude-haiku-4-5-20251001',
    });
    const ms = Date.now() - t0;
    assert(r.isError, `expected a tool error with no API key, got a success result: ${r.text.slice(0, 200)}`);
    assert(
      /IRIS_ANTHROPIC_API_KEY/.test(r.text),
      `error message is not actionable (should name the env var): ${r.text.slice(0, 300)}`,
    );
    assert(ms < CALL_TIMEOUT_MS, `took ${ms}ms — it should fail immediately, not hang`);
    return `errored in ${ms}ms naming IRIS_ANTHROPIC_API_KEY`;
  });

  await t.check('B17', 'evaluate_with_llm_judge rejects an unknown template rather than crashing', async () => {
    const r = await call(s2.client, 'evaluate_with_llm_judge', {
      output: DETERMINISTIC_OUTPUT,
      template: 'not-a-template',
      model: 'claude-haiku-4-5-20251001',
    });
    assert(r.isError, 'an invalid template was accepted');
    assert(r.text.length > 0, 'validation failure produced no message');
    return 'rejected with a message';
  });

  await t.check('B18', 'verify_citations with fetch enabled but no API key fails gracefully and fast', async () => {
    const t0 = Date.now();
    const r = await call(s2.client, 'verify_citations', {
      output: 'As shown in https://example.com/paper and doi:10.1000/xyz123, the effect is robust.',
      model: 'claude-haiku-4-5-20251001',
      allow_fetch: true,
      max_citations: 2,
      per_source_timeout_ms: 3000,
    });
    const ms = Date.now() - t0;
    assert(r.isError, `expected a tool error with no API key, got a success result: ${r.text.slice(0, 200)}`);
    assert(
      /IRIS_ANTHROPIC_API_KEY/.test(r.text),
      `error message is not actionable (should name the env var): ${r.text.slice(0, 300)}`,
    );
    assert(ms < CALL_TIMEOUT_MS, `took ${ms}ms — it should fail immediately, not hang`);
    return `errored in ${ms}ms naming IRIS_ANTHROPIC_API_KEY`;
  });

  await t.check('B19', 'an unknown tool name is refused, not silently accepted', async () => {
    let refused = false;
    let detail = '';
    try {
      const r = await call(s2.client, 'not_a_real_tool', {});
      refused = r.isError;
      detail = r.text.slice(0, 200);
    } catch (err) {
      refused = true;
      detail = err.message.slice(0, 200);
    }
    assert(refused, `an unknown tool call was not refused: ${detail}`);
    return 'refused';
  });

  await s2.close();
}
