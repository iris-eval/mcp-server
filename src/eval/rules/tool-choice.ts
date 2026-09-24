/*
 * tool_choice: the wrong tool for the ask, judged from the
 * catalogue valid_tool_arguments already takes.
 *
 * The formula, stated so a reader can check a fire by hand:
 *   terms(ask)   = the ask's content terms (src/eval/terms.ts — the relevance
 *                  tokenizer: stopwords out, identifiers split, stems folded).
 *   terms(tool)  = the content terms of the tool's name (split on _ - .), its
 *                  description and its input property names.
 *   actionable   = terms(ask) ∩ the union of every tool's terms — the words of
 *                  the ask the catalogue can speak to at all. "Search the web
 *                  for the latest OpenTelemetry release notes" has one
 *                  actionable pair (search, web); the subject words are the
 *                  agent's business, not the catalogue's, and count for and
 *                  against no tool.
 *   fit(T)       = |actionable ∩ terms(T)| / |actionable|, for a tool or for
 *                  the UNION of the tools the agent called.
 *   fires when   the best tool the agent did NOT call has fit ≥ min_fit
 *                (0.5) and beats the union of the called tools by ≥ margin
 *                (0.34): an available tool plainly describes the ask, and
 *                what was called covers much less of it.
 * Judged at the trajectory level, not per call, so a multi-step task whose
 * tools each serve one part of the ask is not marked wrong for the parts
 * the other tools served. Lexical, no model: a tool whose description does
 * not mention the ask's vocabulary is invisible to it, and an ask with fewer
 * than two content terms is not judged. A detection with a heuristic behind
 * it, so it degrades the score and never vetoes.
 */
import { MAX_EVIDENCE_ITEMS, type EvalContext, type EvalRule, type EvalRuleResult, type Evidence } from '../../types/eval.js';
import type { ToolDescriptor } from '../../types/trace.js';
import { catalogueIndex } from '../catalogue.js';
import { stepScopeNote, stepsOf } from '../steps.js';
import { contentTerms } from '../terms.js';
import { skipWithoutTrajectory } from './trajectory.js';

export const DEFAULT_TOOL_CHOICE_MARGIN = 0.34;
export const DEFAULT_TOOL_CHOICE_MIN_FIT = 0.5;
export const MIN_ASK_TERMS = 2;

/** The ask's terms that some tool in the catalogue mentions — the only ones a choice can be judged on. */
export function actionableTerms(ask: ReadonlySet<string>, tools: Iterable<ToolDescriptor>): Set<string> {
  const spoken = new Set<string>();
  for (const tool of tools) for (const t of toolTerms(tool)) spoken.add(t);
  return new Set([...ask].filter((t) => spoken.has(t)));
}

