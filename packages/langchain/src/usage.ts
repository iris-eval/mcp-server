/*
 * One model call's usage → the span's GenAI usage attributes.
 *
 * LangChain's `usage_metadata` is the same shape in every integration, but
 * the prompt-cache details are not. langchain-anthropic (Python) moves
 * Anthropic's cache-write lifetimes into `input_token_details`
 * (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`) and then sets
 * `cache_creation` to 0 so the writes are not counted twice;
 * @langchain/anthropic (JavaScript) keeps `cache_creation` and leaves the
 * lifetimes in the raw Anthropic usage under `response_metadata.usage`.
 * Both shapes are read here, and by the Python handler's twin
 * (iris_eval/_langchain_usage.py): tests/fixtures/langchain-usage-parity
 * holds the two to the same attributes.
 *
 * The cache counts are a part of `input_tokens`, which LangChain already
 * totals with them, as the GenAI conventions count them. The 1-hour writes
 * go out as `iris.usage.cache_creation.ephemeral_1h_input_tokens`, the name
 * the provider wrappers use; no GenAI convention names the lifetime yet.
 */
export type UsageAttributes = Record<string, number>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

export function usageAttributes(usageMetadata: unknown, responseMetadata: unknown): UsageAttributes {
  const out: UsageAttributes = {};
  if (!isRecord(usageMetadata)) return out;
  const put = (key: string, v: number | undefined) => {
    if (v !== undefined) out[key] = v;
  };
  put('gen_ai.usage.input_tokens', int(usageMetadata.input_tokens));
  put('gen_ai.usage.output_tokens', int(usageMetadata.output_tokens));

  const details = isRecord(usageMetadata.input_token_details) ? usageMetadata.input_token_details : {};
  const raw = isRecord(responseMetadata) && isRecord(responseMetadata.usage) && isRecord(responseMetadata.usage.cache_creation) ? responseMetadata.usage.cache_creation : {};
  put('gen_ai.usage.cache_read.input_tokens', int(details.cache_read));

  // The lifetimes: in input_token_details (Python), else in the raw usage (JavaScript).
  const write5m = int(details.ephemeral_5m_input_tokens) ?? int(raw.ephemeral_5m_input_tokens);
  const write1h = int(details.ephemeral_1h_input_tokens) ?? int(raw.ephemeral_1h_input_tokens);
  const creation = int(details.cache_creation);
  const split = write5m !== undefined || write1h !== undefined ? (write5m ?? 0) + (write1h ?? 0) : undefined;
  // When the lifetimes carry the writes, cache_creation may have been zeroed to avoid counting them twice.
  const writes = creation === undefined ? split : split === undefined ? creation : Math.max(creation, split);
  put('gen_ai.usage.cache_creation.input_tokens', writes);
  put('iris.usage.cache_creation.ephemeral_1h_input_tokens', write1h);

  const outDetails = isRecord(usageMetadata.output_token_details) ? usageMetadata.output_token_details : {};
  put('gen_ai.usage.reasoning.output_tokens', int(outDetails.reasoning));
  return out;
}
