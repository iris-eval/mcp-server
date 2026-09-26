/*
 * `iris-eval ingest --evaluate` builds its own engine, so it installs the
 * relevance judge the way the server does (#649): with
 * IRIS_RELEVANCE_JUDGE_MODEL and a key, an off-topic trace trips
 * `--fail-on policy_gate` on answers_the_ask; without the model it makes no
 * provider call. Only the provider call is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const callLLMJudge = vi.fn();
vi.mock('../../src/eval/llm-judge/client.js', () => ({
  callLLMJudge: (...args: unknown[]) => callLLMJudge(...args) as unknown,
  estimateInputTokens: () => 100,
  LLMJudgeError: class extends Error {
    kind = 'server_error';
    retryable = false;
  },
}));

const { runIngest } = await import('../../src/cli/ingest.js');

const OFF_TOPIC = {
  agent_name: 'bot',
  input: 'Summarize the latest quarterly report for the board meeting',
  output: 'The weather in San Francisco is 62 degrees with partly cloudy skies. Traffic on the Bay Bridge is moderate, with a 25-minute crossing time.',
};

function sink(): { stream: Writable; text: () => string } {
  let out = '';
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    }),
    text: () => out,
  };
}

const ENV = ['IRIS_HOME', 'IRIS_DB_PATH', 'IRIS_RELEVANCE_JUDGE_MODEL', 'IRIS_ANTHROPIC_API_KEY'] as const;

describe('iris-eval ingest with the relevance judge', () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  let home: string;
  beforeEach(() => {
    callLLMJudge.mockReset();
    home = mkdtempSync(join(tmpdir(), 'iris-ingest-judge-'));
    process.env.IRIS_HOME = home;
    process.env.IRIS_DB_PATH = join(home, 'iris.db');
    process.env.IRIS_ANTHROPIC_API_KEY = 'sk-ant-dummy-key-for-tests-0123456789';
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  const ingest = async () => {
    const out = sink();
    const err = sink();
    const code = await runIngest({ cliArgs: {}, evaluate: true, failOn: 'policy_gate', source: 'cli', stdin: Readable.from([JSON.stringify(OFF_TOPIC) + '\n']), stdout: out.stream, stderr: err.stream });
    return { code, stdout: out.text(), stderr: err.text() };
  };

  it('with the model named, the judge is asked and an off-topic trace trips --fail-on policy_gate', async () => {
    process.env.IRIS_RELEVANCE_JUDGE_MODEL = 'claude-haiku-4-5';
    callLLMJudge.mockResolvedValueOnce({ content: '{"score":0.02,"rationale":"a weather bulletin","dimensions":{}}', inputTokens: 900, outputTokens: 60, latencyMs: 1, rawProviderResponseId: 'r' });
    const r = await ingest();
    expect(callLLMJudge).toHaveBeenCalledTimes(1);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toMatch(/answers_the_ask/);
  });

  it('with a key alone, no provider call, and the lexical reading does not trip the gate', async () => {
    delete process.env.IRIS_RELEVANCE_JUDGE_MODEL;
    const r = await ingest();
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect(r.code, r.stderr).toBe(0);
  });
});
