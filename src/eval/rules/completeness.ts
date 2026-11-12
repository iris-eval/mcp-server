import type { EvalRule, EvalContext, EvalRuleResult, Evidence } from '../../types/eval.js';
import { MAX_EVIDENCE_ITEMS } from '../../types/eval.js';
import { countSentences } from '../text/sentences.js';
import { withoutValueBreaks } from '../text/structured.js';
import { thresholdSourceOf } from '../thresholds.js';
import { MAX_ASK_CHARS, MIN_MEASURABLE_TERMS, answerIndex, coversPart, hitsPart, measurableParts, requiredHits, splitAsk, type AskPart } from '../text/asks.js';
import { catalogueIndex, catalogueMatch } from '../catalogue.js';
import { checkArguments, compileToolSchema, type ArgumentCheck } from '../schema-validator.js';
import { notJudgedPastCeiling, runWasCut, stepScopeNote, stepsOf } from '../steps.js';
import { skipWithoutTrajectory } from './trajectory.js';
import { toolSequence } from './expected-trajectory.js';
import { caseHistoryRules } from './case-history.js';
import { saysSomething } from './says-something.js';

/** The length floor reads min_output_length, then its alias min_length: its provenance is the key that supplied the number. */
function minLengthSource(context: EvalContext): 'default' | 'config' {
  if (context.customConfig?.min_output_length !== undefined) return thresholdSourceOf(context, 'min_output_length');
  if (context.customConfig?.min_length !== undefined) return thresholdSourceOf(context, 'min_length');
  return 'default';
}

export const minOutputLength: EvalRule = {
  name: 'min_output_length',
  description: 'Output must meet a minimum character length',
  evalType: 'completeness',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['output'],
  outputView: 'values',
  question: 'complete',
  classes: ['format'],
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const minLen = (context.customConfig?.min_output_length as number)
      ?? (context.customConfig?.min_length as number)
      ?? 50;
    // In the values reading of a structured output, the breaks the reading put between values are not the answer's length.
    const len = (context.outputRead === 'values' ? withoutValueBreaks(context.output) : context.output).length;
    const passed = len >= minLen;
    return {
      ruleName: 'min_output_length',
      passed,
      score: passed ? 1 : Math.min(len / minLen, 0.99),
      value: { stat: 'length', unit: 'chars', value: len },
      evidence: [{ type: 'count', stat: 'length', unit: 'chars', value: len, threshold: minLen, thresholdSource: minLengthSource(context) }],
      message: passed ? `Output length (${len}) meets minimum (${minLen})` : `Output length (${len}) below minimum (${minLen})`,
    };
  },
};

export const nonEmptyOutput: EvalRule = {
  name: 'non_empty_output',
  description: 'Output must not be empty or whitespace-only',
  evalType: 'completeness',
  weight: 2,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['output'],
  outputView: 'values',
  question: 'complete',
  classes: ['format'],
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const passed = context.output.trim().length > 0;
    return {
      ruleName: 'non_empty_output',
      passed,
      score: passed ? 1 : 0,
      value: { stat: 'length', unit: 'chars', value: context.output.trim().length },
      message: passed ? 'Output is non-empty' : 'Output is empty or whitespace-only',
    };
  },
};

export const sentenceCount: EvalRule = {
  name: 'sentence_count',
  description: 'Output must contain a minimum number of sentences',
  evalType: 'completeness',
  weight: 0.5,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['output'],
  outputView: 'values',
  question: 'complete',
  classes: ['format'],
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const minSentences = (context.customConfig?.min_sentences as number) ?? 2;
    // One splitter, shared with topic_consistency (src/eval/text/sentences.ts).
    // Splitting on /[.!?]+/ counted "The latency is 3.5 seconds." as two
    // sentences and "Dr. Chen approved it." as two more.
    const sentences = countSentences(context.output);
    const passed = sentences >= minSentences;
    return {
      ruleName: 'sentence_count',
      passed,
      score: passed ? 1 : Math.min(sentences / minSentences, 0.99),
      value: { stat: 'sentences', unit: 'sentences', value: sentences },
      evidence: [{ type: 'count', stat: 'sentences', unit: 'sentences', value: sentences, threshold: minSentences, thresholdSource: thresholdSourceOf(context, 'min_sentences') }],
      message: passed ? `Sentence count (${sentences}) meets minimum (${minSentences})` : `Sentence count (${sentences}) below minimum (${minSentences})`,
    };
  },
};

