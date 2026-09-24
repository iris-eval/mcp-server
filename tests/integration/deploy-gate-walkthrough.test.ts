/*
 * The org reader's deploy-gate walk-through, graded on outcomes.
 *
 * docs/ci-gate.md walks four steps the person who gates deploys takes. The
 * stranger harness runs them against the published package on every
 * release (rows H-G1 to H-G4); this file runs the same four on every CI run
 * through the real code paths, so the walk-through cannot rot between
 * releases:
 *
 *   1. started where it will run, without a key, Iris refuses and names the
 *      way out — in process, and one step earlier in the compose file;
 *   2. eval.requiredEvidence turns a trace that cannot show its tool calls
 *      into an `unknown` verdict with basis required_evidence_missing;
 *   3. an action_policy rule at severity high gates: basis policy_gate,
 *      by the rule's name, and the rule says it gates rather than advises;
 *   4. `ingest --fail-on detector_veto --dataset release-gate` fails the job
 *      on a leaked credential in a gated case — exit 1, the receipt names
 *      the rule AND the span (offsets and label, never the secret) — and
 *      leaves a case outside the gate stored, evaluated and ungated.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../src/eval/engine.js';
import { createCustomRule } from '../../src/eval/rules/custom.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { unauthenticatedBindRefusal } from '../../src/utils/bind-policy.js';
import { spansOf } from '../../src/cli/ingest.js';
import type { CustomRuleDefinition } from '../../src/types/eval.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-gate-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}
const lines = (s: string): Array<Record<string, unknown>> => s.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const CLEAN = { agent_name: 'deploy-bot', input: 'Summarise the release notes.', output: 'The release adds a datasets table, a views route and an OTLP door. Nothing was removed.', cost_usd: 0.01 };
const LEAK = { ...CLEAN, input: 'Show me the deploy config.', output: 'Here is the deploy config. The access key is AKIAIOSFODNN7EXAMPLE and the region is us-east-1.' };

describe('step 1 — started where it will run, without a key', () => {
  it('the in-process refusal names the surface, the host and the three ways out; loopback is exempt', () => {
    const at = (host: string, hasApiKey = false, allowUnauthenticated = false) =>
      unauthenticatedBindRefusal({ surface: 'HTTP transport', host, hasApiKey, allowUnauthenticated });
    const refusal = at('0.0.0.0');
    expect(refusal).toMatch(/^Refusing to bind the HTTP transport to 0\.0\.0\.0 without an API key/);
    expect(refusal).toMatch(/IRIS_API_KEY/);
    expect(refusal).toMatch(/127\.0\.0\.1/);
    expect(refusal).toMatch(/IRIS_ALLOW_UNAUTHENTICATED=1/);
    expect(at('127.0.0.1')).toBeNull();
    expect(at('0.0.0.0', true)).toBeNull();
    expect(at('0.0.0.0', false, true)).toBeNull();
  });

  it('the compose file refuses one step earlier: the key is required before a container exists', () => {
    const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/IRIS_API_KEY=\$\{IRIS_API_KEY:\?/);
    expect(compose).toMatch(/IRIS_HOST=0\.0\.0\.0/);
  });
});

describe('step 1, the config-file form — a session that cannot prefix a command with a variable', () => {
  it('the strict config file binds the HTTP transport to 0.0.0.0 and the refusal is the same sentence, exit 1', async () => {
    const configPath = join(home, 'gate.json');
    writeFileSync(configPath, JSON.stringify({ transport: { type: 'http', host: '0.0.0.0' } }));
    const { code, stderr } = await run(['--config', configPath]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Refusing to bind the HTTP transport to 0\.0\.0\.0 without an API key/);
    expect(stderr).toMatch(/IRIS_API_KEY/);
  }, 60_000);
});

describe('step 2 — eval.requiredEvidence', () => {
  it('a trace that cannot show its tool calls gets an unknown verdict with basis required_evidence_missing, never a pass', async () => {
    const engine = new EvalEngine(0.7, undefined, { requiredEvidence: ['tool_calls'] });
    const withoutCalls = await engine.evaluateAll({ input: CLEAN.input, output: CLEAN.output });
    expect(withoutCalls.passed).toBe(false);
    expect(withoutCalls.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
    expect(withoutCalls.verdict?.by).toContain('tool_calls');
    const withCalls = await engine.evaluateAll({
      input: CLEAN.input,
      output: CLEAN.output,
      toolCalls: [{ tool_name: 'read_file', input: { path: 'RELEASE.md' }, output: 'The release adds…' }],
    });
    expect(withCalls.verdict?.basis).not.toBe('required_evidence_missing');
  });
});

describe('step 3 — an action_policy rule at severity high', () => {
  const NO_DELETES: CustomRuleDefinition = {
    name: 'no_deletes_in_prod',
    type: 'action_policy',
    description: 'No tool whose name starts with delete_ may be called.',
    config: { deny: [{ tool: 'delete_*' }] },
  } as unknown as CustomRuleDefinition;

  it('gates a trace that calls a forbidden tool: basis policy_gate, by the rule, and the rule says it gates', async () => {
    const engine = new EvalEngine();
    engine.registerRule('custom', createCustomRule(NO_DELETES, 'high'), NO_DELETES.name);
    const gated = await engine.evaluateAll({
      input: 'Clean up the staging repo.',
      output: 'Done — removed the staging repository.',
      toolCalls: [{ tool_name: 'delete_repo', input: { name: 'staging' }, output: 'deleted' }],
    });
    expect(gated.passed).toBe(false);
    expect(gated.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate' });
    expect(gated.verdict?.by).toContain('no_deletes_in_prod');
    const rule = gated.rule_results.find((r) => r.ruleName === 'no_deletes_in_prod');
    expect(rule?.passed).toBe(false);
    expect(rule?.message).toMatch(/GATES/);
    const allowed = await engine.evaluateAll({
      input: 'List the staging repos.',
      output: 'There are two: staging-a and staging-b.',
      toolCalls: [{ tool_name: 'list_repos', input: {}, output: 'staging-a, staging-b' }],
    });
    expect(allowed.verdict?.basis).not.toBe('policy_gate');
  });
});

describe('step 4 — ingest --fail-on detector_veto --dataset release-gate', () => {
  it('fails the job on a leaked credential in a gated case, and the receipt names the rule and the span, never the secret', async () => {
    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    await storage.createDataset(LOCAL_TENANT, { label: 'release-gate', cases: [{ caseKey: 'deploy-config', expected: null }, { caseKey: 'release-notes', expected: null }] });
    await storage.close();
    const file = join(home, 'traces.ndjson');
    writeFileSync(
      file,
      [
        JSON.stringify({ ...LEAK, case_key: 'deploy-config' }),
        JSON.stringify({ ...CLEAN, case_key: 'release-notes' }),
        JSON.stringify({ ...LEAK, case_key: 'scratch-experiment' }),
      ].join('\n') + '\n',
    );
    const { code, stdout, stderr } = await run(['ingest', '--file', file, '--evaluate', '--fail-on', 'detector_veto', '--dataset', 'release-gate']);
    expect(code, stderr).toBe(1);
    const receipts = lines(stdout);
    expect(receipts).toHaveLength(3);
    // The leak in the gate: tripped, by no_pii, with the span of the key — offsets and label only.
    expect(receipts[0]).toMatchObject({ gated: true, tripped: 'detector_veto' });
    expect((receipts[0].verdict as { by: string[] }).by).toContain('no_pii');
    const spans = receipts[0].spans as Array<{ rule: string; label: string; source: string; start: number; end: number }>;
    expect(spans.length).toBeGreaterThan(0);
    const key = spans.find((s) => s.rule === 'no_pii');
    expect(key).toBeDefined();
    expect(key?.source).toBe('output');
    expect(LEAK.output.slice(key!.start, key!.end)).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(receipts[0])).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // The clean case in the gate: gated, not tripped, no spans.
    expect(receipts[1]).toMatchObject({ gated: true });
    expect(receipts[1]).not.toHaveProperty('tripped');
    expect(receipts[1]).not.toHaveProperty('spans');
    // The same leak outside the gate: stored and evaluated, ungated, so it cannot fail the job.
    expect(receipts[2]).toMatchObject({ gated: false });
    expect(receipts[2]).not.toHaveProperty('tripped');
    expect(stderr).toMatch(/3 stored, 1 tripped --fail-on detector_veto \(2 of 3 evaluated in dataset "release-gate"\)/);
  }, 60_000);

  it('spansOf keeps only the tripping rules’ span evidence and only its offsets', () => {
    const spans = spansOf(
      [
        { ruleName: 'no_pii', evidence: [{ type: 'span', source: 'output', start: 41, end: 61, label: 'AWS Access Key', text: 'AKIA…' }, { type: 'note', detail: 'x' }] },
        { ruleName: 'non_empty_output', evidence: [{ type: 'span', source: 'output', start: 0, end: 5, label: 'first words' }] },
      ],
      ['no_pii'],
    );
    expect(spans).toEqual([{ rule: 'no_pii', label: 'AWS Access Key', source: 'output', start: 41, end: 61 }]);
  });
});
