/*
 * The server instructions — the frame an agent reads at connection,
 * before it lists a single tool.
 *
 * Built at boot from runtime state (the rule count and bundles from the
 * registry, the effective critical list from the engine, the judge state
 * from this process's environment), so the string is true for this
 * server, not for a documented default. Locked by
 * tests/integration/mcp-protocol.test.ts: non-empty, names only tools and
 * resources that are registered, quotes the effective critical list, and
 * stays under the ceiling. The same template renders the
 * `evaluate-my-agent` prompt so the two cannot drift.
 */
import type { JudgeState } from './judge-enablement.js';
import { JUDGE_KEY_VARS, judgeStateLine } from './judge-enablement.js';

/*
 * 2,600 until 0.13.0. The WHEN paragraph below is the highest-leverage text
 * in the product — it is what turns a registered server into a used one —
 * and it earns about a hundred tokens on every session.
 */
export const INSTRUCTIONS_MAX_CHARS = 3000;

export interface InstructionsInput {
  ruleCount: number;
  categories: readonly string[];
  threshold: number;
  critical: readonly string[];
  judge: JudgeState;
}

function prose(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function buildInstructions(i: InstructionsInput): string {
  const judgeHowTo = i.judge.enabled
    ? 'They spend your key, never a shared one; the cap is refused before any spend.'
    : `To enable them, put your own ${JUDGE_KEY_VARS.anthropic} or ${JUDGE_KEY_VARS.openai} in the env block of the iris-eval entry in your MCP client config and restart the session; iris://capabilities carries the full steps.`;
  const critical = i.critical.length > 0 ? i.critical.join(', ') : 'none';
  const text = [
    'Iris evaluates what an AI agent wrote and what it did. It runs locally, stores traces and verdicts in SQLite, and sends nothing anywhere unless you enable the judge or set an OTel endpoint.',

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

    `The LLM judge (evaluate_with_llm_judge) and the citation verifier (verify_citations) are ${judgeStateLine(i.judge)}. ${judgeHowTo}`,

    'Resources: iris://capabilities (what this server can judge, each rule\'s needs, judge state, limits), iris://proof (precision and recall per rule, with intervals), iris://traces/{trace_id}, iris://evaluations/{id}, iris://dashboard/summary. Responses link what they created.',

    'Do not use Iris to validate arbitrary JSON Schema, to screen inputs before they reach an agent (the injection rule reads output), or for semantic judgment without a key.',

    'Errors from a tool return {"error":{"code","message","recovery":[]}} with isError true; follow recovery before retrying. ' +
      'An argument the schema rejects comes back as plain text naming IRIS_INVALID_ARGUMENT and the valid arguments.',
  ].join('\n\n');
  if (text.length > INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`instructions are ${text.length} characters; the ceiling is ${INSTRUCTIONS_MAX_CHARS}`);
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
