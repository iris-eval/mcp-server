/*
 * The judge enable workflow is stated once (src/judge-enablement.json) and
 * every surface carries that statement: the runtime constant, the
 * truthbase, the rendered skill files, and the two hand-maintained prose
 * surfaces (README, docs/llm-as-judge.md) — which must contain the
 * rendered block verbatim, so an edit in one place and not the other
 * fails here instead of drifting.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import enable from '../src/judge-enablement.json' with { type: 'json' };
import { JUDGE_DEFAULT_COST_CAP_USD, JUDGE_ENABLE_STEPS, JUDGE_ENABLE_TITLE, JUDGE_KEY_VARS, judgeEnableBlock, renderJudgeEnableBlock } from '../src/judge-enablement.js';

const root = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');
const claims = JSON.parse(read('.claims.json')) as { llmJudgeTemplates: { enable: { title: string; steps: string[] } } };

describe('the judge enable workflow — one source, every surface', () => {
  it('the runtime constants are the JSON', () => {
    expect(JUDGE_ENABLE_TITLE).toBe(enable.title);
    expect([...JUDGE_ENABLE_STEPS]).toEqual(enable.steps);
    expect(enable.steps.length).toBeGreaterThanOrEqual(4);
  });

  it('the steps state the facts the code enforces: both variables, the restart, the cost cap default, never proxied', () => {
    const all = enable.steps.join(' ');
    expect(all).toContain(JUDGE_KEY_VARS.anthropic);
    expect(all).toMatch(/Restart the MCP session/);
    expect(all).toContain(`(default ${JUDGE_DEFAULT_COST_CAP_USD} USD)`);
    expect(all).toMatch(/never proxies/);
    expect(all).toContain('iris://capabilities');
    expect(all).toContain('--self-test');
    expect(all).toContain('/api/v1/health');
  });

  it('the truthbase carries the same block', () => {
    expect(claims.llmJudgeTemplates.enable).toEqual({ title: enable.title, steps: enable.steps });
    expect(renderJudgeEnableBlock(claims.llmJudgeTemplates.enable.title, claims.llmJudgeTemplates.enable.steps)).toBe(judgeEnableBlock());
  });

  it('the README, the judge doc and both skill files carry the rendered block verbatim', () => {
    const block = judgeEnableBlock();
    for (const rel of ['README.md', 'docs/llm-as-judge.md', 'skills/iris-eval/SKILL.md', 'claude-plugin/skills/agent-eval/SKILL.md']) {
      expect(read(rel), `${rel} does not carry the enable block verbatim`).toContain(block);
    }
  });
});