export const expectedCoverage: EvalRule = {
  name: 'expected_coverage',
  description: 'Output must cover key terms from expected output',
  evalType: 'completeness',
  weight: 1.5,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['output', 'expected'],
  outputView: 'values',
  question: 'complete',
  classes: ['incomplete_ask'],
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    if (!context.expected) {
      return { ruleName: 'expected_coverage', passed: false, score: 0, message: 'No expected output provided', skipped: true, skipReason: 'context.expected not provided' };
    }
    const expectedWords = new Set(
      context.expected.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
    );
    const outputWords = new Set(
      context.output.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
    );
    if (expectedWords.size === 0) {
      return { ruleName: 'expected_coverage', passed: true, score: 1, message: 'No meaningful words in expected output' };
    }
    let covered = 0;
    for (const word of expectedWords) {
      if (outputWords.has(word)) covered++;
    }
    const ratio = covered / expectedWords.size;
    const passed = ratio >= 0.5;
    return {
      ruleName: 'expected_coverage',
      passed,
      score: ratio,
      value: { stat: 'expected_terms_covered', unit: 'ratio', value: ratio },
      evidence: [{ type: 'count', stat: 'expected_terms_covered', unit: 'ratio', value: ratio, threshold: 0.5, thresholdSource: 'rule' }],
      message: `Covered ${covered}/${expectedWords.size} expected terms (${(ratio * 100).toFixed(0)}%)`,
    };
  },
};

/*
 * Did the agent call its tools correctly?
 *
 * The 2026-09-05 audit found this reachable as a wrong PASS: an agent that calls a tool
 * which does not exist, or passes arguments its schema rejects, and then
 * writes a plausible paragraph, satisfied every bundle Iris had. The
 * deterministic half of the question needs exactly one thing Iris never
 * held — the schema each tool declares — and the tools catalogue is that.
 *
 * COMPLETENESS, not safety, and the bundle law decides it rather than the
 * question does: the harm of an invalid call is that THE WORK DID NOT
 * HAPPEN, because the tool refused. `no_silent_tool_failure` shares the same
 * `tool_use_correct` question and sits in safety because its harm is a
 * different one — an answer that is untrue.
 *
 * IT FIRES ONLY ON CALLS THE AGENT NEVER RECOVERED FROM, and that is not a
 * kindness. The condition is deterministic, so a family labelled "was the
 * call invalid" would measure precision at essentially one — and this is the
 * only detector of its failure class, while src/eval/risk.ts takes the
 * maximum positive predictive value over the detectors of a class. A
 * probability of one would mean every trajectory containing a single
 * fumbled-then-fixed call failed the composer. An agent that mistypes an
 * argument, reads the error and retries correctly did good work. Firing only
 * on the unrecovered ones makes the family's positive class equal the harm,
 * which is what makes the published number mean what the risk layer needs.
 *
 * A call to a tool that is NOT IN THE CATALOGUE is never recoverable: the
 * tool does not exist, so calling it is invented capability rather than a
 * typo, and a later well-formed call to the same name cannot undo it.
 */
