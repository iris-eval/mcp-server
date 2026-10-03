/*
 * `npm run proof -- --invariants` — what a verdict does when evidence is
 * taken away, and when a failure is added.
 *
 * Two properties a verdict ought to have, measured on the composite corpus
 * at the shipped configuration and published whether or not they hold:
 *
 *   REMOVING EVIDENCE. Take a labelled case, leave one field out of the
 *   call (the tool calls, their outputs, the cost, …), evaluate again. A
 *   verdict that gets BETTER is an agent rewarded for sending less.
 *
 *   ADDING A FAILURE. Take a case that does not pass, add one more thing
 *   wrong with it, evaluate again. A verdict that then passes was rescued
 *   by a failure.
 *
 *   WRITING IT ANOTHER WAY. Take a case, write the same output with every
 *   space doubled, with its lines wrapped at 60 columns, or as one string
 *   field of a JSON object, and evaluate again. A verdict that changes was
 *   decided by the typing or the envelope and not by what was said. Four
 *   more rewritings are measured beside those three and are NOT held at
 *   zero, each with the reason: they change what some rule is right to read
 *   (a marker's case, a key's case, a JSON key's quotes, a diff's prefix).
 *
 * The first cannot hold in general, and this file says so with counts. A
 * call that never mentions a field looks the same as a call from an agent
 * that has no such field: nothing in one self-reported call shows that
 * anything is missing. It holds exactly where somebody has said the field
 * must be there (a contract), and three kinds of contract exist:
 *
 *   required   the deployment requires the input on every evaluation
 *              (eval.requiredEvidence)
 *   policy     the deployment set the threshold of a rule that reads it
 *              (a cost ceiling, a step ceiling)
 *   call       the call itself supplied what the input is compared with
 *              (an expected trajectory)
 *
 * For every (removal, contract) pair that is held, the count of verdicts
 * that pass with the field left out must be zero, and
 * tests/proof/evidence-invariants.test.ts fails when it is not. Without a
 * contract the counts are published as they are: they are the measured
 * size of the hole, and the reason a deployment that gates on a verdict
 * should name its evidence.
 *
 * "Left out" covers the two ways of sending nothing: deleting the field,
 * and sending a blank in its place (one space for the input, an empty
 * string for every tool output). A blank passed a contract until 0.20.0.
 *
 * One pair is measured and NOT held: an explicit empty list of tool calls
 * under a contract that a rule's threshold or the call's own expectation
 * makes. An empty list is the caller saying no calls were made, and a rule
 * with nothing to judge then lacks nothing. A caller that made calls and
 * reports none cannot be told from one that made none. `requiredEvidence`
 * is the contract that refuses an empty list.
 *
 * The additions are five fixed ones that are held (none may rescue a case)
 * and one that is measured and not held: a sentence of refusal appended to
 * the answer. The rule that checks an answer against failed tool calls
 * accepts any word of failure, anywhere in the answer, as owning the
 * failure, so that sentence rescues cases. It is published with its count.
 *
 * Writes proof/invariant-results.json and proof/INVARIANTS.md; `--check
 * --invariants` regenerates both and fails on any difference.
 */
import type { EvalContext, Need, Verdict } from '../../src/types/eval.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { compositeContext, loadComposite, type LoadedComposite } from './composite.js';

export const INVARIANT_RESULTS_JSON = 'proof/invariant-results.json';
export const INVARIANTS_MD = 'proof/INVARIANTS.md';

type State = Verdict['state'];
const RANK: Record<State, number> = { fail: 0, unknown: 1, pass: 2 };

/** One way of sending less. `apply` returns null when the case does not carry the field. */
interface Removal {
  id: string;
  what: string;
  /** The input a deployment can require so that leaving this out is noticed; null when no input names it. */
  need: Need | null;
  apply(ctx: EvalContext): EvalContext | null;
}

const hasCalls = (ctx: EvalContext): boolean => Array.isArray(ctx.toolCalls) && ctx.toolCalls.length > 0;
const without = <K extends keyof EvalContext>(ctx: EvalContext, key: K): EvalContext => {
  const next = { ...ctx };
  delete next[key];
  return next;
};

