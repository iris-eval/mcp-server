/*
 * An AgentDojo run log, read as the trace Iris would have been given.
 *
 * AgentDojo (github.com/ethz-spylab/agentdojo, MIT) publishes the full
 * message log of every run in its benchmark: the user's task, each tool
 * call with its arguments and the tool's output, and the agent's final
 * answer. Beside each log are two booleans its environment computed by
 * inspecting the world after the run, never by reading the text:
 *
 *   utility   the user's task was done
 *   security  the attacker's goal was done (true = the attack succeeded)
 *
 * Iris did not write these runs, did not choose the tasks, and did not
 * label them. That is what makes them the first proof row that is not ours.
 *
 * The mapping is the one a capture integration would make, no more:
 *   input       the user's message (the system prompt is the harness's, not the ask)
 *   tool_calls  every call, in order, paired with the tool message that
 *               answered it by id; the output is the text the agent read
 *   output      the agent's last message's text
 * The log holds every call in full, so the record declares its tool calls
 * and their outputs complete, as a capture source that records every call
 * would.
 */
import type { EvalContext } from '../../src/types/eval.js';
import type { ToolCallRecord } from '../../src/types/trace.js';

/** The fields of a run log this reader uses. */
export interface AgentDojoRun {
  suite_name: string;
  pipeline_name: string;
  user_task_id: string;
  injection_task_id: string | null;
  attack_type: string | null;
  utility: boolean;
  security: boolean;
  error?: string | null;
  messages: AgentDojoMessage[];
}

export interface AgentDojoMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: Array<{ function: string; args?: Record<string, unknown>; id?: string | null }> | null;
  tool_call_id?: string | null;
  tool_call?: { function: string; args?: Record<string, unknown>; id?: string | null } | null;
  error?: string | null;
}

/** Message content as text: older logs carry a string, newer ones a list of blocks. */
export function textOf(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as { content?: unknown; text?: unknown };
          if (typeof b.content === 'string') return b.content;
          if (typeof b.text === 'string') return b.text;
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return String(content);
}

/** The capture declaration every converted run carries: the log records each call and its output in full. */
export const AGENTDOJO_CAPTURE = { name: 'agentdojo-run-log', complete: ['input', 'tool_calls', 'tool_outputs'] } as const;

/** One run as the EvalContext evaluate_output would receive for it. */
export function contextOfRun(run: AgentDojoRun): EvalContext {
  const user = run.messages.find((m) => m.role === 'user');
  const input = user ? textOf(user.content) : '';

  const calls: ToolCallRecord[] = [];
  const byId = new Map<string, ToolCallRecord>();
  const unanswered: ToolCallRecord[] = [];
  for (const m of run.messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const record: ToolCallRecord = { tool_name: tc.function, input: tc.args ?? {} };
        if (tc.id) {
          record.call_id = tc.id;
          byId.set(tc.id, record);
        }
        calls.push(record);
        unanswered.push(record);
      }
    } else if (m.role === 'tool') {
      const id = m.tool_call?.id ?? m.tool_call_id ?? null;
      // By id when the log carries one; otherwise the oldest call still waiting, which is how the log orders them.
      const record = (id !== null && byId.get(id)) || unanswered[0];
      if (!record) continue;
      const at = unanswered.indexOf(record);
      if (at >= 0) unanswered.splice(at, 1);
      record.output = textOf(m.content);
      if (m.error) record.error = m.error;
    }
  }

  const last = [...run.messages].reverse().find((m) => m.role === 'assistant');
  return {
    input,
    output: last ? textOf(last.content) : '',
    toolCalls: calls,
    recordedBy: 'harness',
    capture: { name: AGENTDOJO_CAPTURE.name, complete: [...AGENTDOJO_CAPTURE.complete] },
  };
}
