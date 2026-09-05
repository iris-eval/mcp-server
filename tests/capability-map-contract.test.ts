/*
 * The public capability map is drift-locked to the release it ships in.
 *
 * Every `has` / `partial` cell names evidence, and every evidence name
 * resolves to a registered rule, tool, resource, route, proof row or judge
 * template; every registered rule, tool, template and resource appears in
 * at least one such cell (a capability nobody can find on the map is a
 * documentation gap); the sixty ids are the ten questions by the six
 * subjects; every map question maps to the questions registry; no cell
 * names a private path or a review lens id; and for every cell's `needs`,
 * the real engine skips the cell's rules when the named input is absent —
 * `has` must never read as "judged this" when the input lacked what the
 * cell needs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import map from '../capability-map.json' with { type: 'json' };
import { rulesByType } from '../src/eval/rules/index.js';
import { QUESTIONS } from '../src/eval/questions.js';
import { publishedRuleNames } from '../src/eval/accuracy.js';
import { TOOL_NAMES } from '../src/tools/index.js';
import { RESOURCE_URIS } from '../src/resources/uris.js';
import { EvalEngine } from '../src/eval/engine.js';
import { defaultConfig } from '../src/config/defaults.js';
import type { Need } from '../src/types/eval.js';

const root = resolve(__dirname, '..');
const claims = JSON.parse(readFileSync(join(root, '.claims.json'), 'utf8')) as {
  llmJudgeTemplates: { names: string[] };
  capabilityMap: { cells: unknown[]; counts: Record<string, number>; total: number };
};

type Cell = (typeof map.cells)[number];
const cells: Cell[] = map.cells;
const answering = cells.filter((c) => c.status === 'has' || c.status === 'partial');

const RULES = new Set(Object.values(rulesByType).flat().map((r) => r.name));
const RULE_BY_NAME = new Map(Object.values(rulesByType).flat().map((r) => [r.name, r]));
const TEMPLATES = new Set(claims.llmJudgeTemplates.names);
const TOOLS = new Set<string>(TOOL_NAMES);
const RESOURCES = new Set<string>(RESOURCE_URIS);
const PROOF = new Set(publishedRuleNames());

function registeredRoutes(): Set<string> {
  const routes = new Set<string>();
  const dir = join(root, 'src', 'dashboard', 'routes');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/router\.(?:get|post|patch|put|delete)\(\s*'([^']+)'/g)) routes.add(`/api/v1${m[1]}`);
  }
  return routes;
}
const ROUTES = registeredRoutes();

/** Tools that answer no evaluation question: they manage the store, not the verdict. */
const LIFECYCLE_TOOLS = new Set(['delete_trace', 'delete_rule']);