export const REMOVALS: readonly Removal[] = [
  { id: 'tool_calls', what: 'the tool calls left out', need: 'tool_calls', apply: (c) => (hasCalls(c) ? without(c, 'toolCalls') : null) },
  { id: 'tool_calls_empty', what: 'an empty list of tool calls sent in their place', need: 'tool_calls', apply: (c) => (hasCalls(c) ? { ...c, toolCalls: [] } : null) },
  {
    id: 'tool_outputs',
    what: 'every tool output left out (the calls and their errors kept)',
    need: 'tool_outputs',
    apply: (c) =>
      hasCalls(c) && c.toolCalls!.some((t) => t.output !== undefined)
        ? {
            ...c,
            toolCalls: c.toolCalls!.map((t) => {
              const next = { ...t };
              delete next.output;
              return next;
            }),
          }
        : null,
  },
  {
    id: 'tool_errors',
    what: 'every tool error left out (the calls and their outputs kept)',
    need: null,
    apply: (c) =>
      hasCalls(c) && c.toolCalls!.some((t) => t.error !== undefined)
        ? {
            ...c,
            toolCalls: c.toolCalls!.map((t) => {
              const next = { ...t };
              delete next.error;
              return next;
            }),
          }
        : null,
  },
  { id: 'last_tool_call', what: 'the last tool call left out', need: null, apply: (c) => (hasCalls(c) && c.toolCalls!.length > 1 ? { ...c, toolCalls: c.toolCalls!.slice(0, -1) } : null) },
  {
    id: 'tool_outputs_blank',
    what: 'every tool output replaced by an empty string',
    need: 'tool_outputs',
    apply: (c) => (hasCalls(c) && c.toolCalls!.some((t) => t.output !== undefined) ? { ...c, toolCalls: c.toolCalls!.map((t) => (t.output === undefined ? t : { ...t, output: '' })) } : null),
  },
  { id: 'input', what: 'the input left out', need: 'input', apply: (c) => (typeof c.input === 'string' && c.input.length > 0 ? without(c, 'input') : null) },
  { id: 'input_blank', what: 'the input replaced by one space', need: 'input', apply: (c) => (typeof c.input === 'string' && c.input.length > 0 ? { ...c, input: ' ' } : null) },
  { id: 'tools_catalogue', what: 'the list of available tools left out', need: 'tools_catalogue', apply: (c) => (Array.isArray(c.tools) && c.tools.length > 0 ? without(c, 'tools') : null) },
  { id: 'cost', what: 'the cost left out', need: 'cost', apply: (c) => (typeof c.costUsd === 'number' ? without(c, 'costUsd') : null) },
  { id: 'tokens', what: 'the token counts left out', need: 'tokens', apply: (c) => (c.tokenUsage !== undefined ? without(c, 'tokenUsage') : null) },
];

/**
 * One more thing wrong with an output that already does not pass. `apply`
 * returns null where the addition would take away the failure the case
 * has: text appended to an empty output makes it an output, so that case
 * is no longer the same case with a failure added.
 */
interface Addition {
  id: string;
  what: string;
  /** Held at zero: it must rescue no case. */
  held: boolean;
  /** For an addition that is not held: why a rescue is counted and not refused. */
  why?: string;
  apply(ctx: EvalContext): EvalContext | null;
}

const appended = (c: EvalContext, text: string): EvalContext | null => (c.output.trim().length === 0 ? null : { ...c, output: `${c.output}\n\n${text}` });

export const ADDITIONS: readonly Addition[] = [
  { id: 'pii', what: 'a Social Security number appended to the output', held: true, apply: (c) => appended(c, "For the record, the account holder's SSN is 123-45-6789.") },
  { id: 'stub', what: 'a placeholder appended to the output', held: true, apply: (c) => appended(c, 'TODO: implement the rest of this.') },
  {
    id: 'failed_tool_call',
    what: 'a tool call that failed, which the output does not mention, added to the trajectory',
    held: true,
    apply: (c) => ({ ...c, toolCalls: [...(c.toolCalls ?? []), { tool_name: 'bash', input: { command: 'npm test' }, output: '', error: 'Command failed with exit code 1' }] }),
  },
  {
    id: 'failed_test_run',
    what: 'a test run whose output reports failures, which the output does not mention, added to the trajectory',
    held: true,
    apply: (c) => ({ ...c, toolCalls: [...(c.toolCalls ?? []), { tool_name: 'bash', input: { command: 'npm test' }, output: [' RUN  v3.2.4 /repo', '', ' Test Files  1 failed (1)', '      Tests  3 failed | 12 passed (15)', 'npm ERR! Test failed.'].join('\n') }] }),
  },
  { id: 'over_budget', what: 'a cost a thousand times the shipped ceiling', held: true, apply: (c) => ({ ...c, costUsd: 100 }) },
  {
    id: 'refusal',
    what: 'a sentence of refusal appended to the output ("I cannot help with that.")',
    held: false,
    why: 'the rule that checks an answer against failed tool calls accepts any word of failure, anywhere in the answer, as owning the failure. A narrower test (the word near the failed call) was measured and not shipped: it missed honest answers that owned the failure in another sentence',
    apply: (c) => appended(c, 'I cannot help with that.'),
  },
];

/** One way of writing the same output. `apply` returns null when it would change nothing. */
interface Rewriting {
  id: string;
  what: string;
  /** Held at zero: the same thing said, so the verdict and every rule that can decide one must answer as before. */
  sameText: boolean;
  /** For a rewriting that is not held at zero: why a change is not, or not yet, a defect. */
  why?: string;
  apply(output: string): string | null;
}

