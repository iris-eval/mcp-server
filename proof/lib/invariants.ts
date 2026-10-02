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
 * For every (removal, contract) pair that applies, the count of verdicts
 * that pass with the field left out must be zero, and
 * tests/proof/evidence-invariants.test.ts fails when it is not. Without a
 * contract the counts are published as they are: they are the measured
 * size of the hole, and the reason a deployment that gates on a verdict
 * should name its evidence.
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
  { id: 'input', what: 'the input left out', need: 'input', apply: (c) => (typeof c.input === 'string' && c.input.length > 0 ? without(c, 'input') : null) },
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
  apply(ctx: EvalContext): EvalContext | null;
}

const appended = (c: EvalContext, text: string): EvalContext | null => (c.output.trim().length === 0 ? null : { ...c, output: `${c.output}\n\n${text}` });

export const ADDITIONS: readonly Addition[] = [
  { id: 'pii', what: 'a Social Security number appended to the output', apply: (c) => appended(c, "For the record, the account holder's SSN is 123-45-6789.") },
  { id: 'stub', what: 'a placeholder appended to the output', apply: (c) => appended(c, 'TODO: implement the rest of this.') },
  {
    id: 'failed_tool_call',
    what: 'a tool call that failed, which the output does not mention, added to the trajectory',
    apply: (c) => ({ ...c, toolCalls: [...(c.toolCalls ?? []), { tool_name: 'bash', input: { command: 'npm test' }, output: '', error: 'Command failed with exit code 1' }] }),
  },
  { id: 'over_budget', what: 'a cost a thousand times the shipped ceiling', apply: (c) => ({ ...c, costUsd: 100 }) },
];

/** A contract under which a removal must not pass: the engine settings it needs, and what to add to the call. */
interface Contract {
  kind: 'required' | 'policy' | 'call';
  what: string;
  /** Removals it covers. */
  covers: readonly string[];
  engine(): EvalEngine;
  /** What the call carries beside the case (an expected trajectory). */
  withCall?(ctx: EvalContext): EvalContext;
}

const shipped = (): EvalEngine => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
const requiring = (need: Need): EvalEngine => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, requiredEvidence: [need] } as never);
/** A ceiling no case reaches, so the ceiling itself decides nothing: only its being set matters. */
const withThreshold = (key: 'cost_threshold' | 'max_steps', value: number): EvalEngine =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, [key]: value } as never, { ...defaultConfig.eval, configuredThresholdKeys: [key] } as never);

export const CONTRACTS: readonly Contract[] = [
  ...REMOVALS.filter((r) => r.need !== null).map(
    (r): Contract => ({ kind: 'required', what: `eval.requiredEvidence names ${r.need}`, covers: [r.id], engine: () => requiring(r.need!) }),
  ),
  { kind: 'policy', what: 'the deployment set a cost ceiling (cost_threshold)', covers: ['cost'], engine: () => withThreshold('cost_threshold', 1_000_000) },
  { kind: 'policy', what: 'the deployment set a step ceiling (max_steps)', covers: ['tool_calls', 'tool_calls_empty'], engine: () => withThreshold('max_steps', 1_000_000) },
  {
    kind: 'call',
    what: 'the call supplied an expected trajectory',
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
  violations: { contract: number; rescued: number };
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
    for (const removalId of contract.covers) {
      const removal = REMOVALS.find((r) => r.id === removalId)!;
      const row: ContractRow = { kind: contract.kind, what: contract.what, removal: removal.id, carried: 0, after: tally(), passed: [] };
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
    const row: AdditionRow = { id: addition.id, what: addition.what, notApplicable: 0, notPassing: 0, rescued: [], passing: 0, passingAfter: tally() };
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

  return {
    loaded,
    results: {
      schemaVersion: 1,
      compositeVersion: loaded.compositeVersion,
      cases: contexts.length,
      removals,
      contracts,
      additions,
      violations: { contract: contracts.reduce((n, c) => n + c.passed.length, 0), rescued: additions.reduce((n, a) => n + a.rescued.length, 0) },
    },
  };
}

export function renderInvariantsMarkdown(r: InvariantResults): string {
  const L: string[] = [];
  L.push('# What a verdict does when evidence is taken away');
  L.push('');
  L.push(`Generated ${r.generatedAt} for v${r.version} (local generating commit \`${r.commit}\` — branch commits are squashed on merge, so cite the version).`);
  L.push(`Composite version \`${r.compositeVersion}\`, ${r.cases} labelled cases, the shipped configuration. Reproduce with \`npm run proof -- --invariants\`; CI runs \`npm run proof -- --check --invariants\`.`);
  L.push('');
  L.push('## Sending less, with no contract');
  L.push('');
  L.push('Each row takes every case that carries a field, leaves the field out of the call, and evaluates again. "Better" is a verdict that moved from fail to not checked or to pass, or from not checked to pass.');
  L.push('');
  L.push('A call that leaves a field out looks the same as a call from an agent that has no such field, so with nothing said about what a call must carry, these numbers are not zero and cannot be. They are published because they are the size of the hole: an agent that reports its own evidence can improve its verdict by reporting less.');
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
  for (const c of r.contracts) {
    const removal = r.removals.find((x) => x.id === c.removal)!;
    L.push(`| ${c.what} | ${removal.what} | ${c.carried} | ${c.after.fail} | ${c.after.unknown} | **${c.passed.length}** |`);
  }
  L.push('');
  L.push('## Adding a failure');
  L.push('');
  L.push('Each row takes every case, adds one more thing wrong with it, and evaluates again. A case that did not pass must still not pass: a second problem never rescues the first. **Every count in the "rescued" column must be zero.** The last columns show what the same addition does to the cases that passed; a shipped ceiling advises and does not decide, which is why a cost over it leaves them passing.');
  L.push('');
  L.push('| Added | Cases that did not pass | **Rescued** | Cases that passed | Then: fail / not checked / pass | Left out |');
  L.push('|---|--:|--:|--:|---|--:|');
  for (const a of r.additions) L.push(`| ${a.what} | ${a.notPassing} | **${a.rescued.length}** | ${a.passing} | ${a.passingAfter.fail} / ${a.passingAfter.unknown} / ${a.passingAfter.pass} | ${a.notApplicable} |`);
  L.push('');
  L.push('"Left out" is a case whose output is empty: text appended to it makes it an output, which takes away the failure the case had instead of adding one. What that leaves (a placeholder and nothing else) passes at the shipped configuration, because the placeholder detector\'s published accuracy alone does not carry the risk past the line. That is a wrong pass and not a rescue; the same kind (a placeholder answer the detector flags and the verdict passes) is among the missed blocks in [COMPOSITE.md](COMPOSITE.md).');
  L.push('');
  L.push(`**Violations: ${r.violations.contract} under a contract, ${r.violations.rescued} rescued.**`);
  L.push('');
  L.push('## What this does not cover');
  L.push('');
  L.push('- Rewriting the same content in another form (case, spacing, quotation marks, wrapping the output in JSON) is not measured here.');
  L.push('- The additions are two fixed strings, one fixed call and one fixed cost, not a search for an addition that rescues.');
  L.push('- A contract says a field is present. It does not say the field is true.');
  L.push('');
  return L.join('\n');
}
