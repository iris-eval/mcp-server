/*
 * The capture plugin's hooks, driven with the payload shapes Claude Code's
 * hooks reference documents, through the real scripts.
 *
 * DRY_RUN prints what a hook would send and sends nothing; the last cases run
 * the real ingest against the repo's own entry point into a scratch IRIS_HOME
 * and read the traces back.
 *
 * A turn is keyed on its prompt's id. The cases below are the ways a turn
 * keyed on the session lost calls or misreported them: an interrupt (no
 * Stop), a background sub-agent's calls after its turn ended, a Stop hook
 * that keeps the turn going, a turn that ended in an API error.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, statSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
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

interface Built {
  trace: {
    input?: string;
    output: string;
    run: string;
    tool_calls?: Array<{ tool_name: string; call_id?: string; output?: unknown; error?: string; latency_ms?: number; truncated?: boolean }>;
    metadata: {
      turn: { prompt_id?: string; part: number; ended: string };
      model_logged?: { calls: number; trace_ids: string[]; failed?: number };
      stop_failure?: { error: string };
      subagent_calls?: Array<{ call_id?: string; tool_name: string; agent_id: string; agent_type?: string }>;
    };
  };
  evaluate: boolean;
}

const SID = 'sess-1';
const P1 = '550e8400-e29b-41d4-a716-446655440001';
const P2 = '550e8400-e29b-41d4-a716-446655440002';
const prompt = { session_id: SID, prompt_id: P1, cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'Read package.json and tell me the version.' };
const read = { session_id: SID, prompt_id: P1, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'package.json' }, tool_response: '{"version":"0.12.1"}', tool_use_id: 'toolu_1' };
const grep = { session_id: SID, prompt_id: P1, hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'version' }, tool_response: 'package.json:3', tool_use_id: 'toolu_2' };
const failedTest = { session_id: SID, prompt_id: P1, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_9', error: 'Exit code 1\n 3 failed | 12 passed', is_interrupt: false, duration_ms: 4187 };
const stop = { session_id: SID, prompt_id: P1, cwd: '/w', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'The version is 0.12.1, read from package.json.', background_tasks: [] };
const DRY = { IRIS_CAPTURE_DRY_RUN: '1' };
const built = (stdout: string): Built => JSON.parse(stdout) as Built;

describe('iris-eval-capture hooks: one turn', () => {
  it('assembles the turn: the prompt, the calls with call ids, the final answer, the session as the run, the prompt id', async () => {
    expect((await hook('prompt', prompt)).code).toBe(0);
    expect((await hook('tool', read)).code).toBe(0);
    expect((await hook('tool', grep)).code).toBe(0);
    const out = await hook('stop', stop, DRY);
    expect(out.code).toBe(0);
    const b = built(out.stdout);
    expect(b.evaluate).toBe(true);
    expect(b.trace.input).toBe(prompt.prompt);
    expect(b.trace.output).toBe(stop.last_assistant_message);
    expect(b.trace.run).toBe(SID);
    expect(b.trace.metadata.turn).toEqual({ prompt_id: P1, part: 1, ended: 'answered' });
    expect(b.trace.tool_calls!.map((c) => c.tool_name)).toEqual(['Read', 'Grep']);
    expect(b.trace.tool_calls![0]).toMatchObject({ call_id: 'toolu_1', output: '{"version":"0.12.1"}' });
  }, 30_000);

  it('the hooks never print (a Stop hook\'s stdout becomes model context)', async () => {
    expect((await hook('prompt', prompt)).stdout).toBe('');
    expect((await hook('tool', read)).stdout).toBe('');
  }, 30_000);

  it('records a call that failed, with the error the agent received, and an aborted one as interrupted', async () => {
    await hook('prompt', prompt);
    await hook('tool', failedTest);
    await hook('tool', { ...read, hook_event_name: 'PostToolUseFailure', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' }, tool_use_id: 'toolu_10', error: 'request aborted', is_interrupt: true });
    const b = built((await hook('stop', { ...stop, last_assistant_message: 'All tests pass.' }, DRY)).stdout);
    const [bash, fetch] = b.trace.tool_calls!;
    expect(bash).toMatchObject({ tool_name: 'Bash', call_id: 'toolu_9', latency_ms: 4187, error: 'Exit code 1\n 3 failed | 12 passed' });
    expect(bash.output).toBeUndefined();
    expect(fetch.error).toBe('interrupted: request aborted');
  }, 30_000);

  it('sends an empty list of calls only when the record is whole: the prompt seen, the turn stopped, nothing running in the background', async () => {
    await hook('prompt', prompt);
    expect(built((await hook('stop', stop, DRY)).stdout).trace.tool_calls).toEqual([]);
    for (const [label, over] of [
      ['a background task still running', { background_tasks: [{ id: 't1', type: 'subagent', status: 'running' }] }],
      ['a host that does not say', { background_tasks: undefined }],
    ] as const) {
      rmSync(join(data, 'sessions'), { recursive: true, force: true });
      await hook('prompt', prompt);
      expect(built((await hook('stop', { ...stop, ...over }, DRY)).stdout).trace.tool_calls, label).toBeUndefined();
    }
    // And with no prompt seen (a resumed session): no list.
    rmSync(join(data, 'sessions'), { recursive: true, force: true });
    const resumed = built((await hook('stop', stop, DRY)).stdout);
    expect(resumed.trace.input).toBeUndefined();
    expect(resumed.trace.tool_calls).toBeUndefined();
  }, 60_000);

  it('loses no call when the host runs several at once', async () => {
    await hook('prompt', prompt);
    const ids = Array.from({ length: 8 }, (_, i) => `toolu_p${i}`);
    await Promise.all(ids.map((id, i) => hook('tool', { ...read, tool_input: { file_path: `f${i}.ts` }, tool_use_id: id })));
    const b = built((await hook('stop', stop, DRY)).stdout);
    expect(b.trace.tool_calls!.map((c) => c.call_id).sort()).toEqual([...ids].sort());
  }, 60_000);

  it('a call written half way loses only itself, not the call after it', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    // A hook killed mid-write: half a record, no newline.
    const dir = join(data, 'sessions', SID);
    const calls = readdirSync(dir).find((n) => n.endsWith('.calls.jsonl'))!;
    appendFileSync(join(dir, calls), '{"tool_name":"Edit","inp');
    await hook('tool', failedTest);
    const b = built((await hook('stop', stop, DRY)).stdout);
    expect(b.trace.tool_calls!.map((c) => c.tool_name)).toEqual(['Read', 'Bash']);
  }, 30_000);

  it('keeps a very large output as its head and its tail, marked truncated', async () => {
    await hook('prompt', prompt);
    const big = 'BEGIN ' + 'x'.repeat(2_000_000) + ' 3 failed | 12 passed END';
    await hook('tool', { ...read, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: big });
    const call = built((await hook('stop', stop, DRY)).stdout).trace.tool_calls![0];
    expect(call.truncated).toBe(true);
    const out = call.output as string;
    expect(out.length).toBeLessThan(300_000);
    expect(out.startsWith('BEGIN ')).toBe(true);
    expect(out.endsWith('3 failed | 12 passed END')).toBe(true);
    expect(out).toMatch(/characters left out by the capture plugin/);
  }, 60_000);

  it('filters Iris\'s own other tools out of the trajectory and keeps the rest', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    await hook('tool', { ...grep, tool_name: 'mcp__iris-eval__get_traces', tool_input: { limit: 5 }, tool_use_id: 'toolu_4' });
    expect(built((await hook('stop', stop, DRY)).stdout).trace.tool_calls!.map((c) => c.tool_name)).toEqual(['Read']);
  }, 30_000);

  it('a Stop with nothing at all is skipped', async () => {
    const empty = JSON.parse((await hook('stop', { session_id: 'empty', prompt_id: P2, hook_event_name: 'Stop' }, DRY)).stdout) as { skipped?: string };
    expect(empty.skipped).toBe('nothing to record');
  }, 30_000);
});

describe('iris-eval-capture hooks: the model logged the turn too', () => {
  it.each([
    ['a user-configured server', 'mcp__iris-eval__log_trace'],
    ['the name an earlier installer wrote', 'mcp__iris__log_trace'],
    ['the plugin-bundled server', 'mcp__plugin_iris-eval_iris-eval__log_trace'],
  ])('keeps its own record of a turn the model logged through %s, and names the model\'s trace once', async (_label, toolName) => {
    await hook('prompt', prompt);
    await hook('tool', read);
    const traceId = 'a'.repeat(32);
    // log_trace with evaluate: the result names the trace twice, at the top and inside the evaluation.
    const result = JSON.stringify({ trace_id: traceId, status: 'stored', evaluation: { trace_id: traceId, passed: true } });
    await hook('tool', { ...read, tool_name: toolName, tool_input: { agent_name: 'x', output: 'y' }, tool_response: result, tool_use_id: 'toolu_3' });
    const b = built((await hook('stop', stop, DRY)).stdout);
    expect(b.trace.tool_calls!.map((c) => c.tool_name)).toEqual(['Read']);
    expect(b.trace.metadata.model_logged).toEqual({ calls: 1, trace_ids: [traceId] });
  }, 30_000);

  it('a log_trace call that failed is not counted as the model having logged the turn', async () => {
    await hook('prompt', prompt);
    await hook('tool', { ...read, hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__iris-eval__log_trace', tool_input: { agent_name: 'x', output: 'y' }, tool_use_id: 'toolu_5', error: 'IRIS_VALIDATION_ERROR' });
    expect(built((await hook('stop', stop, DRY)).stdout).trace.metadata.model_logged).toEqual({ calls: 0, trace_ids: [], failed: 1 });
  }, 30_000);
});

describe('iris-eval-capture hooks: turns that do not end cleanly', () => {
  it('an interrupted turn (no Stop) is sent when the next prompt arrives, its calls kept, not judged', async () => {
    await hook('prompt', prompt);
    await hook('tool', { ...read, tool_name: 'Bash', tool_input: { command: 'rm -rf build/' }, tool_response: '' });
    await hook('tool', failedTest);
    // The user pressed Esc: no Stop. The next prompt:
    const out = await hook('prompt', { ...prompt, prompt_id: P2, prompt: 'Did the migration run?' }, DRY);
    const parts = JSON.parse(out.stdout) as Built[];
    expect(parts).toHaveLength(1);
    expect(parts[0].evaluate).toBe(false);
    expect(parts[0].trace.input).toBe(prompt.prompt);
    expect(parts[0].trace.output).toBe('');
    expect(parts[0].trace.metadata.turn).toEqual({ prompt_id: P1, part: 1, ended: 'unfinished' });
    expect(parts[0].trace.tool_calls!.map((c) => c.tool_name)).toEqual(['Bash', 'Bash']);
    // And the new turn starts with none of them.
    const next = built((await hook('stop', { ...stop, prompt_id: P2, last_assistant_message: 'Yes.' }, DRY)).stdout);
    expect(next.trace.input).toBe('Did the migration run?');
    expect(next.trace.tool_calls).toEqual([]);
  }, 60_000);

  it('a background sub-agent\'s calls after its turn ended are sent as a later part of that turn, naming the sub-agent', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    built((await hook('stop', { ...stop, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] }, DRY)).stdout);
    // The sub-agent keeps working under the turn's prompt, then reports back, which Claude Code delivers as a prompt.
    await hook('tool', { ...failedTest, agent_id: 'agent-7', agent_type: 'test-runner' });
    const parts = JSON.parse((await hook('prompt', { ...prompt, prompt_id: P2, prompt: 'The background agent finished: tests run.' }, DRY)).stdout) as Built[];
    expect(parts).toHaveLength(1);
    expect(parts[0].trace.metadata.turn).toEqual({ prompt_id: P1, part: 2, ended: 'unfinished' });
    expect(parts[0].trace.tool_calls!.map((c) => c.call_id)).toEqual(['toolu_9']);
    expect(parts[0].trace.tool_calls![0]).not.toHaveProperty('agent');
    expect(parts[0].trace.metadata.subagent_calls).toEqual([{ call_id: 'toolu_9', tool_name: 'Bash', agent_id: 'agent-7', agent_type: 'test-runner' }]);
  }, 60_000);

  it('a turn a Stop hook keeps going ends twice: the second end sends the calls since the first, with the prompt, as part 2', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    const first = built((await hook('stop', stop, DRY)).stdout);
    expect(first.trace.metadata.turn.part).toBe(1);
    await hook('tool', failedTest);
    const second = built((await hook('stop', { ...stop, stop_hook_active: true, last_assistant_message: 'All tests pass now.' }, DRY)).stdout);
    expect(second.evaluate).toBe(true);
    expect(second.trace.input).toBe(prompt.prompt);
    expect(second.trace.output).toBe('All tests pass now.');
    expect(second.trace.metadata.turn).toEqual({ prompt_id: P1, part: 2, ended: 'continued' });
    expect(second.trace.tool_calls!.map((c) => c.call_id)).toEqual(['toolu_9']);
  }, 60_000);

  it('a turn that ended in an API error is stored with the error and its calls, with no answer, and is not judged', async () => {
    await hook('prompt', prompt);
    await hook('tool', failedTest);
    const b = built((await hook('stop', { session_id: SID, prompt_id: P1, cwd: '/w', hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429', last_assistant_message: 'API Error: Rate limit reached' }, DRY)).stdout);
    expect(b.evaluate).toBe(false);
    expect(b.trace.output).toBe('');
    expect(b.trace.metadata.stop_failure).toEqual({ error: 'rate_limit', details: '429' });
    expect(b.trace.metadata.turn.ended).toBe('failed');
    expect(b.trace.tool_calls!.map((c) => c.call_id)).toEqual(['toolu_9']);
  }, 30_000);

  it('a host too old to send prompt ids still keys calls on the turn its last prompt began', async () => {
    const strip = <T extends Record<string, unknown>>(p: T): Partial<T> => {
      const rest: Partial<T> = { ...p };
      delete rest.prompt_id;
      return rest;
    };
    await hook('prompt', strip(prompt));
    await hook('tool', strip(read));
    await hook('prompt', strip({ ...prompt, prompt: 'Second.' }), DRY);
    await hook('tool', strip(grep));
    const b = built((await hook('stop', strip(stop), DRY)).stdout);
    expect(b.trace.input).toBe('Second.');
    expect(b.trace.tool_calls!.map((c) => c.tool_name)).toEqual(['Grep']);
  }, 60_000);
});

describe('iris-eval-capture hooks: what it keeps, and for how long', () => {
  it('without a host data directory, keeps its files in the Iris home, not a shared temporary directory', async () => {
    await hook('prompt', prompt, { CLAUDE_PLUGIN_DATA: '' });
    expect(readdirSync(join(home, 'capture', 'sessions', SID)).some((n) => n.endsWith('.turn.json'))).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('makes its directories and files readable by their owner only', async () => {
    await hook('prompt', prompt);
    await hook('tool', read);
    const mode = (p: string): number => statSync(p).mode & 0o777;
    const dir = join(data, 'sessions', SID);
    expect(mode(join(data, 'sessions'))).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
    for (const name of readdirSync(dir)) expect(mode(join(dir, name)), name).toBe(0o600);
  }, 30_000);

  it('closes a session untouched for a day: sends what it did not, then removes its files; a recent one is left alone', async () => {
    await hook('prompt', { ...prompt, session_id: 'old' });
    await hook('tool', { ...read, session_id: 'old' });
    await hook('prompt', { ...prompt, session_id: 'recent' });
    await hook('tool', { ...read, session_id: 'recent' });
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    const oldDir = join(data, 'sessions', 'old');
    for (const n of readdirSync(oldDir)) utimesSync(join(oldDir, n), twoDaysAgo, twoDaysAgo);
    utimesSync(oldDir, twoDaysAgo, twoDaysAgo);
    // A file an earlier version of the plugin left, one per session.
    const legacy = join(data, 'sessions', 'legacy.calls.jsonl');
    writeFileSync(legacy, '{"tool_name":"Read"}\n');
    utimesSync(legacy, twoDaysAgo, twoDaysAgo);
    const parts = JSON.parse((await hook('prompt', { ...prompt, session_id: 'third', prompt_id: P2 }, DRY)).stdout) as Built[];
    expect(parts.map((p) => p.trace.run)).toEqual(['old']);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(data, 'sessions', 'recent'))).toBe(true);
  }, 60_000);

  it('removes a failed turn once it is older than the pending limit, and keeps a recent one', async () => {
    const pending = join(data, 'pending');
    mkdirSync(pending, { recursive: true });
    const old = join(pending, 'old.json');
    const recent = join(pending, 'recent.json');
    writeFileSync(old, '{}');
    writeFileSync(recent, '{}');
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    expect((await hook('stop', { session_id: 'nothing', prompt_id: P2, hook_event_name: 'Stop' })).code).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  }, 30_000);

  it('rotates its log past a megabyte, keeping one previous file', async () => {
    const logPath = join(data, 'capture.log');
    mkdirSync(data, { recursive: true });
    writeFileSync(logPath, 'x'.repeat(1_100_000));
    await hook('stop', { session_id: 'nothing', prompt_id: P2, hook_event_name: 'Stop' });
    expect(statSync(logPath).size).toBeLessThan(10_000);
    expect(statSync(`${logPath}.1`).size).toBe(1_100_000);
  }, 30_000);
});

describe('iris-eval-capture ingest runner', () => {
  it('runs the version it pins, from the cache first and then by installing it; a part not to be judged is stored without --evaluate', async () => {
    const { candidates } = (await import(pathToFileURL(join(hooks, 'ingest-runner.mjs')).href)) as { candidates: (file: string, evaluate?: boolean) => Array<{ cmd: string; args: string[] }> };
    const manifest = JSON.parse(readFileSync(resolve(root, 'claude-plugin-capture', '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string };
    const saved = process.env.IRIS_CAPTURE_INGEST_ARGV;
    delete process.env.IRIS_CAPTURE_INGEST_ARGV;
    try {
      const list = candidates('payload.json');
      expect(list).toHaveLength(2);
      for (const c of list) {
        expect(c.args).toContain(`@iris-eval/mcp-server@${manifest.version}`);
        expect(c.args).toContain('--evaluate');
      }
      expect(list[0].args[0]).toBe('--no-install');
      for (const c of candidates('payload.noeval.json', false)) expect(c.args).not.toContain('--evaluate');
    } finally {
      if (saved !== undefined) process.env.IRIS_CAPTURE_INGEST_ARGV = saved;
    }
  });

  it('end to end: stores the turn with source hook and a verdict, retries a failed one, and stores an API-error turn without one', async () => {
    const ingest = JSON.stringify([process.execPath, '--import', 'tsx', resolve(root, 'src', 'index.ts')]);
    const env = { IRIS_CAPTURE_INGEST_ARGV: ingest, IRIS_CAPTURE_WAIT: '1' };
    // A turn whose ingest failed earlier, left in pending/ old enough to retry.
    const pending = join(data, 'pending');
    mkdirSync(pending, { recursive: true });
    const earlier = join(pending, 'earlier.json');
    writeFileSync(earlier, JSON.stringify({ agent_name: 'claude-code', framework: 'claude-code', input: 'Earlier ask.', output: 'Earlier answer.', run: 'earlier-session', metadata: { captured_by: 'iris-eval-capture' } }));
    const anHourAgo = (Date.now() - 3_600_000) / 1000;
    utimesSync(earlier, anHourAgo, anHourAgo);

    await hook('prompt', prompt);
    await hook('tool', read);
    const out = await hook('stop', { ...stop, last_assistant_message: 'The version is 0.12.1. Reporter SSN 123-45-6789 was in the file too.' }, env);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('');
    await hook('prompt', { ...prompt, prompt_id: P2 }, env);
    await hook('tool', { ...failedTest, prompt_id: P2 });
    await hook('stop', { session_id: SID, prompt_id: P2, cwd: '/w', hook_event_name: 'StopFailure', error: 'overloaded', last_assistant_message: 'API Error: Overloaded' }, env);
    const logPath = join(data, 'capture.log');
    if (existsSync(logPath)) expect(readFileSync(logPath, 'utf8')).not.toContain('ingest failed');
    expect(existsSync(earlier), 'the retried turn left pending/').toBe(false);

    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    const traces = (await storage.queryTraces(LOCAL_TENANT, { limit: 10 })).traces;
    expect(traces.map((t) => t.run_id).sort()).toEqual(['earlier-session', SID, SID].sort());
    const answered = traces.find((t) => t.run_id === SID && t.output !== '')!;
    expect(answered.source).toBe('hook');
    expect(answered.tool_calls?.map((c) => c.tool_name)).toEqual(['Read']);
    // The trace keeps the record; the stored EVALUATION text is what --redact critical_spans rewrites.
    expect(answered.output).toContain('123-45-6789');
    const evals = await storage.getEvalsByTraceId(LOCAL_TENANT, answered.trace_id);
    expect(evals).toHaveLength(1);
    expect(evals[0].verdict?.basis).toBe('detector_veto');
    expect(evals[0].output_text).not.toContain('123-45-6789');
    // The API-error turn: stored with its failed call, and no verdict about an answer it never gave.
    const failedTurn = traces.find((t) => t.run_id === SID && t.output === '')!;
    expect(failedTurn.tool_calls?.map((c) => c.error)).toEqual([failedTest.error]);
    expect((failedTurn.metadata as { stop_failure?: { error: string } }).stop_failure?.error).toBe('overloaded');
    expect(await storage.getEvalsByTraceId(LOCAL_TENANT, failedTurn.trace_id)).toHaveLength(0);
    await storage.close();
  }, 180_000);
});