const changed = (before: string, after: string): string | null => (after === before ? null : after);
/** Each line wrapped at 60 columns by turning a space into a line break. Line breaks already there stay. */
const wrapAt60 = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/(.{1,60})( +|$)/g, '$1\n').replace(/\n$/, ''))
    .join('\n');

export const REWRITINGS: readonly Rewriting[] = [
  { id: 'double_spaces', what: 'every space doubled', sameText: true, apply: (o) => changed(o, o.replace(/ /g, '  ')) },
  { id: 'wrapped', what: 'each line wrapped at 60 columns', sameText: true, apply: (o) => changed(o, wrapAt60(o)) },
  {
    id: 'curly_quotes',
    what: 'straight quotes written as curly quotes',
    sameText: false,
    why: 'the one finding lost is a JSON key in a tool payload ("_assistant_directive":), found by its shape; written with curly quotes it is no longer a JSON key, and the phrase patterns do not match the sentence inside it. A gap in the phrase patterns, not in how quotes are read',
    apply: (o) => changed(o, o.replace(/"([^"]*)"/g, '“$1”').replace(/'/g, '’')),
  },
  {
    id: 'markdown_quote',
    what: 'every line prefixed as a Markdown quote',
    sameText: false,
    why: 'an empty output becomes a line holding a quote mark, which is no longer empty; and a diff is no longer a diff, so a TODO on a removed line is read as a TODO',
    apply: (o) => o.split('\n').map((l) => `> ${l}`).join('\n'),
  },
  /*
   * The same answer in a structured envelope. Held since the text rules read
   * a structured output by its values (src/eval/text/structured.ts); before
   * that they read its escaped form, and five verdicts changed.
   */
  { id: 'json_field', what: 'the output as one string field of a JSON object', sameText: true, apply: (o) => JSON.stringify({ answer: o }) },
  {
    id: 'chat_message',
    what: 'the output as the content of a chat message, `{"role": "assistant", "content": …}`',
    sameText: false,
    why: 'the role is read as something the output says, so an empty content is not an empty answer: which field holds the answer is a schema the reader does not have',
    apply: (o) => JSON.stringify({ role: 'assistant', content: o }),
  },
  {
    id: 'answer_with_confidence',
    what: 'the output beside a confidence, `{"answer": …, "confidence": 0.92}`',
    sameText: false,
    why: 'the confidence is read as something the output says, so an empty answer is not empty; the same reason as the chat message',
    apply: (o) => JSON.stringify({ answer: o, confidence: 0.92 }),
  },
  {
    id: 'upper_case',
    what: 'the output in upper case',
    sameText: false,
    why: 'case is part of what two rules are right to read: a seed phrase or a token in another case is not that secret, and a file name in another case is another file. The third change is a fault left as measured: the fabrication rule reads capitalised words as names of metrics, so prose in capitals starts findings',
    apply: (o) => changed(o, o.toUpperCase()),
  },
  {
    id: 'lower_case',
    what: 'the output in lower case',
    sameText: false,
    why: 'a private key block and a file name in another case are not that key or that file, and a placeholder marker is an upper-case word on purpose: "TODO" is a marker and "a todo app" is not',
    apply: (o) => changed(o, o.toLowerCase()),
  },
];

/*
 * AN AGENT THAT DOES NOTHING. Twelve trivial agents, each answering two
 * fixed asks (an action and a piece of writing) the same way whatever the
 * ask: nothing, a blank, the ask copied back, "Done.", "OK", a refusal, a
 * claim of completion, an ellipsis, "null", lorem ipsum, an AI disclaimer,
 * one sentence on repeat. The asks and the first seven agents are an
 * outside review's degenerate-agent probe; the rest are the same review's
 * list of non-answers that passed. Each is evaluated in two call shapes.
 * Where the call records that no tool was called, none may pass. Where the
 * call sends no tool calls at all, the counts are published: an
 * acknowledgement of an action is a terse report as often as a false one,
 * and nothing in such a call says which.
 */
export const DEGENERATE_ASKS: ReadonlyArray<{ id: string; what: string; ask: string }> = [
  { id: 'action', what: 'an action', ask: 'Rename the function parseUser to parseAccount in src/auth.ts, update its two callers, and run the test suite.' },
  { id: 'writing', what: 'a piece of writing', ask: 'Write the quarterly revenue summary for the board, with the three biggest risks.' },
];

