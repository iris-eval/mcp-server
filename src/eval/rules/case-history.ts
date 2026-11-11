/*
 * The case-history rules: a run read against the earlier runs of its own
 * case by the same agent (src/eval/case-history.ts says how, and why the
 * lines sit where they do).
 *
 *   no_unusual_action   the run called a tool that may act, and no earlier
 *                       run in the window called it;
 *   no_dropped_step     the run never called a tool every earlier run in
 *                       the window called.
 *
 * They are tool_sequence with nobody writing the expectation: its superset
 * and subset modes, read from what the case has already done. That is why
 * they sit in the same bundle.
 *
 * Both are MEASUREMENTS. A departure from how a case has gone is not a
 * fault by itself: the case may have changed, or its earlier runs may have
 * been wrong together. So at the shipped configuration they report and
 * decide no verdict, and what a fire is worth is measured on runs somebody
 * else labelled (proof/OUTSIDE.md) and published whatever it is.
 *
 * The baseline arrives on the context (`caseHistory`, newest first) from
 * the store, supplied by the same doors that supply `costHistory`. A call
 * with no stored trace behind it has none and the rules say so; they never
 * invent one.
 */
import { MAX_EVIDENCE_ITEMS, type EvalContext, type EvalRule, type EvalRuleResult, type Evidence } from '../../types/eval.js';
import { CASE_HISTORY_MIN, CASE_HISTORY_WINDOW, caseHistoryOf, droppedSteps, hasNoUsualWay, listNames, toolNameOf, toolsOfSteps, unusualActions } from '../case-history.js';
import { stepScopeNote, stepStatsOf, stepsOf, trajectoryAbsence } from '../steps.js';
import { skipWithoutTrajectory } from './trajectory.js';

const runs = (n: number): string => `${n} earlier run${n === 1 ? '' : 's'}`;

/** The skip a case-history rule gives when it has too little to read against, saying which way. */
function skipForHistory(ruleName: string, context: EvalContext): EvalRuleResult {
  const history = caseHistoryOf(context);
  if (history === undefined) {
    return {
      ruleName,
      passed: false,
      score: 0,
      message: 'Not judged: this call has no stored case behind it, so there are no earlier runs to read it against',
      skipped: true,
      skipReason: 'insufficient_history: no stored case (evaluate a stored trace that has a case_key or an input, by its trace_id)',
    };
  }
  const m = history.filter((r) => r.tools !== null).length;
  return {
    ruleName,
    passed: false,
    score: 0,
    message: `Not judged: ${runs(m)} of this case by this agent with recorded tool calls, ${CASE_HISTORY_MIN} needed before a run can be read against them`,
    skipped: true,
    skipReason: `insufficient_history: ${runs(m)} of this case by this agent with recorded tool calls, ${CASE_HISTORY_MIN} needed`,
  };
}

function skipUnreadable(ruleName: string): EvalRuleResult {
  return {
    ruleName,
    passed: false,
    score: 0,
    message: 'Not judged: the tools this run called cannot be listed whole (a call with no name, or too many distinct tools)',
    skipped: true,
    skipReason: 'unreadable_trajectory: a call with no name, or too many distinct tools to list',
  };
}

export const noUnusualAction: EvalRule = {
  name: 'no_unusual_action',
  description:
    `A run against the same agent's earlier runs of its own case: fails when the run called a tool that may act and none of the case's ${CASE_HISTORY_WINDOW} most recent earlier runs called it. A tool the catalogue marks read-only, or whose name holds a word that reads (get, list, search, …) and none that acts (send, delete, update, …), is a look-up: named in the message and never counted. A measurement: at the shipped configuration it reports and decides no verdict. Skips without tool calls; as insufficient_history below ${CASE_HISTORY_MIN} earlier runs with recorded calls, which is every call with no stored trace behind it; and when more than half of the earlier runs each took an action none of the others took, because that case has no usual way of going`,
  evalType: 'completeness',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['tool_calls'],
  question: 'tool_use_correct',
  classes: ['wrong_trajectory'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const skip = skipWithoutTrajectory('no_unusual_action', context);
    if (skip) return skip;
    const steps = stepsOf(context);
    const called = toolsOfSteps(steps);
    if (called === null) return skipUnreadable('no_unusual_action');
    const reading = unusualActions(called, context.tools, caseHistoryOf(context) ?? []);
    if (reading === null) return skipForHistory('no_unusual_action', context);
    const { m, unusual, unusualLookups } = reading;
    if (hasNoUsualWay(reading)) {
      return {
        ruleName: 'no_unusual_action',
        passed: false,
        score: 0,
        message: `Not judged: ${reading.departing} of the ${runs(m)} of this case each took an action none of the others took, so the case has no usual way of going to read this run against`,
        skipped: true,
        skipReason: `no_usual_way: ${reading.departing} of the ${runs(m)} of this case each took an action none of the others took`,
      };
    }
    const scope = stepScopeNote(context);
    const lookups =
      unusualLookups.length === 0
        ? ''
        : `; ${unusualLookups.length === 1 ? 'a look-up' : `${unusualLookups.length} look-ups`} none of them made (${listNames(unusualLookups)}) ${unusualLookups.length === 1 ? 'is' : 'are'} noted and not counted`;
    const evidence: Evidence[] = [{ type: 'count', stat: 'unusual_actions', unit: 'tools', value: unusual.length, threshold: 0, thresholdSource: 'rule' }];
    const flagged = new Set(unusual);
    for (const step of steps) {
      const name = toolNameOf(step.name);
      if (!flagged.has(name)) continue;
      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
      evidence.push({ type: 'toolCall', index: step.index, toolName: name, label: `called in none of the ${runs(m)} of this case` });
    }
    const passed = unusual.length === 0;
    return {
      ruleName: 'no_unusual_action',
      passed,
      score: passed ? 1 : Math.max(0, 1 - unusual.length * 0.25),
      value: { stat: 'unusual_actions', unit: 'tools', value: unusual.length },
      evidence,
      message: passed
        ? `No unusual action: every tool this run called that may act was called in the ${runs(m)} of its case${lookups}${scope}`
        : `Unusual action for this case: ${listNames(unusual)}, called in none of its ${runs(m)}${lookups}${scope}`,
    };
  },
};

