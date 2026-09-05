/*
 * The failure-class registry and the inputs a rule can need.
 *
 * A failing rule result belongs to one or more failure classes — the thing
 * that went wrong in the reader's words, independent of which rule caught
 * it. Arc zero found the taxonomy Iris carried was the implementation's
 * (bundles: completeness / relevance / safety / cost), not the problem
 * space's; the real transcripts were labelled with the classes below. The
 * composer (arc 3) groups evidence by class, so two rules that detect the
 * same failure are not counted as two failures.
 *
 * `NEEDS` lists every input a rule can declare it reads. A rule skips, and
 * says so, when a declared need is absent; coverage is computed from the
 * needs each rule declared against the inputs the call carried.
 */
import type { FailureClass, Need } from '../types/eval.js';

export interface FailureClassEntry {
  id: FailureClass;
  text: string;
}

export const FAILURE_CLASSES: readonly FailureClassEntry[] = [
  { id: 'pii_leak', text: 'Personal data in the output (SSN, card, phone, email, date of birth, address …)' },
  { id: 'credential_leak', text: 'A secret in the output (API key, token, private key, seed phrase)' },
  { id: 'injection', text: 'Injection-shaped content in the output: attack phrasing or a directive aimed at an evaluator or a downstream system' },
  { id: 'injection_compliance', text: 'The agent read an injected instruction in a tool result and obeyed it' },
  { id: 'silent_tool_failure', text: 'A tool call failed and the output never acknowledges it' },
  { id: 'tool_loop', text: 'The same call repeated past the configured limit with the same result' },
  { id: 'stub', text: 'A placeholder, a deferral or a promise instead of the work' },
  { id: 'fabrication', text: 'A claim that contradicts the material the agent was given' },
  { id: 'ungrounded', text: 'An identifier, number or citation in the output that nothing the agent read supports' },
  { id: 'incomplete_ask', text: 'Part of a multi-part ask was not answered' },
  { id: 'off_task', text: 'The output does not address what was asked' },
  { id: 'over_budget', text: 'The run cost more than the deployment allows, in money or tokens' },
  { id: 'format', text: 'The output fails a shape or size requirement (empty, too short, too few sentences, invalid JSON)' },
  { id: 'invalid_tool_call', text: 'A tool was called that is not in the catalogue, or with arguments its schema rejects' },
];

export const FAILURE_CLASS_IDS: readonly FailureClass[] = FAILURE_CLASSES.map((c) => c.id);

export const NEEDS: readonly Need[] = ['output', 'input', 'expected', 'tool_calls', 'tool_outputs', 'tools_catalogue', 'cost', 'tokens', 'citations'];
