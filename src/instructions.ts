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

export const INSTRUCTIONS_MAX_CHARS = 2600;

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
    'Iris evaluates what an AI agent wrote and what it did. It runs locally, stores traces and verdicts in SQLite, and sends nothing anywhere unless you enable the judge.',

    `Three verbs. LOG an execution with log_trace (input, output, tool_calls, cost). EVALUATE with evaluate_output: ${i.ruleCount} deterministic rules in ${prose(i.categories)}. ` +
      'Pass input so the relevance and hallucination rules can judge; pass tool_calls or a trace_id so the trajectory rules can judge; pass cost_usd so the cost rules can judge. ' +
      'A rule with nothing to judge SKIPS and is named; it is never counted as a pass. INSPECT with get_traces and list_rules, or read a resource.',

    `Reading a verdict. passed is the ship verdict: true only when score clears the threshold (${i.threshold} on this server) AND no critical rule failed. ` +
      'verdict.basis says which layer decided (policy_gate, detector_veto, score_below_threshold, clean, or no_rules when nothing could be judged) and verdict.by names the rules. ' +
      `Critical on this server: ${critical} (configurable; list_rules shows the effective value). ` +
      'coverage says which evaluation questions were judged and why the others were not. A critical rule that could not judge is named in critical_skipped: treat that as UNKNOWN, not clean. ' +
      'score is a quality gradient over the rules that ran; never read it alone as a safety signal.',

    `The LLM judge (evaluate_with_llm_judge) and the citation verifier (verify_citations) are ${judgeStateLine(i.judge)}. ${judgeHowTo}`,

    'Resources: iris://capabilities (what this server can judge, what each rule needs, judge state, limits), iris://proof (measured precision and recall per rule with 95% intervals), ' +
      'iris://traces/{trace_id}, iris://evaluations/{id}, iris://dashboard/summary. Responses link what they created.',

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
    '2. Log each run with log_trace, then evaluate it with evaluate_output, passing input, tool_calls (or the trace_id) and cost_usd whenever you have them so the relevance, trajectory and cost rules can judge.',
    '3. Read the verdict: passed is the ship verdict; verdict.basis and verdict.by say which rule decided; coverage says what was not judged and why; critical_skipped means UNKNOWN, not clean.',
    '4. For anything that failed, follow the resource link to iris://evaluations/{id} and quote the rule, its message and its evidence (offsets into my output, never a paraphrase of what the rule matched).',
    '5. Tell me: what passed, what failed and why, what was not judged and what input would let Iris judge it. If I ask for a semantic judgment and the judge is not enabled, give me the recovery steps from the error instead of searching for them.',
  ].join('\n');
}
