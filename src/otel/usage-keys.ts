/*
 * The span attributes a model call's token counts are read from — the OTel
 * GenAI conventions (current, then the names deprecated in v1.37), Iris's
 * own `iris.*_tokens`, OpenInference's `llm.token_count.*`, Semantic
 * Kernel's `gen_ai.response.*_tokens` and the Vercel AI SDK's `ai.usage.*`.
 * One list for the OTLP door's usage totals (src/otel/ingest.ts) and the
 * cost estimate's model calls (src/cost/trace-cost.ts), so the tokens a
 * trace shows and the tokens it is priced on are read the same way.
 */
export const INPUT_TOKEN_KEYS = ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'iris.prompt_tokens', 'llm.token_count.prompt', 'gen_ai.response.prompt_tokens', 'ai.usage.promptTokens'];
export const OUTPUT_TOKEN_KEYS = ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'iris.completion_tokens', 'llm.token_count.completion', 'gen_ai.response.completion_tokens', 'ai.usage.completionTokens'];
/** A framework's own whole-run total (Pydantic AI) — when present it is the answer, not one more addend. */
export const AGGREGATED_INPUT_KEYS = ['gen_ai.aggregated_usage.input_tokens'];
export const AGGREGATED_OUTPUT_KEYS = ['gen_ai.aggregated_usage.output_tokens'];