/** The vocabulary a tool advertises: its name's words, its description, the names of its input properties. */
export function toolTerms(tool: ToolDescriptor): Set<string> {
  const props = tool.inputSchema && typeof tool.inputSchema === 'object' && (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
  const propNames = props && typeof props === 'object' ? Object.keys(props).join(' ') : '';
  return new Set(contentTerms(`${tool.name.replace(/[_\-.]+/g, ' ')} ${tool.description ?? ''} ${propNames.replace(/[_\-.]+/g, ' ')}`));
}

/** |ask ∩ terms| / |ask|. */
export function fitOf(ask: ReadonlySet<string>, terms: ReadonlySet<string>): number {
  if (ask.size === 0) return 0;
  let hit = 0;
  for (const t of ask) if (terms.has(t)) hit += 1;
  return hit / ask.size;
}

export const toolChoice: EvalRule = {
  name: 'tool_choice',
  description:
    "The right tool for the ask, from the catalogue: fit(T) is the share of the ask's ACTIONABLE terms — the content terms some tool's name, description or input property names mention — found in T's; the ask's other words (its subject) count for and against no tool. Fails when the best tool the agent did NOT call fits at least tool_choice_min_fit (0.5) and beats the union of the tools it DID call by at least tool_choice_margin (0.34), naming both tools and both fits. Judged over the whole trajectory, so several tools that each serve part of the ask are not wrong for the parts the others served. Lexical: a description that never mentions the ask's words cannot be chosen. Skips without the input, a trajectory or a catalogue, when the ask has fewer than two content terms, or when no tool mentions any of them",
  evalType: 'relevance',
  weight: 1,
  kind: 'detection',
  mechanism: 'heuristic',
  needs: ['input', 'tool_calls', 'tools_catalogue'],
  question: 'relevant',
  classes: ['wrong_tool'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.input) {
      return { ruleName: 'tool_choice', passed: false, score: 0, message: 'No input provided', skipped: true, skipReason: 'context.input not provided' };
    }
    const skip = skipWithoutTrajectory('tool_choice', context);
    if (skip) return skip;
    const catalogue = catalogueIndex(context);
    if (catalogue === null) {
      return {
        ruleName: 'tool_choice',
        passed: false,
        score: 0,
        skipped: true,
        skipReason: 'context.tools not provided — a choice cannot be judged against a catalogue nobody supplied (pass `tools`, your MCP tools/list result, or a trace_id whose trace carries it)',
        message: 'No tools catalogue provided',
      };
    }
    const ask = new Set(contentTerms(context.input));
    if (ask.size < MIN_ASK_TERMS) {
      return { ruleName: 'tool_choice', passed: false, score: 0, skipped: true, skipReason: `the ask has ${ask.size} content term${ask.size === 1 ? '' : 's'}; ${MIN_ASK_TERMS} are needed to judge a choice`, message: 'Ask too short to judge a tool choice' };
    }
    const actionable = actionableTerms(ask, catalogue.values());
    if (actionable.size === 0) {
      return { ruleName: 'tool_choice', passed: false, score: 0, skipped: true, skipReason: 'no tool in the catalogue mentions any of the ask\'s content terms — there is nothing to choose between', message: 'No tool speaks to the ask' };
    }
    const steps = stepsOf(context);
    const called = new Set(steps.map((s) => s.name));
    const calledTerms = new Set<string>();
    for (const name of called) {
      const tool = catalogue.get(name);
      if (tool) for (const t of toolTerms(tool)) calledTerms.add(t);
    }
    const calledFit = fitOf(actionable, calledTerms);
    let best: { tool: ToolDescriptor; fit: number } | null = null;
    for (const tool of catalogue.values()) {
      if (called.has(tool.name)) continue;
      const fit = fitOf(actionable, toolTerms(tool));
      if (best === null || fit > best.fit || (fit === best.fit && tool.name < best.tool.name)) best = { tool, fit };
    }
    const margin = typeof context.customConfig?.tool_choice_margin === 'number' ? (context.customConfig.tool_choice_margin as number) : DEFAULT_TOOL_CHOICE_MARGIN;
    const minFit = typeof context.customConfig?.tool_choice_min_fit === 'number' ? (context.customConfig.tool_choice_min_fit as number) : DEFAULT_TOOL_CHOICE_MIN_FIT;
    const fired = best !== null && best.fit >= minFit && best.fit - calledFit >= margin;
    const scope = stepScopeNote(context);
    const calledList = [...called].join(', ');
    const evidence: Evidence[] = [
      { type: 'count', stat: 'ask_fit_called_tools', unit: 'ratio', value: calledFit, threshold: best === null ? undefined : Math.max(0, best.fit - margin), thresholdSource: margin === DEFAULT_TOOL_CHOICE_MARGIN ? 'default' : 'config' },
      ...(best !== null ? [{ type: 'count', stat: 'ask_fit_best_uncalled_tool', unit: 'ratio', value: best.fit, threshold: minFit, thresholdSource: minFit === DEFAULT_TOOL_CHOICE_MIN_FIT ? 'default' : 'config' } as Evidence] : []),
      ...(fired ? steps.slice(0, MAX_EVIDENCE_ITEMS - 2).map((s): Evidence => ({ type: 'toolCall', index: s.index, toolName: s.name, label: `called; ${best!.tool.name} fits the ask better` })) : []),
    ];
    return {
      ruleName: 'tool_choice',
      passed: !fired,
      score: fired ? Math.max(0, 1 - (best!.fit - calledFit)) : 1,
      value: { stat: 'ask_fit_called_tools', unit: 'ratio', value: calledFit },
      evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS),
      message: fired
        ? `Wrong tool for the ask: ${best!.tool.name} fits ${(best!.fit * 100).toFixed(0)}% of the ask's actionable terms (${[...actionable].join(', ')}) and was not called; the tools called (${calledList}) fit ${(calledFit * 100).toFixed(0)}% — ${((best!.fit - calledFit) * 100).toFixed(0)} points short of it (margin ${(margin * 100).toFixed(0)})${scope}`
        : best === null
          ? `Every tool in the catalogue was called (${calledList}); nothing better was left to choose${scope}`
          : `The tools called (${calledList}) fit ${(calledFit * 100).toFixed(0)}% of the ask's actionable terms (${[...actionable].join(', ')}); the best uncalled tool, ${best.tool.name}, fits ${(best.fit * 100).toFixed(0)}%${scope}`,
    };
  },
};