export const validToolArguments: EvalRule = {
  name: 'valid_tool_arguments',
  description:
    "Tool calls must be callable. Fails when a call names a tool absent from the supplied catalogue, or carries arguments the tool's own JSON Schema rejects, AND no later call to the same tool succeeded — a mistyped argument the agent noticed and retried is recorded, not failed. A call named mcp__<server>__<tool> is matched to the entry under that name and, when there is none, to the entry under the tool's own name, and the result says so; when more than one called name leads to one entry that way, those calls are not checked and the result says what to list. Needs the `tools` catalogue (your MCP tools/list result, verbatim); without it the rule SKIPS rather than passes, because a call cannot be checked against a schema nobody supplied. A schema Iris declines to compile leaves that tool's calls unchecked and names which tool and why. It reads a run of up to 10,000 tool calls whole. Of a longer run a call to a tool the catalogue does not have is reported, and otherwise the rule is not judged: a retry may be among the calls it did not read",
  evalType: 'completeness',
  weight: 1,
  kind: 'detection',
  mechanism: 'formula',
  needs: ['tool_calls', 'tools_catalogue'],
  question: 'tool_use_correct',
  classes: ['invalid_tool_call'],
  // 2: a call named mcp__<server>__<tool> is matched to the catalogue by the tool's own name too (catalogue.ts, catalogueMatch); and the rule reads a run whole where it read the first 500 calls (#1013). Both since the last release, so one step.
  version: 2,
  /*
   * Not critical. Recovery detection is a heuristic over tool NAMES — an
   * agent that "recovers" with different, also-wrong-but-schema-valid
   * arguments reads as recovered — and a heuristic that can be wrong
   * degrades the score rather than vetoing the verdict. The same reasoning
   * that keeps no_hallucination_markers and no_silent_tool_failure out of
   * the veto set.
   */
  evaluate(context: EvalContext): EvalRuleResult {
    const skip = skipWithoutTrajectory('valid_tool_arguments', context);
    if (skip) return skip;

    if (context.customConfig?.validate_tool_arguments === false) {
      return {
        ruleName: 'valid_tool_arguments',
        passed: false,
        score: 0,
        skipped: true,
        skipReason: 'eval.validateToolArguments is false — argument checking is turned off for this deployment',
        message: 'Argument checking is turned off (eval.validateToolArguments)',
      };
    }

    const catalogue = catalogueIndex(context);
    if (catalogue === null) {
      return {
        ruleName: 'valid_tool_arguments',
        passed: false,
        score: 0,
        skipped: true,
        skipReason:
          'context.tools not provided — a call cannot be checked against a schema nobody supplied (pass `tools`, your MCP tools/list result, or a trace_id whose trace carries it)',
        message: 'No tools catalogue provided',
      };
    }

    const steps = stepsOf(context);
    const scope = stepScopeNote(context);
    const checks: ArgumentCheck[] = [];
    const uncheckedReasons = new Map<string, string>();
    /*
     * A catalogue that simply declares no schema for a tool is NOT a broken
     * definition — it is a catalogue with nothing to check against, which is
     * `not_applicable`. Only a schema Iris REFUSED is `config_invalid`, and
     * the difference matters the moment a deployment promotes this rule
     * through eval.criticalRules: one of those makes the verdict unknown and
     * the other does not.
     */
    let refusedSchema = false;

    /*
     * The catalogue names no server. An entry reached by a tool's own name
     * (catalogue.ts, catalogueMatch) is that tool's when one called name
     * leads to it. When two do (mcp__docs__search and mcp__tickets__search
     * on one entry `search`), it is the tool of at most one of them, and a
     * schema that is not a call's own would fail a correct call or pass a
     * wrong one. Neither is checked, and the reason says what to list.
     */
    const matches = steps.map((step) => catalogueMatch(catalogue, step.name));
    const calledAs = new Map<string, Set<string>>();
    for (const [i, match] of matches.entries()) {
      if (match === undefined) continue;
      const names = calledAs.get(match.tool.name) ?? new Set<string>();
      names.add(steps[i].name);
      calledAs.set(match.tool.name, names);
    }
    /** The entry a call was checked against, when it was reached by the tool's own name. */
    const ownNameEntry = (i: number): string | null => (matches[i]?.by === 'own' ? matches[i]!.tool.name : null);
    /** Entries more than one called name leads to: said in the message, with what to do. */
    const sharedEntries = new Set<string>();

    for (const [i, step] of steps.entries()) {
      const match = matches[i];
      if (match === undefined) {
        checks.push({ state: 'invalid', keyword: 'not_in_catalogue' });
        continue;
      }
      const tool = match.tool;
      const leadingToIt = calledAs.get(tool.name)!.size;
      if (match.by === 'own' && leadingToIt > 1) {
        const why = `the catalogue has one entry, ${tool.name}, and ${leadingToIt} called names lead to it; list each tool under the name it is called by`;
        checks.push({ state: 'unchecked', reason: why });
        uncheckedReasons.set(step.name, why);
        sharedEntries.add(tool.name);
        continue;
      }
      if (tool.inputSchema === undefined) {
        checks.push({ state: 'unchecked', reason: 'the catalogue declares no inputSchema for this tool' });
        uncheckedReasons.set(step.name, 'no inputSchema in the catalogue');
        continue;
      }
      const compiled = compileToolSchema(tool.inputSchema);
      if (!compiled.ok) refusedSchema = true;
      const check = checkArguments(compiled, step.input);
      if (check.state === 'unchecked' && check.reason !== undefined) uncheckedReasons.set(step.name, check.reason);
      checks.push(check);
    }

    const invalidIndexes = checks.flatMap((c, i) => (c.state === 'invalid' ? [i] : []));
    const checked = checks.filter((c) => c.state !== 'unchecked').length;
    const unchecked = checks.length - checked;

    /*
     * Every call unchecked because a schema would not compile: that is a
     * broken definition rather than a missing input, so it is
     * `config_invalid`, and the message names each tool and its reason. An
     * operator who cannot see WHICH schema was refused cannot fix it.
     */
    if (checked === 0 && steps.length > 0) {
      const named = [...uncheckedReasons.entries()]
        .slice(0, 3)
        .map(([tool, why]) => `${tool} (${why})`)
        .join('; ');
      const because = named.length > 0 ? named : 'the catalogue names none of the tools called';
      return {
        ruleName: 'valid_tool_arguments',
        passed: false,
        score: 0,
        skipped: true,
        configInvalid: refusedSchema,
        skipReason: `no call could be checked: ${because}`,
        message: `Arguments not judged: ${because}${scope}`,
        evidence: [{ type: 'count', stat: 'calls_unchecked', unit: 'calls', value: unchecked }],
      };
    }

    /*
     * Recovery, by tool name: a later call to the same tool whose arguments
     * validate. The named false negative is in the family's labelling line —
     * an agent that retries with different, also-wrong-but-schema-valid
     * arguments scores as recovered, and that miss belongs to
     * no_silent_tool_failure rather than to this rule.
     *
     * The name is the one the call was made by. A call under another name
     * that reaches the same entry is not a retry of this one: read as one,
     * mcp__a__get_product would be "recovered" by mcp__b__get_product.
     */
    // The last valid call under each name, found once: asked per invalid call over the steps after it, a run of invalid calls cost the square of its length.
    const lastValidCall = new Map<string, number>();
    for (const [j, step] of steps.entries()) if (checks[j].state === 'valid') lastValidCall.set(step.name, j);
    const recoveredLater = (index: number): boolean => {
      if (checks[index].keyword === 'not_in_catalogue') return false;
      return (lastValidCall.get(steps[index].name) ?? -1) > index;
    };
    const unrecovered = invalidIndexes.filter((i) => !recoveredLater(i));
    const recovered = invalidIndexes.filter((i) => recoveredLater(i));

    const evidence: Evidence[] = [
      { type: 'count', stat: 'unrecovered_invalid_calls', unit: 'calls', value: unrecovered.length, threshold: 0, thresholdSource: 'rule' },
      { type: 'count', stat: 'calls_checked', unit: 'calls', value: checked },
    ];
    if (unchecked > 0) evidence.push({ type: 'count', stat: 'calls_unchecked', unit: 'calls', value: unchecked });
    if (recovered.length > 0) evidence.push({ type: 'count', stat: 'retries_after_invalid_call', unit: 'calls', value: recovered.length });
    // Said on every result, pass or fail: a schema reached by a tool's own name is the right one only if no other server has a tool of that name.
    const byOwnName = checks.filter((c, i) => c.state !== 'unchecked' && ownNameEntry(i) !== null).length;
    if (byOwnName > 0) evidence.push({ type: 'count', stat: 'calls_matched_by_own_name', unit: 'calls', value: byOwnName });
    for (const i of [...unrecovered, ...recovered]) {
      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
      const c = checks[i];
      const suffix = recovered.includes(i) ? ' (recovered by a later call)' : '';
      const against = ownNameEntry(i) === null ? '' : `, by the schema of the catalogue's ${ownNameEntry(i)}`;
      const label =
        c.keyword === 'not_in_catalogue'
          ? 'not in the tools catalogue'
          : `arguments rejected: ${c.instancePath ?? '(root)'} ${c.keyword ?? 'schema'}${against}${suffix}`;
      evidence.push({ type: 'toolCall', index: i, toolName: steps[i].name, label });
    }

    const value = { stat: 'unrecovered_invalid_calls', unit: 'calls', value: unrecovered.length };
    const uncheckedNote =
      unchecked > 0 ? ` (${unchecked} call${unchecked === 1 ? '' : 's'} not checked: ${[...uncheckedReasons.keys()].slice(0, 2).join(', ')})` : '';
    const ownNameNote = byOwnName > 0 ? `; ${byOwnName} matched to the catalogue by the tool's own name` : '';
    const sharedNote =
      sharedEntries.size > 0
        ? `. More than one called name leads to the catalogue's ${[...sharedEntries].slice(0, 2).join(' and ')}: list each tool under the name it is called by to have its calls checked`
        : '';

    /*
     * A run longer than the list the rules read (steps.ts). A call to a
     * tool the catalogue does not have is a finding no later call clears,
     * and stands. Anything else could change with the rest of the run: an
     * invalid call may be retried successfully among the calls not read,
     * and a clean result says nothing of them. Until 0.22.0 the rule
     * answered for the run on its first 500 calls either way (#1013).
     */
    if (!unrecovered.some((i) => checks[i].keyword === 'not_in_catalogue')) {
      const cut = notJudgedPastCeiling(
        'valid_tool_arguments',
        context,
        unrecovered.length === 0
          ? 'Every call checked among them was callable, and the rest were not checked'
          : `${unrecovered.length} invalid call${unrecovered.length === 1 ? ' was' : 's were'} not retried successfully among them, and a retry may be among the rest`,
      );
      if (cut !== null) return cut;
    }

    if (unrecovered.length === 0) {
      const retried = recovered.length > 0 ? `; ${recovered.length} invalid call${recovered.length === 1 ? '' : 's'} the agent retried successfully` : '';
      return {
        ruleName: 'valid_tool_arguments',
        passed: true,
        score: 1,
        value,
        evidence,
        message: `Every checked call was callable (${checked} of ${steps.length} checked${retried}${ownNameNote})${uncheckedNote}${sharedNote}`,
      };
    }

    const named = unrecovered
      .slice(0, 3)
      .map((i) =>
        checks[i].keyword === 'not_in_catalogue'
          ? `${steps[i].name} (not in the catalogue)`
          : `${steps[i].name} (${checks[i].instancePath ?? '(root)'} ${checks[i].keyword ?? 'schema'}${ownNameEntry(i) === null ? '' : `, by the schema of the catalogue's ${ownNameEntry(i)}`})`,
      )
      .join('; ');
    return {
      ruleName: 'valid_tool_arguments',
      passed: false,
      score: Math.max(0, 1 - unrecovered.length / Math.max(1, steps.length)),
      value,
      evidence,
      message: `Invalid tool call${unrecovered.length === 1 ? '' : 's'} the agent never recovered from: ${named}${uncheckedNote}${sharedNote}${scope}`,
    };
  },
};