describe('capability map — shape', () => {
  it('sixty cells: ten questions by six subjects, ids in the Q{n}xS{m} form, one of four statuses', () => {
    expect(map.questions.length).toBe(10);
    expect(map.subjects.length).toBe(6);
    expect(cells.length).toBe(60);
    const ids = new Set(cells.map((c) => c.id));
    for (const q of map.questions) for (const s of map.subjects) expect(ids.has(`${q.id}x${s.id}`), `${q.id}x${s.id}`).toBe(true);
    for (const c of cells) {
      expect(['has', 'partial', 'gap', 'n/a'], c.id).toContain(c.status);
      expect(c.summary.length, c.id).toBeGreaterThan(20);
      expect(c.question, c.id).toBe(c.id.split('x')[0]);
      expect(c.subject, c.id).toBe(c.id.split('x')[1]);
    }
  });

  it('every map question maps to the questions registry', () => {
    const registry = new Set(QUESTIONS.map((q) => q.id));
    for (const q of map.questions) expect(registry.has(q.registryId), q.id).toBe(true);
  });

  it('the truthbase carries the map verbatim with its counts', () => {
    expect(claims.capabilityMap.cells).toEqual(cells);
    expect(claims.capabilityMap.total).toBe(60);
    const counts: Record<string, number> = { has: 0, partial: 0, gap: 0, 'n/a': 0 };
    for (const c of cells) counts[c.status] += 1;
    expect(claims.capabilityMap.counts).toEqual(counts);
  });

  it('no cell names a private path or a review lens id', () => {
    for (const c of cells) {
      const text = `${c.summary} ${JSON.stringify(c.evidence)}`;
      expect(text, c.id).not.toMatch(/\bL\d-\d\d\b/);
      expect(text, c.id).not.toMatch(/strategy\/|sandbox\/|consulting\/|systems\//);
      expect(text, c.id).not.toMatch(/\bsrc\/[a-z]/);
    }
  });
});

describe('capability map — evidence', () => {
  it('every has or partial cell names at least one piece of evidence, and every name resolves', () => {
    for (const c of answering) {
      expect(c.evidence.length, `${c.id} (${c.status}) names no evidence`).toBeGreaterThan(0);
      for (const e of c.evidence) {
        const ok =
          (e.kind === 'rule' && RULES.has(e.name)) ||
          (e.kind === 'tool' && TOOLS.has(e.name)) ||
          (e.kind === 'resource' && RESOURCES.has(e.name)) ||
          (e.kind === 'route' && ROUTES.has(e.name)) ||
          (e.kind === 'proof' && PROOF.has(e.name)) ||
          (e.kind === 'template' && TEMPLATES.has(e.name));
        expect(ok, `${c.id}: ${e.kind} "${e.name}" is not registered`).toBe(true);
      }
    }
    for (const c of cells.filter((c) => c.status === 'gap' || c.status === 'n/a')) {
      expect(c.evidence, `${c.id} (${c.status}) must name no evidence`).toEqual([]);
    }
  });

  it('every registered rule, evaluating tool, judge template and resource appears in a has or partial cell', () => {
    const seen = { rule: new Set<string>(), tool: new Set<string>(), template: new Set<string>(), resource: new Set<string>() };
    for (const c of answering) for (const e of c.evidence) if (e.kind in seen) seen[e.kind as keyof typeof seen].add(e.name);
    expect([...RULES].filter((r) => !seen.rule.has(r))).toEqual([]);
    expect([...TOOLS].filter((t) => !LIFECYCLE_TOOLS.has(t) && !seen.tool.has(t))).toEqual([]);
    expect([...TEMPLATES].filter((t) => !seen.template.has(t))).toEqual([]);
    expect([...RESOURCES].filter((r) => !seen.resource.has(r))).toEqual([]);
  });
});

describe('capability map — needs are real', () => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds);
  const FULL = {
    output: 'The retention sweep runs at boot and deletes traces older than the configured window. Nothing else changes.',
    input: 'Explain what the retention sweep does and when it runs.',
    expected: 'retention sweep boot window',
    toolCalls: [{ tool_name: 'grep', input: 'sweep', output: 'retention.ts: sweep()' }],
    costUsd: 0.01,
    tokenUsage: { prompt_tokens: 100, completion_tokens: 20 },
  };
  const NEED_TO_CONTEXT: Record<string, keyof typeof FULL> = { input: 'input', expected: 'expected', tool_calls: 'toolCalls', cost: 'costUsd', tokens: 'tokenUsage' };

  it('for every cell need beyond output, each cited rule that declares that need skips when the engine is called without it', async () => {
    let checked = 0;
    for (const c of answering) {
      const rules = c.evidence.filter((e) => e.kind === 'rule').map((e) => RULE_BY_NAME.get(e.name)!);
      for (const need of c.needs.filter((n) => n !== 'output')) {
        const ctxKey = NEED_TO_CONTEXT[need];
        expect(ctxKey, `${c.id}: need "${need}" is not an input the engine takes`).toBeDefined();
        const without = { ...FULL } as Record<string, unknown>;
        delete without[ctxKey];
        const result = await engine.evaluateAll(without as typeof FULL);
        for (const rule of rules.filter((r) => (r.needs as readonly Need[]).includes(need as Need))) {
          const row = result.rule_results.find((x) => x.ruleName === rule.name);
          // Either the rule skipped, or it ran on less and its `saw` says it
          // never had the input — a result must never claim an input it lacked.
          const honest = row?.skipped === true || (Array.isArray(row?.saw) && !row!.saw!.includes(need as Need));
          expect(honest, `${c.id}: ${rule.name} ran without ${need} and did not say so`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('a cell whose needs name an input the cited rules never read is mis-cut', () => {
    for (const c of answering) {
      const rules = c.evidence.filter((e) => e.kind === 'rule').map((e) => RULE_BY_NAME.get(e.name)!);
      if (rules.length === 0) continue;
      const declared = new Set(rules.flatMap((r) => [...r.needs]));
      for (const need of c.needs) expect(declared.has(need as Need), `${c.id}: no cited rule reads "${need}"`).toBe(true);
    }
  });
});
