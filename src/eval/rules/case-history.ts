/*
 * The case-history rules: a run read against the earlier runs of its own
 * case (src/eval/case-history.ts says how, and why the lines sit where
 * they do).
 *
 *   no_unusual_action    the run called a tool that may act, and the earlier
 *                        runs all but never called it;
 *   no_dropped_step      the run never called a tool nearly every earlier
 *                        run called;
 *   no_dropped_specific  the answer lacks a figure, a date, an address or an
 *                        identifier nearly every earlier answer carried.
 *
 * They are the expected-trajectory rules and expected_coverage with nobody
 * writing the expectation: tool_sequence's superset and subset modes, and
 * the expected answer's terms, read from what the case has already done.
 * That is why they sit in the same bundle.
 *
 * All three are MEASUREMENTS. A departure from how a case has gone is not
 * a fault by itself: the case may have changed, or its earlier runs may
 * have been wrong together. So they report and never decide the verdict,
 * and what a fire is worth is measured on runs somebody else labelled
 * (proof/OUTSIDE.md) and published whatever it is.
 *
 * The baseline arrives on the context (`caseHistory`, newest first) from
 * the store, supplied by the same doors that supply `costHistory`. A bare
 * evaluate_output call has none and the rules say so; they never invent
 * one.
 */
import { MAX_EVIDENCE_ITEMS, type EvalContext, type EvalRule, type EvalRuleResult, type Evidence } from '../../types/eval.js';
import {
  CASE_HISTORY_MIN,
  CASE_HISTORY_WINDOW,
  caseHistoryOf,
  describeSpecific,
  droppedSpecifics,
  droppedSteps,
  hasNoUsualWay,
  kindOfSpecific,
  ofEarlierRuns,
  toolsOfSteps,
  unusualActions,
} from '../case-history.js';
import { stepScopeNote, stepsOf, trajectoryAbsence } from '../steps.js';
import { skipWithoutTrajectory } from './trajectory.js';

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

function skipForHistory(ruleName: string, m: number, what: string): EvalRuleResult {
  return {
    ruleName,
    passed: false,
    score: 0,
    message: `Not judged: ${m} earlier ${plural(m, 'run')} of this case ${what}, ${CASE_HISTORY_MIN} needed before a run can be read against them`,
    skipped: true,
    skipReason: `insufficient_history: ${m} earlier ${plural(m, 'run')} of this case ${what}, ${CASE_HISTORY_MIN} needed`,
  };
}

