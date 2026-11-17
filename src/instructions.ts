/*
 * The server instructions — the frame an agent reads at connection,
 * before it lists a single tool.
 *
 * Built at boot from runtime state (the rule count and bundles from the
 * registry, the effective critical list from the engine, the judge state
 * from this process's environment), so the string is true for this
 * server, not for a documented default. Locked by
 * tests/integration/response-schema.test.ts (non-empty, names only tools
 * and resources that are registered, quotes the effective critical list,
 * and stays under the ceiling at the shipped list) and by
 * tests/unit/instructions.test.ts (every list a config can make builds).
 * The same template renders the
 * `evaluate-my-agent` prompt so the two cannot drift.
 */
import type { JudgeState } from './judge-enablement.js';
import { JUDGE_KEY_VARS, judgeStateLine } from './judge-enablement.js';
import type { RelevanceJudgeState } from './eval/llm-judge/relevance-judge.js';

/*
 * 2,600 until 0.13.0. The WHEN paragraph below is the highest-leverage text
 * in the product — it is what turns a registered server into a used one —
 * and it earns about a hundred tokens on every session.
 *
 * The ceiling is on the text this build writes. The critical list quoted in
 * it is the deployment's (eval.criticalRules adds names to it), so its
 * length is not this build's to bound, and it is left out of what the
 * ceiling measures. Until 0.22.0 it was counted, and the text ran close
 * enough to the ceiling that one promoted rule put it over: a server whose
 * config promoted a rule refused to start. A list is quoted in full up to
 * CRITICAL_LIST_MAX_CHARS, and past that cut at a whole name with the rest
 * counted, so no list can make a server unstartable either.
 */
export const INSTRUCTIONS_MAX_CHARS = 3000;

/** The most characters of the critical list the instructions quote. */
export const CRITICAL_LIST_MAX_CHARS = 400;

/**
 * The effective critical list as the instructions quote it: every name
 * while they fit in CRITICAL_LIST_MAX_CHARS, else whole names up to there
 * and a count of the rest. The sentence it sits in says where the
 * effective list is read.
 */
export function criticalListText(names: readonly string[]): string {
  if (names.length === 0) return 'none';
  const full = names.join(', ');
  if (full.length <= CRITICAL_LIST_MAX_CHARS) return full;
  // Room is kept for the longest count this list could need.
  const room = CRITICAL_LIST_MAX_CHARS - ` and ${names.length} more`.length;
  const shown: string[] = [];
  let length = 0;
  for (const name of names) {
    const next = length + (shown.length > 0 ? 2 : 0) + name.length;
    if (next > room) break;
    shown.push(name);
    length = next;
  }
  return shown.length === 0 ? `${names.length} rules` : `${shown.join(', ')} and ${names.length - shown.length} more`;
}

export interface InstructionsInput {
  ruleCount: number;
  categories: readonly string[];
  threshold: number;
  critical: readonly string[];
  judge: JudgeState;
  /** The relevance judge answers_the_ask gates on; said only when one is installed, since without it nothing about the call changes. */
  relevanceJudge?: RelevanceJudgeState;
}