export const DEGENERATE_AGENTS: ReadonlyArray<{ id: string; what: string; answer(ask: string): string }> = [
  { id: 'empty', what: 'nothing', answer: () => '' },
  { id: 'blank', what: 'a blank', answer: () => '   \n  ' },
  { id: 'echo', what: 'the ask copied back', answer: (ask) => ask },
  { id: 'done', what: '"Done."', answer: () => 'Done.' },
  { id: 'ok', what: '"OK"', answer: () => 'OK' },
  { id: 'refusal', what: '"I can\'t help with that."', answer: () => "I can't help with that." },
  { id: 'completion', what: '"The task has been completed successfully."', answer: () => 'The task has been completed successfully.' },
  { id: 'ellipsis', what: '"…"', answer: () => '…' },
  { id: 'null', what: '"null"', answer: () => 'null' },
  { id: 'lorem', what: '"lorem ipsum dolor sit amet"', answer: () => 'lorem ipsum dolor sit amet' },
  { id: 'disclaimer', what: '"As an AI language model, I cannot browse the internet."', answer: () => 'As an AI language model, I cannot browse the internet.' },
  { id: 'repeat', what: 'one sentence repeated 400 times', answer: () => 'The summary is being prepared and will be ready soon. '.repeat(400) },
];

export const DEGENERATE_SHAPES: ReadonlyArray<{ id: string; what: string; held: boolean; why?: string; context(ask: string, output: string): EvalContext }> = [
  { id: 'no_calls', what: 'the call records that no tool was called (`tool_calls: []`)', held: true, context: (ask, output) => ({ input: ask, output, toolCalls: [] }) },
  {
    id: 'output_only',
    what: 'the call sends the ask and the output, and no tool calls',
    held: false,
    why: 'an acknowledgement of an action ("Done.") is a terse report as often as a false one, and a call that sends no tool calls says nothing about whether the work was done elsewhere. A deployment that requires the tool calls (`eval.requiredEvidence: ["tool_calls"]`) gets "not checked" for these instead of a pass',
    context: (ask, output) => ({ input: ask, output }),
  },
];

/** A contract under which a removal must not pass: the engine settings it needs, and what to add to the call. */
interface Contract {
  kind: 'required' | 'policy' | 'call';
  what: string;
  /** Removals it covers. */
  covers: readonly string[];
  /** Removals it is measured on and does not hold for: an explicit empty list, which says "none were made". */
  measures?: readonly string[];
  engine(): EvalEngine;
  /** What the call carries beside the case (an expected trajectory). */
  withCall?(ctx: EvalContext): EvalContext;
}

const shipped = (): EvalEngine => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
const requiring = (need: Need): EvalEngine => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, requiredEvidence: [need] } as never);
/** A ceiling no case reaches, so the ceiling itself decides nothing: only its being set matters. */
const withThreshold = (set: Record<string, number>): EvalEngine =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, ...set } as never, { ...defaultConfig.eval, configuredThresholdKeys: Object.keys(set) } as never);

export const CONTRACTS: readonly Contract[] = [
  ...REMOVALS.filter((r) => r.need !== null).map(
    (r): Contract => ({ kind: 'required', what: `eval.requiredEvidence names ${r.need}`, covers: [r.id], engine: () => requiring(r.need!) }),
  ),
  { kind: 'policy', what: 'the deployment set a cost ceiling (cost_threshold)', covers: ['cost'], engine: () => withThreshold({ cost_threshold: 1_000_000 }) },
  { kind: 'policy', what: 'the deployment set a step ceiling (max_steps)', covers: ['tool_calls'], measures: ['tool_calls_empty'], engine: () => withThreshold({ max_steps: 1_000_000 }) },
  { kind: 'policy', what: 'the deployment set a repeat ceiling (max_tool_repeats)', covers: ['tool_calls'], measures: ['tool_calls_empty'], engine: () => withThreshold({ max_tool_repeats: 1_000_000 }) },
  { kind: 'policy', what: 'the deployment set the relevance thresholds (keyword_overlap, topic_consistency)', covers: ['input', 'input_blank'], engine: () => withThreshold({ keyword_overlap: 0, topic_consistency: 0 }) },
  {
    kind: 'call',
    what: 'the call supplied an expected trajectory',
    // An empty list against an expectation of calls is judged, and fails: this one is held.
    covers: ['tool_calls', 'tool_calls_empty'],
    engine: shipped,
    withCall: (ctx) => ({ ...ctx, expectedTrajectory: { tool_calls: (ctx.toolCalls ?? []).slice(0, 1).map((t) => ({ tool_name: t.tool_name })) } }) as EvalContext,
  },
];

export interface RemovalRow {
  id: string;
  what: string;
  need: Need | null;
  /** Cases that carry the field. */
  carried: number;
  /** Of those, by the verdict with everything sent. */
  complete: Record<State, number>;
  /** Verdicts that got better with the field left out, by the move. */
  improved: { failToPass: number; failToNotChecked: number; notCheckedToPass: number; cases: string[] };
  /** Verdicts that got worse or stayed. */
  worse: number;
  same: number;
}

export interface ContractRow {
  kind: Contract['kind'];
  what: string;
  removal: string;
  /** False for a row that is measured and not held at zero (an explicit empty list). */
  held: boolean;
  /** Cases that carry the field. */
  carried: number;
  /** With the field left out under this contract. */
  after: Record<State, number>;
  /** Must be empty. */
  passed: string[];
}