export const noUnusualAction: EvalRule = {
  name: 'no_unusual_action',
  description:
    `A run against the earlier runs of its own case: fails when the run called a tool that may act and the earlier runs all but never called it. With k of the m most recent earlier runs (at most ${CASE_HISTORY_WINDOW}) calling a tool, its share is (k + 1) / (m + 2), and a tool at a quarter or less is unusual: no earlier run for m of 3 to 5, at most one for 6 to 9. A tool the catalogue marks read-only, or whose name says it reads (get, list, search, …), is a look-up: named in the message and never counted. A measurement: it reports and never decides the verdict. Skips without tool calls; as insufficient_history below ${CASE_HISTORY_MIN} earlier runs with recorded calls, which is every bare evaluate_output call; and when more than half of the earlier runs each took an action the others never took, because that case has no usual way of going`,
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
    const reading = unusualActions(toolsOfSteps(steps), context.tools, caseHistoryOf(context));
    if (reading === null) {
      return skipForHistory('no_unusual_action', caseHistoryOf(context).filter((r) => r.tools !== null).length, 'with recorded tool calls');
    }
    const { m, unusual, unusualLookups } = reading;
    if (hasNoUsualWay(reading)) {
      return {
        ruleName: 'no_unusual_action',
        passed: false,
        score: 0,
        message: `Not judged: ${reading.departing} of the ${m} earlier runs of this case each took an action the others all but never took, so the case has no usual way of going to read this run against`,
        skipped: true,
        skipReason: `no_usual_way: ${reading.departing} of the ${m} earlier runs of this case each took an action the others all but never took`,
      };
    }
    const scope = stepScopeNote(context);
    const lookups =
      unusualLookups.length === 0
        ? ''
        : `; ${unusualLookups.length} ${plural(unusualLookups.length, 'look-up')} the earlier runs all but never made (${unusualLookups.map((t) => `${t.name}, ${ofEarlierRuns(t.k, m)}`).join('; ')}) ${plural(unusualLookups.length, 'is', 'are')} noted and not counted`;
    const evidence: Evidence[] = [{ type: 'count', stat: 'unusual_actions', unit: 'tools', value: unusual.length, threshold: 0, thresholdSource: 'rule' }];
    const byName = new Map(unusual.map((t) => [t.name, t]));
    for (const step of steps) {
      const share = byName.get(step.name);
      if (share === undefined) continue;
      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
      evidence.push({ type: 'toolCall', index: step.index, toolName: step.name, label: `called in ${ofEarlierRuns(share.k, m)} of this case` });
    }
    const passed = unusual.length === 0;
    return {
      ruleName: 'no_unusual_action',
      passed,
      score: passed ? 1 : Math.max(0, 1 - unusual.length * 0.25),
      value: { stat: 'unusual_actions', unit: 'tools', value: unusual.length },
      evidence,
      message: passed
        ? `No unusual action: every tool this run called that may act was called by the earlier runs of its case (${m} read)${lookups}${scope}`
        : `Unusual action for this case: ${unusual.map((t) => `${t.name}, called in ${ofEarlierRuns(t.k, m)}`).join('; ')}${lookups}${scope}`,
    };
  },
};

export const noDroppedStep: EvalRule = {
  name: 'no_dropped_step',
  description:
    `A run against the earlier runs of its own case: fails when the run never called a tool nearly every earlier run called. With k of the m most recent earlier runs (at most ${CASE_HISTORY_WINDOW}) calling a tool, its share is (k + 1) / (m + 2), and a tool at three quarters or more is a usual step: every earlier run for m of 3 to 5, all but one for 6 to 9. An explicit empty list of tool calls is judged as no calls made. A measurement: it reports and never decides the verdict. Skips when no tool calls were sent at all; as insufficient_history below ${CASE_HISTORY_MIN} earlier runs with recorded calls, which is every bare evaluate_output call; and when the earlier runs share no usual step, because there is nothing to hold this run to`,
  evalType: 'completeness',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['tool_calls'],
  question: 'task_completed',
  classes: ['wrong_trajectory'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    // An explicit empty list is a run that made no call, and against steps the case usually takes that is the finding. Calls not sent at all still skip.
    const skip = skipWithoutTrajectory('no_dropped_step', context);
    if (skip && trajectoryAbsence(context) !== 'empty_calls') return skip;
    const steps = stepsOf(context);
    const reading = droppedSteps(new Set(toolsOfSteps(steps)), caseHistoryOf(context));
    if (reading === null) {
      return skipForHistory('no_dropped_step', caseHistoryOf(context).filter((r) => r.tools !== null).length, 'with recorded tool calls');
    }
    const { m, dropped, usual } = reading;
    if (usual === 0) {
      return {
        ruleName: 'no_dropped_step',
        passed: false,
        score: 0,
        message: `Not judged: the ${m} earlier runs of this case share no usual step, so there is nothing to hold this run to`,
        skipped: true,
        skipReason: `no_usual_step: no tool was called by nearly every one of the ${m} earlier runs of this case`,
      };
    }
    const scope = stepScopeNote(context);
    const evidence: Evidence[] = [
      { type: 'count', stat: 'dropped_steps', unit: 'tools', value: dropped.length, threshold: 0, thresholdSource: 'rule' },
      ...dropped.slice(0, MAX_EVIDENCE_ITEMS - 1).map((d): Evidence => ({ type: 'pattern', name: `dropped_step:${d.name}`, count: d.k })),
    ];
    const passed = dropped.length === 0;
    return {
      ruleName: 'no_dropped_step',
      passed,
      score: passed ? 1 : Math.max(0, 1 - dropped.length / usual),
      value: { stat: 'dropped_steps', unit: 'tools', value: dropped.length },
      evidence,
      message: passed
        ? `No dropped step: this run called ${usual === 1 ? 'the one tool' : `each of the ${usual} tools`} nearly every earlier run of its case called (${m} read)${scope}`
        : `Dropped step for this case: ${dropped.map((d) => `${d.name}, called in ${ofEarlierRuns(d.k, m)}`).join('; ')}, and not in this one${scope}`,
    };
  },
};