function prose(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function buildInstructions(i: InstructionsInput): string {
  const judgeHowTo = i.judge.enabled
    ? 'They spend your key, never a shared one; the cap is refused before any spend.'
    : `To enable them, put your own ${JUDGE_KEY_VARS.anthropic} or ${JUDGE_KEY_VARS.openai} in the env block of the iris-eval entry in your MCP client config and restart the session; iris://capabilities carries the full steps.`;
  const critical = criticalListText(i.critical);
  const text = [
    'Iris evaluates what an AI agent wrote and what it did. It runs locally, stores traces and verdicts in SQLite, and sends nothing anywhere unless you enable the judge, OTel export or a webhook.',

    /*
     * WHEN, before WHAT. Until 0.13.0 this text described three verbs and
     * left the model to decide whether any of them applied; the stranger
     * harness showed an agent that connects, lists the tools and never
     * calls one unless the user names Iris. A policy, not a reflex: not
     * every line, the outputs that matter.
     */
    'WHEN to use it. After you produce an answer the user will act on, after you finish a task that used tools, and before you tell anyone a run was clean: call log_trace with input, output, tool_calls (and tools, your tools/list result), cost_usd if known, and evaluate: true. Read verdict.basis and interpretations before you report. Do not log every line; log the outputs that matter.',

    `Three verbs. LOG an execution with log_trace (evaluate: true scores it in the same call). EVALUATE a stored one with evaluate_output: ${i.ruleCount} deterministic rules in ${prose(i.categories)}. ` +
      'input feeds the relevance and hallucination rules; tool_calls (or a trace_id) the trajectory rules; cost_usd the cost rules. ' +
      'A rule with nothing to judge SKIPS and is named; it is never counted as a pass. INSPECT with get_traces, list_rules and compare_runs, or read a resource.',

    'Reading a verdict. passed is verdict.state === "pass": the composer decides by kind; score is never consulted. ' +
      'verdict.basis says which layer decided (policy_gate, detector_veto, critical_unknown, required_evidence_missing, risk_over_loss, clean, or no_rules when nothing could be judged) and verdict.by names the rules. ' +
      `Critical on this server: ${critical} (configurable; list_rules shows the effective value). ` +
      'interpretations[] says why a rule that failed did not decide and which setting would change that, and names any question not judged with the input that would let it be. coverage says which questions were judged. A critical rule that could not judge is named in critical_skipped: treat that as UNKNOWN, not clean. ' +
      'score is a quality gradient over the rules that ran; never read it alone as a safety signal.',

    `The LLM judge (evaluate_with_llm_judge) and the citation verifier (verify_citations) are ${judgeStateLine(i.judge)}. ${judgeHowTo}` +
      // Said only with a key present: without one the judge cannot run at all, and the sentence above already says how to enable it.
      (i.judge.enabled && i.relevanceJudge?.configured
        ? i.relevanceJudge.ready
          ? ` answers_the_ask asks the relevance judge (${i.relevanceJudge.model}) whenever input is present, and gates on it; ${i.relevanceJudge.redact ? 'redacted' : 'UNREDACTED'} text goes to its provider.`
          : ' A relevance judge is configured and cannot be called; see iris://capabilities.'
        : ''),

    'Resources: iris://capabilities (what this server can judge, each rule\'s needs, judge state, limits), iris://proof (precision and recall per rule, with intervals), iris://traces/{trace_id}, iris://evaluations/{id}, iris://dashboard/summary, iris://audit. Responses link what they created.',

    'Do not use Iris to validate arbitrary JSON Schema, to screen inputs before they reach an agent (the injection rule reads output), or for semantic judgment without a key.',

    'Errors from a tool return {"error":{"code","message","recovery":[]}} with isError true; follow recovery before retrying. ' +
      'An argument the schema rejects comes back as plain text naming IRIS_INVALID_ARGUMENT and the valid arguments.',
  ].join('\n\n');
  // What this build wrote, without the deployment's list: a breach here is a defect in the text above, never in a config.
  const own = text.length - critical.length;
  if (own > INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`instructions are ${own} characters without the critical list; the ceiling is ${INSTRUCTIONS_MAX_CHARS}`);
  }
  return text;
}

export const EVALUATE_MY_AGENT_PROMPT = 'evaluate-my-agent';

/**
 * The prompt a client shows as a slash command: a walk of log → evaluate →
 * read → explain, in plain words, carrying the version so a cached copy
 * cannot outlive a bump. Rendered from the same facts as the instructions.
 */
export function evaluateMyAgentPrompt(what: 'output' | 'trace-file', version: string): string {
  const source =
    what === 'trace-file'
      ? 'Read the trace file I point you at (a JSON object or array with input, output and tool_calls per run).'
      : 'Take the agent output I give you, with the input that produced it and the tool calls if I have them.';
  return [
    `Evaluate my agent with Iris ${version}. Do these steps and report in plain words.`,
    `1. ${source}`,
    '2. Log each run with log_trace and evaluate: true, passing input, tool_calls, tools and cost_usd whenever you have them so the relevance, trajectory and cost rules can judge; evaluate_output with a trace_id re-scores a stored run.',
    '3. Read the verdict: passed is the ship verdict; verdict.basis and verdict.by say which layer and rules decided; interpretations says why a failed rule did not decide and what was not judged; critical_skipped means UNKNOWN, not clean.',
    '4. For anything that failed, follow the resource link to iris://evaluations/{id} and quote the rule, its message and its evidence (offsets into my output, never a paraphrase of what the rule matched).',
    '5. Tell me: what passed, what failed and why, what was not judged and what input would let Iris judge it. If I ask for a semantic judgment and the judge is not enabled, give me the recovery steps from the error instead of searching for them.',
  ].join('\n');
}
