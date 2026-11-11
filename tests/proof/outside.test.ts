import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { contextOfRun, type AgentDojoRun } from '../../proof/lib/agentdojo.js';
import { OUTSIDE_DIR, OUTSIDE_RESULTS_JSON, historyFor, loadOutsideManifest, loadOutsideRuns, rateOf, renderOutsideMarkdown, type CaseHistoryRow, type OutsideResults, type Rate } from '../../proof/lib/outside.js';
import { CASE_HISTORY_WINDOW } from '../../src/eval/case-history.js';
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

/*
 * The case-history rules are read three times, against three choices of a
 * run's earlier runs. What is held: which runs each choice takes, and that
 * the committed numbers of the three readings are about the same runs.
 */
describe('a run against the other runs of its task, three ways', () => {
  const other = (path: string, set: 'attacked' | 'benign', attackSucceeded: boolean | null) => ({ path, set, attackSucceeded });
  const task = [other('a', 'benign', null), other('b', 'attacked', true), other('c', 'attacked', false), other('d', 'benign', null), other('e', 'attacked', true)];

  it('every other run, only the ones with no attack in them, or only the ones where no attack succeeded: never the run itself', () => {
    const self = task[0];
    expect(historyFor('all', self, task).map((r) => r.path)).toEqual(['b', 'c', 'd', 'e']);
    expect(historyFor('no_attack', self, task).map((r) => r.path)).toEqual(['d']);
    expect(historyFor('no_attack_succeeded', self, task).map((r) => r.path)).toEqual(['c', 'd']);
    // A run where the attack succeeded is read against the clean runs too, and is never among them.
    expect(historyFor('no_attack', task[1], task).map((r) => r.path)).toEqual(['a', 'd']);
    expect(historyFor('no_attack_succeeded', task[1], task).map((r) => r.path)).toEqual(['a', 'c', 'd']);
  });

  it('reads at most the window, in the sample\'s order', () => {
    const many = Array.from({ length: CASE_HISTORY_WINDOW + 10 }, (_, i) => other(`r${i}`, 'benign', null));
    const read = historyFor('no_attack', many[0], many);
    expect(read).toHaveLength(CASE_HISTORY_WINDOW);
    expect(read[0].path).toBe('r1');
  });

  it('the committed readings count the same runs: one group size in all three, and a fire only on a run the rule judged', () => {
    const results = JSON.parse(readFileSync(join(root, OUTSIDE_RESULTS_JSON), 'utf-8')) as {
      caseHistory: { rows: CaseHistoryRow[]; clean: { readings: Array<{ history: string; rows: CaseHistoryRow[] }> } };
    };
    const groups = ['attackSucceeded', 'attackFailed', 'noAttack', 'taskNotDone', 'taskDone'] as const;
    expect(results.caseHistory.clean.readings.map((r) => r.history)).toEqual(['no_attack', 'no_attack_succeeded']);
    for (const reading of [{ history: 'all', rows: results.caseHistory.rows }, ...results.caseHistory.clean.readings]) {
      expect(reading.rows.map((r) => `${r.rule} ${r.half}`)).toEqual(results.caseHistory.rows.map((r) => `${r.rule} ${r.half}`));
      for (const row of reading.rows) {
        const full = results.caseHistory.rows.find((r) => r.rule === row.rule && r.half === row.half)!;
        for (const g of groups) {
          const where = `${reading.history} ${row.rule} ${row.half} ${g}`;
          expect(row[g].n, where).toBe(full[g].n);
          expect(row.judged[g].k, where).toBe(row[g].k);
          expect(row.judged[g].n, where).toBeLessThanOrEqual(row[g].n);
        }
      }
    }
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

/*
 * A percentage printed beside `k of n` is the fraction rounded once. The
 * stored `rate` is round4(k / n); printing it rounds a second time and can
 * move the last digit (41 of 71: stored 0.5775 printed 57.8%, one rounding
 * of 41/71 prints 57.7%). Every rate in the committed results must render
 * beside its own counts, from the counts.
 */
describe('a percentage beside k of n is the fraction rounded once', () => {
  const results = JSON.parse(readFileSync(join(root, OUTSIDE_RESULTS_JSON), 'utf-8')) as OutsideResults;
  const markdown = renderOutsideMarkdown(results);

  const rates: Rate[] = [];
  const collect = (o: unknown): void => {
    if (Array.isArray(o)) return o.forEach(collect);
    if (o && typeof o === 'object') {
      const candidate = o as Partial<Rate>;
      if (typeof candidate.k === 'number' && typeof candidate.n === 'number' && 'rate' in candidate) {
        rates.push(candidate as Rate);
        return;
      }
      Object.values(o).forEach(collect);
    }
  };
  collect(results);

  // Every percentage the report actually prints beside a count, keyed by the counts.
  const printedPairs = new Map<string, string>();
  for (const [, k, n, shown] of markdown.matchAll(/(\d+) of (\d+) · \*{0,2}(\d+\.\d)%/g)) {
    printedPairs.set(`${k} of ${n}`, shown);
  }

  it('every rate in the committed results that renders beside k of n prints the fraction rounded once', () => {
    expect(rates.length).toBeGreaterThan(0);
    for (const r of rates) {
      if (r.n === 0 || r.rate === null) continue;
      // Some stored groups are not printed in any table today (the unjudged
      // groups of the clean-history readings); a rate that does not render
      // has no printed digit to hold.
      const shown = printedPairs.get(`${r.k} of ${r.n}`);
      if (shown === undefined) continue;
      const once = (Math.round((r.k / r.n) * 1000) / 10).toFixed(1);
      expect(shown, `${r.k} of ${r.n} prints ${once}`).toBe(once);
    }
  });

  it('no percentage beside a count anywhere in the report is double-rounded', () => {
    expect(printedPairs.size).toBeGreaterThan(0);
    for (const [counts, shown] of printedPairs) {
      const [k, n] = counts.split(' of ').map(Number);
      const once = (Math.round((k / n) * 1000) / 10).toFixed(1);
      expect(shown, counts).toBe(once);
    }
  });

  it('the twice-rounded cells: 41 of 71 prints 57.7, not 57.8', () => {
    expect(markdown).toContain('41 of 71 · 57.7%');
    expect(markdown).not.toContain('41 of 71 · 57.8%');
  });
});