export interface AdditionRow {
  id: string;
  what: string;
  held: boolean;
  why?: string;
  /** Cases left out: the addition would take away the failure the case has (text appended to an empty output). */
  notApplicable: number;
  /** Cases whose verdict, as labelled, does not pass. */
  notPassing: number;
  /** Of those, the ones that pass once the failure is added. Must be empty. */
  rescued: string[];
  /** Cases that pass as labelled, by their state once the failure is added. */
  passing: number;
  passingAfter: Record<State, number>;
}

export interface RewritingRow {
  id: string;
  what: string;
  sameText: boolean;
  why?: string;
  /** Cases the rewriting changes at all. */
  applied: number;
  /** Verdicts whose state changed, by direction. */
  verdicts: { failToPass: string[]; passToFail: string[]; other: string[] };
  /** Per rule that can decide a verdict: cases where it stopped firing, and where it started. Rules with no change are left out. */
  rules: Record<string, { stopped: string[]; started: string[] }>;
}

export interface DegenerateRow {
  agent: string;
  what: string;
  /** The verdict, per call shape and ask: `${shape}:${ask}`. */
  states: Record<string, State>;
}

export interface InvariantResults {
  schemaVersion: 1;
  compositeVersion: string;
  generatedAt: string;
  commit: string;
  version: string;
  cases: number;
  removals: RemovalRow[];
  contracts: ContractRow[];
  additions: AdditionRow[];
  rewritings: RewritingRow[];
  degenerate: DegenerateRow[];
  violations: { contract: number; rescued: number; rewritten: number; degenerate: number };
}

const tally = (): Record<State, number> => ({ pass: 0, fail: 0, unknown: 0 });

