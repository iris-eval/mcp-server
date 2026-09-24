/*
 * A model's family.
 *
 * A judge that shares a family with the agent it judges is not an
 * independent reader: the two were trained on the same data with the same
 * preferences, so the judge tends to forgive the agent's characteristic
 * errors and to reward its characteristic style. The measurement is not
 * wrong, but it is narrower than it looks, and the response should say
 * so. The family is read from the id's leading token — the part before
 * the version — because that is what the providers themselves vary the
 * least across a lineage, and because the pricing table does not know
 * every id an agent might run on.
 */

import type { IrisWarningCode } from '../../tools/errors.js';

const FAMILIES: ReadonlyArray<{ family: string; matches: RegExp }> = [
  { family: 'claude', matches: /^claude([-_.]|$)/i },
  { family: 'gpt', matches: /^(gpt|chatgpt)([-_.\d]|$)/i },
  { family: 'o-series', matches: /^o\d([-_.]|$)/i },
  { family: 'gemini', matches: /^gemini([-_.]|$)/i },
  { family: 'llama', matches: /^(meta-)?llama([-_.\d]|$)/i },
  { family: 'mistral', matches: /^(mistral|mixtral|codestral|ministral)([-_.]|$)/i },
  { family: 'deepseek', matches: /^deepseek([-_.]|$)/i },
  { family: 'qwen', matches: /^qwen([-_.\d]|$)/i },
  { family: 'grok', matches: /^grok([-_.]|$)/i },
  { family: 'command', matches: /^command([-_.]|$)/i },
];

/**
 * The family a model id belongs to, or null when the id says nothing a
 * reader would recognise. A provider prefix (`anthropic/claude-…`,
 * `openai:gpt-…`, `us.anthropic.claude-…`) is stripped before matching;
 * the OpenAI o-series is its own family because "gpt-4o" and "o1" are
 * different lineages despite the shared letter.
 */
export function modelFamily(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (trimmed === '') return null;
  // Strip a provider prefix: "anthropic/claude-x", "openai:gpt-x", "us.anthropic.claude-x", "models/gemini-x".
  const bare = trimmed
    .replace(/^[a-z0-9-]+[/:]/i, '')
    .replace(/^(?:[a-z]{2}\.)?(?:anthropic|openai|google|meta|mistralai|deepseek-ai)\./i, '')
    .replace(/^models\//i, '');
  for (const f of FAMILIES) if (f.matches.test(bare)) return f.family;
  return null;
}

/** True when both ids resolve to the same known family. Unknown on either side is never "same". */
export function sameFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  const fa = modelFamily(a);
  const fb = modelFamily(b);
  return fa !== null && fb !== null && fa === fb;
}

/** The keys a trace or a span records the agent's model under, in the order they are read. */
export const AGENT_MODEL_KEYS = ['model', 'gen_ai.request.model', 'gen_ai.response.model', 'llm.model', 'model_name'] as const;

/**
 * The model that produced a stored trace, when the trace says: first its
 * metadata, then any span's attributes, under the keys above. Null when
 * nothing recorded it — the caller can still pass `agent_model`.
 */
export function agentModelOf(trace: { metadata?: Record<string, unknown>; spans?: Array<{ attributes?: Record<string, unknown> }> }): string | null {
  const read = (bag: Record<string, unknown> | undefined): string | null => {
    if (!bag) return null;
    for (const k of AGENT_MODEL_KEYS) {
      const v = bag[k];
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
    return null;
  };
  const fromMeta = read(trace.metadata);
  if (fromMeta) return fromMeta;
  for (const s of trace.spans ?? []) {
    const v = read(s.attributes);
    if (v) return v;
  }
  return null;
}

export const JUDGE_SAME_FAMILY_CODE: IrisWarningCode = 'IRIS_JUDGE_SAME_FAMILY';

/** The sentence the warning carries. */
export function sameFamilyWarning(judgeModel: string, agentModel: string): { code: typeof JUDGE_SAME_FAMILY_CODE; message: string } {
  return {
    code: JUDGE_SAME_FAMILY_CODE,
    message:
      `The judge (${judgeModel}) shares a model family (${modelFamily(judgeModel)}) with the agent it judged (${agentModel}). ` +
      'A judge from the same lineage tends to forgive the errors it would make itself, so this score is less independent than one from another family. ' +
      'The evaluation stands; read it as a same-family opinion, or judge again with a model from a different family.',
  };
}
