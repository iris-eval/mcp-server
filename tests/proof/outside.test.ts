import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { contextOfRun, type AgentDojoRun } from '../../proof/lib/agentdojo.js';
import { OUTSIDE_DIR, OUTSIDE_RESULTS_JSON, loadOutsideManifest, loadOutsideRuns, rateOf } from '../../proof/lib/outside.js';
import { wilson } from '../../src/eval/stats.js';
import { ATTACK, COMMIT, SEED, splitOf } from '../../proof/tools/sample-agentdojo.mjs';

/*
 * The outside line (proof/OUTSIDE.md) scores Iris on AgentDojo's published
 * runs. These tests hold the three things a reader has to be able to trust
 * without re-running it: that a run is read the way a capture integration
 * would send it, that the files are the ones AgentDojo published, and that
 * the rates count a task once.
 */

const root = resolve(__dirname, '..', '..');

const run = (messages: AgentDojoRun['messages']): AgentDojoRun => ({
  suite_name: 'banking',
  pipeline_name: 'test',
  user_task_id: 'user_task_0',
  injection_task_id: null,
  attack_type: null,
  utility: true,
  security: true,
  messages,
});

describe('an AgentDojo run, read as a trace', () => {
  it('takes the user message as input, pairs each call with its output by id, and the last message as output', () => {
    const ctx = contextOfRun(
      run([
        { role: 'system', content: 'You are an assistant.' },
        { role: 'user', content: 'Pay the bill.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { function: 'read_file', args: { file_path: 'bill.txt' }, id: 'a' },
            { function: 'get_iban', args: {}, id: 'b' },
          ],
        },
        // Answered out of order: the id decides, not the position.
        { role: 'tool', content: 'DE89', tool_call: { function: 'get_iban', args: {}, id: 'b' } },
        { role: 'tool', content: 'Bill: 98.70', tool_call: { function: 'read_file', args: {}, id: 'a' } },
        { role: 'assistant', content: 'Paid.' },
      ]),
    );
    expect(ctx.input).toBe('Pay the bill.');
    expect(ctx.output).toBe('Paid.');
    expect(ctx.toolCalls).toEqual([
      { tool_name: 'read_file', input: { file_path: 'bill.txt' }, call_id: 'a', output: 'Bill: 98.70' },
      { tool_name: 'get_iban', input: {}, call_id: 'b', output: 'DE89' },
    ]);
    expect(ctx.recordedBy).toBe('harness');
    expect(ctx.capture).toEqual({ name: 'agentdojo-run-log', complete: ['input', 'tool_calls', 'tool_outputs'] });
  });

  it('pairs in order when the log carries no ids, reads content blocks, and keeps a tool error', () => {
    const ctx = contextOfRun(
      run([
        { role: 'user', content: [{ type: 'text', content: 'Find the hotel.' }] },
        { role: 'assistant', content: null, tool_calls: [{ function: 'search', args: { q: 'hotel' } }, { function: 'rate', args: {} }] },
        { role: 'tool', content: [{ type: 'text', content: 'Le Marais' }], tool_call: { function: 'search' } },
        { role: 'tool', content: '', error: 'ValueError: no hotel', tool_call: { function: 'rate' } },
        { role: 'assistant', content: [{ type: 'text', content: 'Le Marais it is.' }] },
      ]),
    );
    expect(ctx.input).toBe('Find the hotel.');
    expect(ctx.output).toBe('Le Marais it is.');
    expect(ctx.toolCalls?.map((c) => [c.tool_name, c.output, c.error])).toEqual([
      ['search', 'Le Marais', undefined],
      ['rate', '', 'ValueError: no hotel'],
    ]);
  });

  it('an agent whose last message is a call answers nothing', () => {
    const ctx = contextOfRun(run([{ role: 'user', content: 'Go.' }, { role: 'assistant', content: null, tool_calls: [{ function: 'x', args: {}, id: '1' }] }]));
    expect(ctx.output).toBe('');
  });
});

describe('the committed sample is the one AgentDojo published', () => {
  const manifest = loadOutsideManifest(root);

  it('every file matches the git blob hash the upstream tree lists for it', () => {
    expect(() => loadOutsideRuns(root, manifest)).not.toThrow();
    expect(manifest.runs.length).toBe(700);
  });

  it('a changed byte is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-outside-'));
    try {
      const entry = manifest.runs[0];
      const bytes = readFileSync(join(root, OUTSIDE_DIR, entry.path), 'utf-8');
      const copy = join(dir, OUTSIDE_DIR, entry.path);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, bytes.replace('"utility": ', '"utility":  '));
      expect(() => loadOutsideRuns(dir, { ...manifest, runs: [entry] })).toThrow(/not the one AgentDojo published/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('was drawn by the sampler at its pinned commit and seed, and its halves are the seed\'s', () => {
    expect(manifest.source.commit).toBe(COMMIT);
    expect(manifest.sampling.seed).toBe(SEED);
    expect(manifest.sampling.attack).toBe(ATTACK);
    for (const r of manifest.runs) {
      const [, , suite, userTask, attack] = r.path.split('/');
      expect(attack).toBe(r.set === 'attacked' ? ATTACK : 'none');
      expect(r.split, r.path).toBe(splitOf(suite, userTask));
    }
  });

  it('the committed results count the sample the manifest holds', () => {
    const results = JSON.parse(readFileSync(join(root, OUTSIDE_RESULTS_JSON), 'utf-8')) as { sample: { runs: number; attackSucceeded: number; attackFailed: number; noAttack: number } };
    const attacked = manifest.runs.filter((r) => r.set === 'attacked');
    expect(results.sample).toMatchObject({
      runs: manifest.runs.length,
      attackSucceeded: attacked.filter((r) => r.attackSucceeded === true).length,
      attackFailed: attacked.filter((r) => r.attackSucceeded === false).length,
      noAttack: manifest.runs.filter((r) => r.set === 'benign').length,
    });
  });
});

describe('a rate counts runs, and counts each task once', () => {
  it('over runs it is k of n with Wilson; over tasks each task is one observation at its own rate', () => {
    // Task a: 3 runs, all hit. Task b: 1 run, missed. Over runs 3 of 4; over tasks (1 + 0) / 2.
    const r = rateOf([
      { task: 'a', hit: true },
      { task: 'a', hit: true },
      { task: 'a', hit: true },
      { task: 'b', hit: false },
    ]);
    expect(r).toMatchObject({ k: 3, n: 4, rate: 0.75, tasks: 2, rateTasks: 0.5 });
    const w = wilson(3, 4)!;
    expect(r.ci95).toEqual([Math.round(w.lo * 10_000) / 10_000, Math.round(w.hi * 10_000) / 10_000]);
  });

  it('none hit still has an upper bound over tasks, never a zero-width interval', () => {
    const r = rateOf(Array.from({ length: 40 }, (_, i) => ({ task: `t${i % 8}`, hit: false })));
    expect(r.rate).toBe(0);
    expect(r.ci95Tasks?.[0]).toBe(0);
    // Eight tasks earn a wider bound than forty runs would.
    expect(r.ci95Tasks?.[1]).toBeGreaterThan(r.ci95?.[1] ?? 1);
  });
});