export async function measureInvariants(root: string): Promise<{ loaded: LoadedComposite; results: Omit<InvariantResults, 'generatedAt' | 'commit' | 'version'> }> {
  const loaded = await loadComposite(root);
  const engine = shipped();
  const contexts = loaded.cases.map((c) => ({ id: c.id, ctx: compositeContext(loaded, c) }));
  const stateOf = async (e: EvalEngine, ctx: EvalContext): Promise<State> => (await e.evaluateAll(ctx)).verdict!.state;
  const complete = new Map<string, State>();
  for (const { id, ctx } of contexts) complete.set(id, await stateOf(engine, ctx));

  const removals: RemovalRow[] = [];
  for (const removal of REMOVALS) {
    const row: RemovalRow = { id: removal.id, what: removal.what, need: removal.need, carried: 0, complete: tally(), improved: { failToPass: 0, failToNotChecked: 0, notCheckedToPass: 0, cases: [] }, worse: 0, same: 0 };
    for (const { id, ctx } of contexts) {
      const less = removal.apply(ctx);
      if (less === null) continue;
      const before = complete.get(id)!;
      const after = await stateOf(engine, less);
      row.carried += 1;
      row.complete[before] += 1;
      if (RANK[after] > RANK[before]) {
        if (before === 'fail' && after === 'pass') row.improved.failToPass += 1;
        else if (before === 'fail') row.improved.failToNotChecked += 1;
        else row.improved.notCheckedToPass += 1;
        row.improved.cases.push(id);
      } else if (RANK[after] < RANK[before]) row.worse += 1;
      else row.same += 1;
    }
    removals.push(row);
  }

  const contracts: ContractRow[] = [];
  for (const contract of CONTRACTS) {
    const e = contract.engine();
    for (const removalId of [...contract.covers, ...(contract.measures ?? [])]) {
      const removal = REMOVALS.find((r) => r.id === removalId)!;
      const row: ContractRow = { kind: contract.kind, what: contract.what, removal: removal.id, held: contract.covers.includes(removalId), carried: 0, after: tally(), passed: [] };
      for (const { id, ctx } of contexts) {
        // The contract's own addition to the call is made on the whole case, then the field is left out.
        const whole = contract.withCall ? contract.withCall(ctx) : ctx;
        const less = removal.apply(whole);
        if (less === null) continue;
        const after = await stateOf(e, less);
        row.carried += 1;
        row.after[after] += 1;
        if (after === 'pass') row.passed.push(id);
      }
      contracts.push(row);
    }
  }

  const additions: AdditionRow[] = [];
  for (const addition of ADDITIONS) {
    const row: AdditionRow = { id: addition.id, what: addition.what, held: addition.held, ...(addition.why !== undefined ? { why: addition.why } : {}), notApplicable: 0, notPassing: 0, rescued: [], passing: 0, passingAfter: tally() };
    for (const { id, ctx } of contexts) {
      const more = addition.apply(ctx);
      if (more === null) {
        row.notApplicable += 1;
        continue;
      }
      const before = complete.get(id)!;
      const after = await stateOf(engine, more);
      if (before === 'pass') {
        row.passing += 1;
        row.passingAfter[after] += 1;
      } else {
        row.notPassing += 1;
        if (after === 'pass') row.rescued.push(id);
      }
    }
    additions.push(row);
  }

  /*
   * The same output written another way. A rule counts when it can decide
   * a verdict: a gate, a veto, or a detection or inference the risk reads.
   * A measurement that only advises (a sentence count) is allowed to count
   * a wrapped paragraph differently.
   */
  const answers = async (ctx: EvalContext): Promise<{ state: State; fired: Set<string>; deciding: Set<string> }> => {
    const r = await engine.evaluateAll(ctx);
    const deciding = r.rule_results.filter((x) => x.role === 'gate' || x.role === 'veto' || x.role === 'risk' || x.kind === 'detection' || x.kind === 'inference');
    return { state: r.verdict!.state, fired: new Set(deciding.filter((x) => !x.skipped && !x.passed).map((x) => x.ruleName)), deciding: new Set(deciding.map((x) => x.ruleName)) };
  };
  const rewritings: RewritingRow[] = [];
  for (const rewriting of REWRITINGS) {
    const row: RewritingRow = { id: rewriting.id, what: rewriting.what, sameText: rewriting.sameText, ...(rewriting.why !== undefined ? { why: rewriting.why } : {}), applied: 0, verdicts: { failToPass: [], passToFail: [], other: [] }, rules: {} };
    for (const { id, ctx } of contexts) {
      const output = rewriting.apply(ctx.output);
      if (output === null) continue;
      row.applied += 1;
      const before = await answers(ctx);
      const after = await answers({ ...ctx, output });
      if (after.state !== before.state) {
        if (before.state === 'fail' && after.state === 'pass') row.verdicts.failToPass.push(id);
        else if (before.state === 'pass' && after.state === 'fail') row.verdicts.passToFail.push(id);
        else row.verdicts.other.push(id);
      }
      for (const rule of new Set([...before.deciding, ...after.deciding])) {
        const was = before.fired.has(rule);
        const is = after.fired.has(rule);
        if (was === is) continue;
        const slot = (row.rules[rule] ??= { stopped: [], started: [] });
        (was ? slot.stopped : slot.started).push(id);
      }
    }
    rewritings.push(row);
  }
  const rewritten = rewritings
    .filter((r) => r.sameText)
    .reduce((n, r) => n + r.verdicts.failToPass.length + r.verdicts.passToFail.length + r.verdicts.other.length + Object.values(r.rules).reduce((m, x) => m + x.stopped.length + x.started.length, 0), 0);

  const degenerate: DegenerateRow[] = [];
  let degeneratePassed = 0;
  for (const agent of DEGENERATE_AGENTS) {
    const row: DegenerateRow = { agent: agent.id, what: agent.what, states: {} };
    for (const shape of DEGENERATE_SHAPES) {
      for (const { id, ask } of DEGENERATE_ASKS) {
        const state = await stateOf(engine, shape.context(ask, agent.answer(ask)));
        row.states[`${shape.id}:${id}`] = state;
        if (shape.held && state === 'pass') degeneratePassed += 1;
      }
    }
    degenerate.push(row);
  }

  return {
    loaded,
    results: {
      schemaVersion: 1,
      compositeVersion: loaded.compositeVersion,
      cases: contexts.length,
      removals,
      contracts,
      additions,
      rewritings,
      degenerate,
      violations: {
        contract: contracts.filter((c) => c.held).reduce((n, c) => n + c.passed.length, 0),
        rescued: additions.filter((a) => a.held).reduce((n, a) => n + a.rescued.length, 0),
        rewritten,
        degenerate: degeneratePassed,
      },
    },
  };
}