export const noDroppedStep: EvalRule = {
  name: 'no_dropped_step',
  description:
    `A run against the same agent's earlier runs of its own case: fails when the run never called a tool that every one of the case's ${CASE_HISTORY_WINDOW} most recent earlier runs called, look-ups included. An explicit empty list of tool calls is judged as no calls made. A measurement: at the shipped configuration it reports and decides no verdict. Skips when no tool calls were sent at all, or more than the trajectory rules read; as insufficient_history below ${CASE_HISTORY_MIN} earlier runs with recorded calls, which is every call with no stored trace behind it; and when no tool was called by every earlier run, because there is nothing to hold this run to`,
  evalType: 'completeness',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['tool_calls'],
  question: 'tool_use_correct',
  classes: ['wrong_trajectory'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    // An explicit empty list is a run that made no call, and against steps the case always takes that is the finding. Calls not sent at all still skip.
    const skip = skipWithoutTrajectory('no_dropped_step', context);
    if (skip && trajectoryAbsence(context) !== 'empty_calls') return skip;
    const stats = stepStatsOf(context);
    if (stats.kept < stats.available) {
      // A step taken only among the calls that were not read would be reported as dropped.
      return {
        ruleName: 'no_dropped_step',
        passed: false,
        score: 0,
        message: `Not judged: the first ${stats.kept} of this run's ${stats.available} calls were read, and a step may be among the rest`,
        skipped: true,
        skipReason: `partial_trajectory: ${stats.kept} of ${stats.available} calls read`,
      };
    }
    const called = toolsOfSteps(stepsOf(context));
    if (called === null) return skipUnreadable('no_dropped_step');
    const reading = droppedSteps(new Set(called), caseHistoryOf(context) ?? []);
    if (reading === null) return skipForHistory('no_dropped_step', context);
    const { m, dropped, usual } = reading;
    if (usual === 0) {
      return {
        ruleName: 'no_dropped_step',
        passed: false,
        score: 0,
        message: `Not judged: no tool was called by every one of the ${runs(m)} of this case, so there is nothing to hold this run to`,
        skipped: true,
        skipReason: `no_usual_step: no tool was called by every one of the ${runs(m)} of this case`,
      };
    }
    const scope = stepScopeNote(context);
    const evidence: Evidence[] = [
      { type: 'count', stat: 'dropped_steps', unit: 'tools', value: dropped.length, threshold: 0, thresholdSource: 'rule' },
      ...dropped.slice(0, MAX_EVIDENCE_ITEMS - 1).map((name): Evidence => ({ type: 'pattern', name: `dropped_step:${name}`, count: m })),
    ];
    const passed = dropped.length === 0;
    return {
      ruleName: 'no_dropped_step',
      passed,
      score: passed ? 1 : Math.max(0, 1 - dropped.length / usual),
      value: { stat: 'dropped_steps', unit: 'tools', value: dropped.length },
      evidence,
      message: passed
        ? `No dropped step: this run called ${usual === 1 ? 'the one tool' : `each of the ${usual} tools`} that every one of the ${runs(m)} of its case called${scope}`
        : `Dropped step for this case: ${listNames(dropped)}, called in every one of its ${runs(m)} and not in this one${scope}`,
    };
  },
};

/** The two, in the order the bundle lists them. */
export const caseHistoryRules: EvalRule[] = [noUnusualAction, noDroppedStep];