export const noDroppedSpecific: EvalRule = {
  name: 'no_dropped_specific',
  description:
    `An answer against the earlier answers to its own case: fails when it lacks a specific nearly every earlier answer carried. A specific is a figure, a date, a time, an email or web address, or an identifier holding a digit, read in one written form (1,050.00 and 1050 are one figure). With k of the m most recent earlier answers (at most ${CASE_HISTORY_WINDOW}) carrying one, its share is (k + 1) / (m + 2), and three quarters or more is usual: every earlier answer for m of 3 to 5, all but one for 6 to 9. A dropped specific is reported by its kind, how many earlier answers carried it and the id of a trace that did; its value is never copied into this result. A measurement: it reports and never decides the verdict. Skips as insufficient_history below ${CASE_HISTORY_MIN} earlier runs with an answer, which is every bare evaluate_output call, and when the earlier answers share no specific`,
  evalType: 'completeness',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['output'],
  question: 'complete',
  classes: ['incomplete_ask'],
  version: 1,
  outputView: 'values',
  evaluate(context: EvalContext): EvalRuleResult {
    const reading = droppedSpecifics(context.output, caseHistoryOf(context));
    if (reading === null) {
      return skipForHistory('no_dropped_specific', caseHistoryOf(context).filter((r) => r.specifics !== null).length, 'with an answer');
    }
    const { m, dropped, usual } = reading;
    if (usual === 0) {
      return {
        ruleName: 'no_dropped_specific',
        passed: false,
        score: 0,
        message: `Not judged: the ${m} earlier answers to this case share no specific, so there is nothing to hold this answer to`,
        skipped: true,
        skipReason: `no_usual_specific: no figure, date, address or identifier was carried by nearly every one of the ${m} earlier answers to this case`,
      };
    }
    const evidence: Evidence[] = [
      { type: 'count', stat: 'dropped_specifics', unit: 'specifics', value: dropped.length, threshold: 0, thresholdSource: 'rule' },
      ...dropped.slice(0, MAX_EVIDENCE_ITEMS - 1).map((d): Evidence => ({ type: 'pattern', name: `dropped_specific:${kindOfSpecific(d.specific).replace(' ', '_')}`, count: d.k })),
    ];
    const passed = dropped.length === 0;
    const shown = dropped.slice(0, 5);
    return {
      ruleName: 'no_dropped_specific',
      passed,
      score: passed ? 1 : Math.max(0, 1 - dropped.length / usual),
      value: { stat: 'dropped_specifics', unit: 'specifics', value: dropped.length },
      evidence,
      message: passed
        ? `No dropped specific: this answer carries ${usual === 1 ? 'the one specific' : `each of the ${usual} specifics`} nearly every earlier answer to its case carried (${m} read)`
        : `Dropped specific for this case: ${shown.map((d) => `${describeSpecific(d.specific)} carried by ${ofEarlierRuns(d.k, m, 'answer')}${d.traceId !== undefined ? ` (trace ${d.traceId} carries it)` : ''}`).join('; ')}${dropped.length > shown.length ? `; and ${dropped.length - shown.length} more` : ''}, and not by this one`,
    };
  },
};

/** The three, in the order the bundle lists them. */
export const caseHistoryRules: EvalRule[] = [noUnusualAction, noDroppedStep, noDroppedSpecific];