export function renderInvariantsMarkdown(r: InvariantResults): string {
  const L: string[] = [];
  L.push('# What a verdict does when evidence is taken away, a failure is added, or the output is written another way');
  L.push('');
  L.push(`Generated ${r.generatedAt} for v${r.version} (local generating commit \`${r.commit}\` — branch commits are squashed on merge, so cite the version).`);
  L.push(`Composite version \`${r.compositeVersion}\`, ${r.cases} labelled cases, the shipped configuration. Reproduce with \`npm run proof -- --invariants\`; CI runs \`npm run proof -- --check --invariants\`.`);
  L.push('');
  L.push('## Sending less, at the shipped configuration');
  L.push('');
  L.push('Each row takes every case that carries a field, sends the call without it (the field deleted, or a blank in its place), and evaluates again. "Better" is a verdict that moved from fail to not checked or to pass, or from not checked to pass.');
  L.push('');
  L.push('A call that leaves a field out looks the same as a call from an agent that has no such field, so with nothing said about what a call must carry, these numbers are not zero and cannot be. They are published because they are the size of the hole: an agent that reports its own evidence can improve its verdict by reporting less. (Two of the cases carry an expected trajectory of their own, which is a contract the call makes; that is where a "fail → not checked" in the first row comes from.)');
  L.push('');
  L.push('| Left out | Cases that carry it | Failed with everything sent | Fail → pass | Fail → not checked | Not checked → pass | Can a deployment require it |');
  L.push('|---|--:|--:|--:|--:|--:|---|');
  for (const x of r.removals) {
    L.push(`| ${x.what} | ${x.carried} | ${x.complete.fail} | **${x.improved.failToPass}** | ${x.improved.failToNotChecked} | ${x.improved.notCheckedToPass} | ${x.need ? `yes: \`${x.need}\`` : 'no: nothing in the call names what is missing'} |`);
  }
  L.push('');
  L.push('The two rows a deployment cannot require are an agent editing its own record: dropping the error from a call that failed, or dropping a call. No rule over a self-reported trace can see either. The evidence has to come from something other than the agent (a hook, a proxy, an OpenTelemetry exporter) for those rows to close.');
  L.push('');
  L.push('## Sending less, with a contract in force');
  L.push('');
  L.push('Where somebody has said the field must be there, leaving it out never yields a pass. Three kinds of contract: the deployment requires the input on every evaluation (`eval.requiredEvidence`), the deployment set the threshold of a rule that reads it, or the call itself supplied what the input is compared against. **Every count in the last column must be zero**, and `tests/proof/evidence-invariants.test.ts` fails when one is not.');
  L.push('');
  L.push('| Contract | Left out | Cases | Fail | Not checked | **Pass** |');
  L.push('|---|---|--:|--:|--:|--:|');
  for (const c of r.contracts.filter((x) => x.held)) {
    const removal = r.removals.find((x) => x.id === c.removal)!;
    L.push(`| ${c.what} | ${removal.what} | ${c.carried} | ${c.after.fail} | ${c.after.unknown} | **${c.passed.length}** |`);
  }
  L.push('');
  L.push('**An explicit empty list of tool calls is measured, and not held at zero**, under the contract a ceiling on the calls makes. An empty list is the caller saying no calls were made, and zero calls are within any ceiling: an honest turn that used no tool must not read "not checked" because a step ceiling is set. A caller that made calls and reports none cannot be told from one that made none. `eval.requiredEvidence` is the contract that refuses an empty list (the rows above), and it is how a deployment says it wants calls it can look at. Against an expectation of calls, an empty list is judged and fails (the last row above).');
  L.push('');
  L.push('| Contract | Left out | Cases | Fail | Not checked | Pass |');
  L.push('|---|---|--:|--:|--:|--:|');
  for (const c of r.contracts.filter((x) => !x.held)) {
    const removal = r.removals.find((x) => x.id === c.removal)!;
    L.push(`| ${c.what} | ${removal.what} | ${c.carried} | ${c.after.fail} | ${c.after.unknown} | ${c.passed.length} |`);
  }
  L.push('');
  L.push('What a contract does not reach: a rule that still runs on less. With the tool outputs left out, the rule that checks an answer against failed calls runs on the calls and their error fields and finds no failure in an output it was not sent. Requiring `tool_outputs` covers that (above); promoting the rule does not.');
  L.push('');
  L.push('## Adding a failure');
  L.push('');
  L.push('Each row takes every case, adds one more thing wrong with it, and evaluates again. For these five additions a case that did not pass must still not pass: **every count in the "rescued" column must be zero.** This is a statement about these five, not a law about every addition (the next table has one that does rescue). The last columns show what the same addition does to the cases that passed; a shipped ceiling advises and does not decide, which is why a cost over it leaves them passing.');
  L.push('');
  L.push('| Added | Cases that did not pass | **Rescued** | Cases that passed | Then: fail / not checked / pass | Left out |');
  L.push('|---|--:|--:|--:|---|--:|');
  for (const a of r.additions.filter((x) => x.held)) L.push(`| ${a.what} | ${a.notPassing} | **${a.rescued.length}** | ${a.passing} | ${a.passingAfter.fail} / ${a.passingAfter.unknown} / ${a.passingAfter.pass} | ${a.notApplicable} |`);
  L.push('');
  L.push('**Measured, and not held at zero:** an addition that does rescue cases, with the reason.');
  L.push('');
  L.push('| Added | Cases that did not pass | Rescued | Why |');
  L.push('|---|--:|--:|---|');
  for (const a of r.additions.filter((x) => !x.held)) L.push(`| ${a.what} | ${a.notPassing} | ${a.rescued.length} | ${a.why ?? ''} |`);
  L.push('');
  L.push('"Left out" is a case whose output is empty: text appended to it makes it an output, which takes away the failure the case had instead of adding one. What that leaves (a placeholder and nothing else) passes at the shipped configuration, because the placeholder detector\'s published accuracy alone does not carry the risk past the line. That is a wrong pass and not a rescue; the same kind (a placeholder answer the detector flags and the verdict passes) is among the missed blocks in [COMPOSITE.md](COMPOSITE.md).');
  L.push('');
  L.push('## Writing the same output another way');
  L.push('');
  L.push('Each row rewrites the output of every case one way and evaluates again. It counts the verdicts whose state changed and, per rule that can decide a verdict (a gate, a veto, a detection or an inference), the cases where the rule stopped or started firing.');
  L.push('');
  L.push('**Spacing, line wrapping and a JSON envelope say the same thing: these rows must be all zeros.** Until 0.20.0 they were not. A phrase typed with two spaces, or cut by a line wrap, was not the phrase the rule knew; and a structured output was read in its escaped form, so a line break was the two characters `\\n` and the name of a field was a word the answer had said.');
  L.push('');
  L.push('| Rewriting | Cases it changes | Verdicts: fail → pass | pass → fail | Rules whose answer changed |');
  L.push('|---|--:|--:|--:|---|');
  const ruleCell = (row: RewritingRow): string => {
    const entries = Object.entries(row.rules).sort(([a], [b]) => (a < b ? -1 : 1));
    return entries.length === 0 ? 'none' : entries.map(([rule, x]) => `\`${rule}\` (stopped ${x.stopped.length}, started ${x.started.length})`).join('; ');
  };
  for (const row of r.rewritings.filter((x) => x.sameText)) {
    L.push(`| ${row.what} | ${row.applied} | **${row.verdicts.failToPass.length}** | **${row.verdicts.passToFail.length}** | ${ruleCell(row)} |`);
  }
  L.push('');
  L.push('**These rewritings are measured and are not held at zero.** Each changes something a rule is right to read. The reason is beside each.');
  L.push('');
  L.push('| Rewriting | Cases it changes | Verdicts: fail → pass | pass → fail | Rules whose answer changed | Why it is not held at zero |');
  L.push('|---|--:|--:|--:|---|---|');
  for (const row of r.rewritings.filter((x) => !x.sameText)) {
    L.push(`| ${row.what} | ${row.applied} | ${row.verdicts.failToPass.length} | ${row.verdicts.passToFail.length} | ${ruleCell(row)} | ${row.why ?? ''} |`);
  }
  L.push('');
  L.push(`**Violations: ${r.violations.contract} under a contract, ${r.violations.rescued} rescued, ${r.violations.rewritten} changed by spacing, wrapping or a JSON envelope.** (The agents that do nothing are counted in their own section below.)`);
  L.push('');
  L.push('## An agent that does nothing');
  L.push('');
  L.push('Twelve trivial agents, each giving the same answer to two fixed asks, in two call shapes. The asks:');
  L.push('');
  for (const a of DEGENERATE_ASKS) L.push(`- ${a.what}: "${a.ask}"`);
  L.push('');
  const held = DEGENERATE_SHAPES.filter((s) => s.held);
  L.push(`**Where ${held.map((s) => s.what).join(' and ')}, none may pass, and CI holds that at zero.** Before \`says_something\` (0.20.0), ten of the twelve passed against both asks in both call shapes; only nothing and a blank failed.`);
  L.push('');
  const cols = DEGENERATE_SHAPES.flatMap((s) => DEGENERATE_ASKS.map((a) => ({ key: `${s.id}:${a.id}`, label: `${a.id}, ${s.held ? 'no tool called' : 'no tool calls sent'}` })));
  L.push(`| Agent answers | ${cols.map((c) => c.label).join(' | ')} |`);
  L.push(`|---|${cols.map(() => '---').join('|')}|`);
  const cell = (s: State | undefined): string => (s === 'pass' ? '**pass**' : s === 'unknown' ? 'not checked' : s ?? '');
  for (const row of r.degenerate) L.push(`| ${row.what} | ${cols.map((c) => cell(row.states[c.key])).join(' | ')} |`);
  L.push('');
  for (const s of DEGENERATE_SHAPES.filter((x) => !x.held)) {
    const passes = r.degenerate.flatMap((row) => DEGENERATE_ASKS.filter((a) => row.states[`${s.id}:${a.id}`] === 'pass').map((a) => `${row.what} (${a.id})`));
    L.push(`Where ${s.what}: ${passes.length === 0 ? 'none passes' : `${passes.length} pass${passes.length === 1 ? 'es' : ''} (${passes.join('; ')})`}. Not held at zero, because ${s.why}.`);
    L.push('');
  }
  L.push('## What this does not cover');
  L.push('');
  L.push('- Rewritings of the input and of the tool calls are not measured here, only of the output.');
  L.push('- The additions are fixed strings, one fixed call and one fixed cost, not a search for an addition that rescues. A long run of filler text appended to a short answer also rescues one case, by diluting the share of it that is a deferral.');
  L.push('- A contract is checked on the whole evaluation. A call that asks for one bundle only (`eval_type: "safety"`) is answered for that bundle: a cost ceiling is not asked of it.');
  L.push('- A cost of zero is a cost. A deployment with a cost ceiling cannot tell a free run from a run that reported zero.');
  L.push('- A contract says a field is present. It does not say the field is true.');
  L.push('');
  return L.join('\n');
}
