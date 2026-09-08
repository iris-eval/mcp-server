/*
 * The capture plugin's three hooks, driven with the payload shapes the
 * hooks reference documents, through the real scripts.
 *
 * DRY_RUN prints what the Stop hook would send and sends nothing; the last
 * case runs the real ingest against the repo's own entry point into a scratch
 * IRIS_HOME and reads the trace back. The double-log rule is the one this
 * plugin cannot ship without: with the iris-eval plugin installed the model
 * may log the same turn, and one turn must become one trace.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const root = resolve(__dirname, '..', '..');
const hooks = resolve(root, 'claude-plugin-capture', 'hooks');
let data: string;
let home: string;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'iris-capture-data-'));
  home = mkdtempSync(join(tmpdir(), 'iris-capture-home-'));
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function hook(name: string, payload: unknown, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(hooks, `${name}.mjs`)], {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin!.write(JSON.stringify(payload));
    child.stdin!.end();
  });
}

const SID = 'sess-1';
const prompt = { session_id: SID, cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'Read package.json and tell me the version.' };
const read = { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'package.json' }, tool_response: '{"version":"0.12.1"}', tool_use_id: 'toolu_1' };
const grep = { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'version' }, tool_response: 'package.json:3', tool_use_id: 'toolu_2' };
const stop = { session_id: SID, cwd: '/w', hook_event_name: 'Stop', last_assistant_message: 'The version is 0.12.1, read from package.json.' };
const DRY = { IRIS_CAPTURE_DRY_RUN: '1' };

describe('iris-eval-capture hooks', () => {
  it('assembles the turn: the prompt, both calls with call ids, the final answer, the session as the run', async () => {
    expect((await hook('prompt', prompt)).code).toBe(0);
    expect((await hook('tool', read)).code).toBe(0);
    expect((await hook('tool', grep)).code).toBe(0);
    const out = await hook('stop', stop, DRY);
    expect(out.code).toBe(0);
    const built = JSON.parse(out.stdout) as { trace: Record<string, unknown> };
    expect(built.trace.input).toBe(prompt.prompt);
    expect(built.trace.output).toBe(stop.last_assistant_message);
    expect(built.trace.run).toBe(SID);
    const calls = built.trace.tool_calls as Array<{ tool_name: string; call_id?: string; output?: unknown }>;
    expect(calls.map((c) => c.tool_name)).toEqual(['Read', 'Grep']);
    expect(calls[0].call_id).toBe('toolu_1');
    expect(calls[0].output).toBe('{"version":"0.12.1"}');
    expect(existsSync(join(data, 'sessions', `${SID}.json`)), 'the session file is cleared after Stop').toBe(false);
  }, 30_000);

  it('the prompt, tool and stop hooks never print (a Stop hook\'s stdout becomes model context)', async () => {
    expect((await hook('prompt', prompt)).stdout).toBe('');
    expect((await hook('tool', read)).stdout).toBe('');
  }, 30_000);

  it.each([
    ['a user-configured server', 'mcp__iris-eval__log_trace'],
    ['the plugin-bundled server', 'mcp__plugin_iris-eval_iris-eval__log_trace'],
  ])('skips a turn the model logged itself through %s', async (_label, toolName) => {
    await hook('prompt', prompt);
    await hook('tool', read);
    await hook('tool', { ...read, tool_name: toolName, tool_input: { agent_name: 'x', output: 'y' }, tool_use_id: 'toolu_3' });
    const built = JSON.parse((await hook('stop', stop, DRY)).stdout) as { skipped?: string };
    expect(built.skipped).toContain('the model logged this turn');
  }, 30_000);

  it('filters Iris\'s own other tools out of the trajectory and keeps the rest', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    await hook('tool', { ...grep, tool_name: 'mcp__iris-eval__get_traces', tool_input: { limit: 5 }, tool_use_id: 'toolu_4' });
    const built = JSON.parse((await hook('stop', stop, DRY)).stdout) as { trace: { tool_calls: Array<{ tool_name: string }> } };
    expect(built.trace.tool_calls.map((c) => c.tool_name)).toEqual(['Read']);
  }, 30_000);

  it('a Stop with no prompt captured still records the answer; a Stop with nothing at all is skipped', async () => {
    const withAnswer = JSON.parse((await hook('stop', { ...stop, session_id: 'resumed' }, DRY)).stdout) as { trace?: { input?: string; output?: string } };
    expect(withAnswer.trace?.input).toBeUndefined();
    expect(withAnswer.trace?.output).toBe(stop.last_assistant_message);
    const empty = JSON.parse((await hook('stop', { session_id: 'empty', hook_event_name: 'Stop' }, DRY)).stdout) as { skipped?: string };
    expect(empty.skipped).toBe('nothing to record');
  }, 30_000);

  it('end to end: the real ingest stores the turn with source hook and a verdict, and redacts the stored evaluation text', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    const ingest = JSON.stringify([process.execPath, '--import', 'tsx', resolve(root, 'src', 'index.ts')]);
    const out = await hook('stop', { ...stop, last_assistant_message: 'The version is 0.12.1. Reporter SSN 123-45-6789 was in the file too.' }, { IRIS_CAPTURE_INGEST_ARGV: ingest, IRIS_CAPTURE_WAIT: '1' });
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('');
    const logPath = join(data, 'capture.log');
    if (existsSync(logPath)) expect(readFileSync(logPath, 'utf8')).not.toContain('ingest failed');
    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    const traces = await storage.queryTraces(LOCAL_TENANT, { limit: 5 });
    expect(traces.traces).toHaveLength(1);
    const t = traces.traces[0];
    expect(t.source).toBe('hook');
    expect(t.run_id).toBe(SID);
    expect(t.tool_calls?.map((c) => c.tool_name)).toEqual(['Read']);
    // The trace keeps the record — the adapter's stated non-goal: stripping the
    // text the verdict points at would leave a finding whose subject no longer
    // exists. The stored EVALUATION text is what --redact critical_spans rewrites.
    expect(t.output).toContain('123-45-6789');
    const evals = await storage.getEvalsByTraceId(LOCAL_TENANT, t.trace_id);
    expect(evals).toHaveLength(1);
    expect(evals[0].verdict?.basis).toBe('detector_veto');
    expect(evals[0].output_text, 'the stored evaluation text is redacted on the way in').not.toContain('123-45-6789');
    expect(evals[0].output_text).toContain('[REDACTED:');
    await storage.close();
  }, 120_000);
});
