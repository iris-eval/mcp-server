/*
 * The evaluation questions — the vocabulary of coverage.
 *
 * Every built-in rule declares which question it answers (`EvalRule.question`),
 * so a verdict can say which questions were judged, which were not and why,
 * instead of counting rules. The seven rule-answered questions are the rows
 * of the public capability map that a rule can answer; the three
 * capability-level questions are answered by a tool (run comparison) or a
 * surface (the dashboard, the proof page) and are listed so the map and the
 * roster share one registry. A rule that names a question not in this list
 * fails tests/unit/eval/rule-metadata.test.ts.
 */
import type { QuestionId } from '../types/eval.js';

export type CapabilityQuestionId = QuestionId | 'better_or_worse' | 'where_and_why' | 'trusted';

export interface EvaluationQuestion {
  id: CapabilityQuestionId;
  /** The question in a reader's words. */
  text: string;
  /** What answers it: a rule (stamped on results), a tool (arc 5's run comparison) or a surface (dashboard, /proof). */
  answeredBy: 'rule' | 'tool' | 'surface';
}

export const QUESTIONS: readonly EvaluationQuestion[] = [
  { id: 'safe_output', text: 'Is the output safe to show — no leaked personal data or credentials, no injection, nothing the deployment prohibits?', answeredBy: 'rule' },
  { id: 'grounded', text: 'Is the output grounded in what the agent was given or read, rather than invented?', answeredBy: 'rule' },
  { id: 'complete', text: 'Did the agent produce a full answer rather than a stub, a fragment or a promise?', answeredBy: 'rule' },
  { id: 'relevant', text: 'Is the output on task — does it address what was asked?', answeredBy: 'rule' },
  { id: 'task_completed', text: 'Did the task actually complete, as opposed to reading as if it had?', answeredBy: 'rule' },
  { id: 'tool_use_correct', text: 'Did the agent act well — the right tools, valid arguments, no loops, failures acknowledged?', answeredBy: 'rule' },
  { id: 'within_budget', text: 'Did the run cost what the deployment allows, in money and tokens?', answeredBy: 'rule' },
  { id: 'better_or_worse', text: 'Is this agent better or worse than before, with an interval?', answeredBy: 'tool' },
  { id: 'where_and_why', text: 'Where does it fail, and why?', answeredBy: 'surface' },
  { id: 'trusted', text: 'Can this verdict be trusted — how often is each evaluator wrong?', answeredBy: 'surface' },
];

/** The questions a rule may declare. */
export const RULE_QUESTION_IDS: readonly QuestionId[] = QUESTIONS.filter((q) => q.answeredBy === 'rule').map((q) => q.id as QuestionId);
