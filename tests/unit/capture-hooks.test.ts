/*
 * The capture plugin's three hooks, driven with the payload shapes the
 * hooks reference documents, through the real scripts.
 *
 * DRY_RUN prints what the Stop hook would send and sends nothing; the last
 * case runs the real ingest against the repo's own entry point into a scratch
 * IRIS_HOME and reads the trace back. When the model logs the same turn
 * itself, the hook keeps its own record and names the model's trace: the
 * model's account of a turn can leave out the call that failed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
  ])('keeps its own record of a turn the model also logged through %s, and names the model\'s trace', async (_label, toolName) => {
    await hook('prompt', prompt);
    await hook('tool', read);
    const traceId = 'a'.repeat(32);
    await hook('tool', { ...read, tool_name: toolName, tool_input: { agent_name: 'x', output: 'y' }, tool_response: JSON.stringify({ trace_id: traceId, evaluation: { passed: true } }), tool_use_id: 'toolu_3' });
    const built = JSON.parse((await hook('stop', stop, DRY)).stdout) as { trace: { tool_calls: Array<{ tool_name: string }>; metadata: { model_logged?: { calls: number; trace_ids: string[] } } } };
    expect(built.trace.tool_calls.map((c) => c.tool_name)).toEqual(['Read']);
    expect(built.trace.metadata.model_logged).toEqual({ calls: 1, trace_ids: [traceId] });
  }, 30_000);

  it('records a call that failed, with the error the agent received, and an aborted one as interrupted', async () => {
    await hook('prompt', prompt);
    await hook('tool', { session_id: SID, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_9', error: 'Exit code 1\n 3 failed | 12 passed', is_interrupt: false, duration_ms: 4187 });
    await hook('tool', { session_id: SID, hook_event_name: 'PostToolUseFailure', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' }, tool_use_id: 'toolu_10', error: 'request aborted', is_interrupt: true });
    const built = JSON.parse((await hook('stop', { ...stop, last_assistant_message: 'All tests pass.' }, DRY)).stdout) as { trace: { tool_calls: Array<{ tool_name: string; error?: string; latency_ms?: number; call_id?: string; output?: unknown }> } };
    const [bash, fetch] = built.trace.tool_calls;
    expect(bash).toMatchObject({ tool_name: 'Bash', call_id: 'toolu_9', latency_ms: 4187, error: 'Exit code 1\n 3 failed | 12 passed' });
    expect(bash.output).toBeUndefined();
    expect(fetch.error).toBe('interrupted: request aborted');
  }, 30_000);

  it('records a turn that ended in an API error, with the error', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    const built = JSON.parse((await hook('stop', { session_id: SID, cwd: '/w', hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' }, DRY)).stdout) as { trace: { output: string; tool_calls: unknown[]; metadata: { stop_failure?: { error: string } } } };
    expect(built.trace.output).toBe('API Error: Rate limit reached');
    expect(built.trace.metadata.stop_failure).toEqual({ error: 'rate_limit' });
    expect(built.trace.tool_calls).toHaveLength(1);
  }, 30_000);

  it('always sends the tool calls, so a turn with none says none were made', async () => {
    await hook('prompt', prompt);
    const built = JSON.parse((await hook('stop', stop, DRY)).stdout) as { trace: { tool_calls?: unknown[] } };
    expect(built.trace.tool_calls).toEqual([]);
  }, 30_000);

  it('loses no call when the host runs several at once', async () => {
    await hook('prompt', prompt);
    const ids = Array.from({ length: 8 }, (_, i) => `toolu_p${i}`);
    await Promise.all(ids.map((id, i) => hook('tool', { ...read, tool_input: { file_path: `f${i}.ts` }, tool_use_id: id })));
    const built = JSON.parse((await hook('stop', stop, DRY)).stdout) as { trace: { tool_calls: Array<{ call_id: string }> } };
    expect(built.trace.tool_calls.map((c) => c.call_id).sort()).toEqual([...ids].sort());
    expect(existsSync(join(data, 'sessions', `${SID}.calls.jsonl`)), 'the calls file is cleared after Stop').toBe(false);
  }, 60_000);

  it('without a host data directory, keeps its files in the Iris home, not a shared temporary directory', async () => {
    await hook('prompt', prompt, { CLAUDE_PLUGIN_DATA: '' });
    expect(existsSync(join(home, 'capture', 'sessions', `${SID}.json`))).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('makes its directories and files readable by their owner only', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    const mode = (p: string): number => statSync(p).mode & 0o777;
    expect(mode(data)).toBe(0o700);
    expect(mode(join(data, 'sessions'))).toBe(0o700);
    expect(mode(join(data, 'sessions', `${SID}.json`))).toBe(0o600);
    expect(mode(join(data, 'sessions', `${SID}.calls.jsonl`))).toBe(0o600);
  }, 30_000);

  it('removes a turn that could not be ingested once it is older than the pending limit, and keeps a recent one', async () => {
    const pending = join(data, 'pending');
    mkdirSync(pending, { recursive: true });
    const old = join(pending, 'old.json');
    const recent = join(pending, 'recent.json');
    writeFileSync(old, '{}');
    writeFileSync(recent, '{}');
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    expect((await hook('stop', { session_id: 'nothing', hook_event_name: 'Stop' })).code).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  }, 30_000);

  it('runs the version it pins, from the cache first and then by installing it', async () => {
    const { candidates } = (await import(pathToFileURL(join(hooks, 'ingest-runner.mjs')).href)) as { candidates: (file: string) => Array<{ cmd: string; args: string[] }> };
    const manifest = JSON.parse(readFileSync(resolve(root, 'claude-plugin-capture', '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string };
    const saved = process.env.IRIS_CAPTURE_INGEST_ARGV;
    delete process.env.IRIS_CAPTURE_INGEST_ARGV;
    try {
      const list = candidates('payload.json');
      expect(list).toHaveLength(2);
      for (const c of list) expect(c.args).toContain(`@iris-eval/mcp-server@${manifest.version}`);
      expect(list[0].args[0]).toBe('--no-install');
    } finally {
      if (saved !== undefined) process.env.IRIS_CAPTURE_INGEST_ARGV = saved;
    }
  });

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