/*
 * Did the answer address everything the ask asked for?
 *
 * The commonest real agent incompletion, and until now the whole "did it
 * complete the task" row of the capability map was a gap in every subject
 * because no rule read the structure of an ask. Transcript t-19 drops parts
 * two and three of a three-part question and every bundle passed it.
 *
 * TYPED AS AN INFERENCE, and the alternative is worth stating because it
 * looks like the safer one. Typed as a MEASUREMENT this rule would be inert
 * AND misdescribed: measurements never enter the risk estimate, so it could
 * not move a verdict — and `interpretations[]` would still hand it the line
 * about its published accuracy not carrying the risk past the loss
 * threshold, which is false for a rule that has no published accuracy in the
 * risk at all. Meanwhile the class it detects would stay at zero recall
 * while a rule for it existed. The splitting is a formula, but the covering
 * test is a signal standing in for something unobservable — did the agent
 * address this — and that is what an inference is.
 *
 * The obligation that makes the typing honest is the family: its cases are
 * labelled by READING the ask against the answer, never by whether the term
 * arithmetic comes out a particular way. Labelled on the arithmetic, the
 * measured precision would be the probability that the arithmetic agrees
 * with itself — a number near one that then becomes arithmetic in every
 * verdict.
 */
export const askCoverage: EvalRule = {
  name: 'ask_coverage',
  description:
    'A multi-part ask must be answered in every part. Splits the input on enumerations, bullet lists and multi-word connectors — a bare "and" never splits, so "review and merge" is one ask — then reports the parts neither the output nor the trajectory engages with: a part is covered when the answer addresses it, or when a tool call the trace shows acted on it (0.15.0). Measures only parts carrying at least two content terms and says how many it could not measure, because a one-term part makes any lexical test a coin flip. Skips when the input is absent, when it is longer than 1500 characters (an input that long usually carries source material rather than an ask), or when fewer than two parts can be measured',
  evalType: 'completeness',
  weight: 1.5,
  kind: 'inference',
  mechanism: 'heuristic',
  needs: ['output', 'input'],
  outputView: 'values',
  question: 'task_completed',
  classes: ['incomplete_ask'],
  // 4: reads the calls of a run whole where it read the first 500, and does not find against a part that a call it did not read may have done (#1013).
  version: 4,
  /*
   * Not critical. A lexical covering test has an honest false-positive
   * surface — an answer in wholly different words with no ordinal to mirror
   * reads as uncovered — and a heuristic that can be wrong degrades the
   * score rather than vetoing the verdict.
   */
  evaluate(context: EvalContext): EvalRuleResult {
    const input = context.input ?? '';
    if (input.trim().length === 0) {
      return {
        ruleName: 'ask_coverage',
        passed: false,
        score: 0,
        skipped: true,
        skipReason: 'context.input not provided — the parts of an ask cannot be counted without the ask',
        message: 'No input provided',
      };
    }
    if (context.output.trim().length === 0) {
      /*
       * non_empty_output owns an empty answer. Firing here as well would put
       * one output in two failure classes and double-count it in the risk.
       */
      return {
        ruleName: 'ask_coverage',
        passed: false,
        score: 0,
        skipped: true,
        skipReason: 'the output is empty — non_empty_output judges that, and one output should not carry two failure classes',
        message: 'Empty output',
      };
    }
    if (input.length > MAX_ASK_CHARS) {
      return {
        ruleName: 'ask_coverage',
        passed: false,
        score: 0,
        skipped: true,
        skipReason: `the input is ${input.length} characters; above ${MAX_ASK_CHARS} it usually carries source material rather than an ask, and splitting a pasted document into "parts" would fire on every summarisation`,
        message: 'Input too long to read as an ask',
      };
    }

    const parts = splitAsk(input);
    const measurable = measurableParts(parts);
    if (measurable.length < 2) {
      return {
        ruleName: 'ask_coverage',
        passed: false,
        score: 0,
        skipped: true,
        skipReason:
          parts.length < 2
            ? 'the input asks for one thing — this rule judges whether a MULTI-part ask was answered in every part'
            : `only ${measurable.length} of ${parts.length} parts carry enough content to measure; a one-term part makes any lexical test a coin flip`,
        message: 'Not a multi-part ask this rule can measure',
      };
    }

    const index = answerIndex(context.output);
    /*
     * Covering by tool call: a part the answer never
     * mentions may still have been DONE — the trajectory shows a call whose
     * name, arguments or result carry the part's terms. The same lexical
     * test as the answer's, over the steps' text, so the trajectory can only
     * add coverage, never remove it (recall-only for the proof family).
     */
    const unanswered = measurable.filter((p) => !coversPart(p, context.output, index));
    // The trajectory is read only for a part the answer left: on a long run its text is megabytes, and an answer that covers every part needs none of it.
    const steps = unanswered.length > 0 ? stepsOf(context) : [];
    const trajectoryIndex =
      steps.length > 0
        ? answerIndex(
            steps
              .map((st) => [st.name, typeof st.input === 'string' ? st.input : JSON.stringify(st.input ?? ''), typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? '')].join(' '))
              .join(' '),
          )
        : null;
    const coveredByAction = new Set<AskPart>();
    const uncovered = unanswered.filter((p) => {
      if (trajectoryIndex && hitsPart(p, trajectoryIndex) >= requiredHits(p)) {
        coveredByAction.add(p);
        return false;
      }
      return true;
    });
    /*
     * A part neither the answer nor a call that was read addresses, on a
     * run longer than the list the rules read (steps.ts): a call among the
     * rest may have done it, so the finding is not one. An answer that
     * covers every part is judged as it is, whatever the run's length.
     */
    if (uncovered.length > 0 && runWasCut(context)) {
      const cut = notJudgedPastCeiling(
        'ask_coverage',
        context,
        `${uncovered.length} part${uncovered.length === 1 ? '' : 's'} of the ask ${uncovered.length === 1 ? 'is' : 'are'} addressed by neither the answer nor a call among them, and a call among the rest may address ${uncovered.length === 1 ? 'it' : 'them'}`,
      );
      if (cut !== null) return cut;
    }
    const covered = measurable.length - uncovered.length;
    const unmeasured = parts.length - measurable.length;

    const value = { stat: 'uncovered_ask_parts', unit: 'parts', value: uncovered.length };
    const evidence: Evidence[] = [
      { type: 'count', stat: 'uncovered_ask_parts', unit: 'parts', value: uncovered.length, threshold: 0, thresholdSource: 'rule' },
      { type: 'count', stat: 'measurable_ask_parts', unit: 'parts', value: measurable.length },
      { type: 'count', stat: 'ask_parts', unit: 'parts', value: parts.length },
      ...(coveredByAction.size > 0 ? [{ type: 'count' as const, stat: 'ask_parts_covered_by_tool_call', unit: 'parts', value: coveredByAction.size }] : []),
    ];
    for (const p of uncovered) {
      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
      // A span into the INPUT: the best evidence either new inference
      // produces, because it points at the sentence that was ignored.
      evidence.push({ type: 'span', source: 'input', start: p.start, end: p.end, label: 'uncovered ask part' });
    }
    const unmeasuredNote = unmeasured > 0 ? `; ${unmeasured} part${unmeasured === 1 ? '' : 's'} not measurable (fewer than ${MIN_MEASURABLE_TERMS} content terms)` : '';

    const actionNote = coveredByAction.size > 0 ? ` (${coveredByAction.size} covered by a tool call the trace shows, not by the answer)` : '';
    if (uncovered.length === 0) {
      return {
        ruleName: 'ask_coverage',
        passed: true,
        score: 1,
        value,
        evidence,
        message: `All ${measurable.length} measurable parts of the ask are addressed${actionNote}${unmeasuredNote}`,
      };
    }

    const named = uncovered.slice(0, 2).map((p) => `"${p.text.length > 70 ? `${p.text.slice(0, 69)}…` : p.text}"`).join('; ');
    return {
      ruleName: 'ask_coverage',
      passed: false,
      score: measurable.length === 0 ? 0 : covered / measurable.length,
      value,
      evidence,
      message: `Ask coverage: ${covered}/${measurable.length} measurable parts addressed${actionNote}${unmeasuredNote}. Unaddressed: ${named}`,
    };
  },
};

export const completenessRules: EvalRule[] = [minOutputLength, nonEmptyOutput, sentenceCount, expectedCoverage, validToolArguments, askCoverage, toolSequence, saysSomething, ...caseHistoryRules];
