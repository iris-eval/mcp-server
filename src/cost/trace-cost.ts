/*
 * A trace's cost: the one the producer reported, else one estimated from
 * its token counts and its model's list price, else none with the reason.
 *
 * Most traces arrive without a cost. OpenTelemetry GenAI instrumentation,
 * the SDK and Python wrappers and the LangChain handlers all record the
 * model and the token counts of each call, and almost none record what it
 * cost; stored as null, every cost rule skipped and no cost alert could
 * fire. Every ingest door (log_trace, POST /api/v1/traces, POST /v1/traces,
 * `iris-eval ingest`) calls resolveTraceCost before it stores or scores a
 * trace, and the storage adapter calls it again on write, so a door added
 * later cannot store a trace unpriced.
 *
 * The rules, in order:
 *
 *   - A reported cost wins, always, and is never replaced: `cost_source`
 *     is `reported`.
 *   - With `pricing.estimate: false` nothing is estimated.
 *   - When the spans record model calls (a span carrying token counts,
 *     counted at the leaves exactly as the OTLP door counts usage), each
 *     call's model is the one its span names (response model first, then
 *     the request model), else its nearest ancestor's, else the trace's.
 *     If they all price as one model, the trace's own token_usage is priced
 *     at it — the numbers the trace shows are the numbers priced — unless a
 *     call is over the size its provider prices higher (pricing.ts,
 *     longContext): a total cannot carry a call's size, so each call is then
 *     priced by its own, and what token_usage records beyond the calls is
 *     priced as one more total, at the base rates. If they price as several,
 *     each call is priced at its own model and summed.
 *   - Otherwise the trace's token_usage is priced at the model its metadata
 *     names (`metadata.model`, the key the OTLP door writes).
 *   - A model no table prices, or no model, or no token counts: the cost
 *     stays null and `cost_estimate` says why. Never a partial sum: a
 *     trace with one unpriced call is not priced at all, because a cost
 *     that is too low passes a budget it should fail.
 *
 * What an estimate is: the provider's list price for the tokens the trace
 * recorded, each call at the rates its own size picks where its provider
 * prices a long request higher. Reasoning tokens are counted in the output tokens by both
 * providers and are priced at the output rate, which is how they are
 * billed. Cached input is priced as the provider bills it when the trace
 * says how much there was (`gen_ai.usage.cache_read.input_tokens` /
 * `cache_creation.input_tokens` on a span, or token_usage.cache_read_tokens
 * / cache_creation_tokens): cache reads at the model's cache-read price,
 * cache writes at its cache-write price (a 1-hour write at its 1-hour price
 * when the trace carries Anthropic's split), the rest of the input at the
 * input price.
 *
 * The cached counts are a PART of the input count, as the GenAI
 * conventions, OpenInference and OpenAI define it, and as Iris's own
 * wrappers and LangChain handlers record it. Anthropic's API reports them
 * BESIDE input_tokens instead; an instrumentation that passes that shape
 * through can be told apart only when the cached counts exceed the input
 * count, which a part never can. Then they are added to it, and the
 * estimate's notes say so. A cached count no larger than the input is read
 * as a part: that is the conventions' meaning, and the one every sender
 * Iris ships follows.
 *
 * A model priced in config.json without a cache price has its cached
 * tokens priced at its input price, as they were before cache prices
 * existed, and the notes say so. Batch discounts, negotiated rates and a
 * cloud provider's own price are not known to Iris; pricing.models in
 * config.json sets them.
 */
import type { CostEstimate, CostEstimateCall, Span, TokenUsage, Trace } from '../types/trace.js';
import { AGGREGATED_INPUT_KEYS, AGGREGATED_OUTPUT_KEYS, CACHE_READ_KEYS, CACHE_WRITE_1H_KEYS, CACHE_WRITE_KEYS, INPUT_TOKEN_KEYS, OUTPUT_TOKEN_KEYS } from '../otel/usage-keys.js';
import { AGENT_MODEL_KEYS } from '../eval/llm-judge/family.js';
import { PRICING_SOURCED_ON } from '../eval/llm-judge/pricing.js';
import { priceModel, pricingSettings, type PriceMatch, type PricingSettings } from './model-lookup.js';

/** The keys a span names its model under, in the order they are priced: the model that answered, then the one asked for. */
export const SPAN_MODEL_KEYS = ['gen_ai.response.model', 'gen_ai.request.model', 'llm.model_name', 'llm.request.model', 'ai.model.id'] as const;

/** The tokens of one priced call: every input token, the output, and the cached part of the input. */
interface Tokens {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  /** Of cacheWrite, the 1-hour writes; undefined when the trace did not say (every write is then priced as a 5-minute one). */
  cacheWrite1h?: number;
}

interface ModelCall extends Tokens {
  /** The ids the call's span (or its nearest ancestor that names one) records, in SPAN_MODEL_KEYS order. */
  models: string[];
  /** True for one call to a model; false for a whole run's aggregate, a sum over calls that cannot say how large each was. */
  oneRequest: boolean;
}

/** A call's size as its provider counts it: every input token, the cached ones added where they were counted beside the input. */
function sizeOf(t: Tokens): number {
  const cached = t.cacheRead + t.cacheWrite;
  return cached > t.prompt ? t.prompt + cached : t.prompt;
}

function numberAt(attrs: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!attrs) return undefined;
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

function modelIdsAt(attrs: Record<string, unknown> | undefined): string[] {
  if (!attrs) return [];
  const ids: string[] = [];
  for (const k of SPAN_MODEL_KEYS) {
    const v = attrs[k];
    if (typeof v === 'string' && v.trim() !== '' && !ids.includes(v)) ids.push(v);
  }
  return ids;
}

/** The model the trace as a whole names: its metadata, under the keys the judge's same-family check reads. */
function traceModelOf(trace: Trace): string | undefined {
  for (const k of AGENT_MODEL_KEYS) {
    const v = trace.metadata?.[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * The model calls the spans record: each span carrying token counts with
 * no carrying descendant (a parent that repeats its children's usage is a
 * total, not a call — the OTLP door's usageOf reads usage the same way),
 * or, when no span carries per-call counts, the span carrying a whole-run
 * aggregate.
 */
function modelCallsOf(spans: readonly Span[] | undefined): ModelCall[] {
  if (!spans || spans.length === 0) return [];
  const byId = new Map(spans.map((s) => [s.span_id, s] as const));
  const carries = (s: Span) => numberAt(s.attributes, INPUT_TOKEN_KEYS) !== undefined || numberAt(s.attributes, OUTPUT_TOKEN_KEYS) !== undefined;
  const carriers = spans.filter(carries);

  // Every ancestor of a carrier has a carrier below it; a walk up from each carrier marks them (bounded by the span count, so a cycle cannot loop).
  const hasCarrierBelow = new Set<string>();
  for (const c of carriers) {
    let parent = c.parent_span_id;
    for (let hops = 0; parent !== undefined && hops < spans.length; hops += 1) {
      // Back at the carrier: the parent links form a cycle, and a span is never its own ancestor.
      if (parent === c.span_id || hasCarrierBelow.has(parent)) break;
      hasCarrierBelow.add(parent);
      parent = byId.get(parent)?.parent_span_id;
    }
  }
  const modelsOf = (s: Span): string[] => {
    let node: Span | undefined = s;
    for (let hops = 0; node !== undefined && hops <= spans.length; hops += 1) {
      const ids = modelIdsAt(node.attributes);
      if (ids.length > 0) return ids;
      node = node.parent_span_id !== undefined ? byId.get(node.parent_span_id) : undefined;
    }
    return [];
  };

  const leaves = carriers.filter((c) => !hasCarrierBelow.has(c.span_id));
  if (leaves.length > 0) {
    return leaves.map((s) => ({
      prompt: numberAt(s.attributes, INPUT_TOKEN_KEYS) ?? 0,
      completion: numberAt(s.attributes, OUTPUT_TOKEN_KEYS) ?? 0,
      cacheRead: numberAt(s.attributes, CACHE_READ_KEYS) ?? 0,
      cacheWrite: numberAt(s.attributes, CACHE_WRITE_KEYS) ?? 0,
      cacheWrite1h: numberAt(s.attributes, CACHE_WRITE_1H_KEYS),
      models: modelsOf(s),
      oneRequest: true,
    }));
  }
  const aggregate = spans.find((s) => numberAt(s.attributes, AGGREGATED_INPUT_KEYS) !== undefined || numberAt(s.attributes, AGGREGATED_OUTPUT_KEYS) !== undefined);
  return aggregate
    ? [{
        prompt: numberAt(aggregate.attributes, AGGREGATED_INPUT_KEYS) ?? 0,
        completion: numberAt(aggregate.attributes, AGGREGATED_OUTPUT_KEYS) ?? 0,
        cacheRead: numberAt(aggregate.attributes, CACHE_READ_KEYS) ?? 0,
        cacheWrite: numberAt(aggregate.attributes, CACHE_WRITE_KEYS) ?? 0,
        cacheWrite1h: numberAt(aggregate.attributes, CACHE_WRITE_1H_KEYS),
        models: modelsOf(aggregate),
        oneRequest: false,
      }]
    : [];
}

/** USD to ten decimal places: exact for any token count, free of float noise in a sum. */
function usd(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * One call at its model's prices. `scope` says what the counts are: `one`, a
 * single request; `within`, a total over requests each known to be within
 * the size its provider prices higher; `total`, a total that cannot say how
 * large each request was. Pushes onto `notes` anything priced other than as
 * the provider bills it: cached counts reported beside the input count, a
 * cache price the table does not have, or such a total over that size.
 */
function priced(match: PriceMatch, t: Tokens, notes: string[], scope: 'one' | 'within' | 'total'): CostEstimateCall {
  const cached = t.cacheRead + t.cacheWrite;
  // A part is never larger than its whole: more cached tokens than input tokens were counted beside the input (Anthropic's API shape).
  const beside = cached > t.prompt;
  if (beside) {
    notes.push(`${match.model}: the cached counts (${fmt(cached)}) are more than the input count (${fmt(t.prompt)}), so they were counted beside it, as Anthropic's API reports them, and added to it.`);
  }
  const prompt = sizeOf(t);
  const uncached = prompt - cached;
  /*
   * A request over the size its provider prices higher (pricing.ts,
   * longContext) is priced at those rates, every token of it. A total over
   * several requests cannot say which of them was over it: it is priced at
   * the row's own rates, and says so when the total is over the line.
   */
  const long = match.longContext;
  const over = long !== null && prompt > long.aboveInputTokens;
  if (over && scope === 'one') {
    notes.push(`${match.model}: a call over ${fmt(long.aboveInputTokens)} input tokens is priced at the provider's rates for such a request, every token of it.`);
  } else if (over && scope === 'total') {
    notes.push(`${match.model}: priced at the rates of a request of up to ${fmt(long.aboveInputTokens)} input tokens. The ${fmt(prompt)} counted are a total over calls, which cannot say whether a call was over that size; such a call costs more, so the estimate may be low.`);
  }
  const rates = over && scope === 'one'
    ? { input: long.inputUsdPer1M, output: long.outputUsdPer1M, cacheRead: long.cacheReadUsdPer1M, cacheWrite: long.cacheWriteUsdPer1M, cacheWrite1h: long.cacheWrite1hUsdPer1M ?? null }
    : { input: match.inputUsdPer1M, output: match.outputUsdPer1M, cacheRead: match.cacheReadUsdPer1M, cacheWrite: match.cacheWriteUsdPer1M, cacheWrite1h: match.cacheWrite1hUsdPer1M };
  const readPrice = rates.cacheRead ?? rates.input;
  const writePrice = rates.cacheWrite ?? rates.input;
  if (t.cacheRead > 0 && rates.cacheRead === null) {
    notes.push(`${match.model}: ${fmt(t.cacheRead)} cache-read tokens are priced at the input price, because pricing.models in config.json names no cacheReadUsdPer1M for ${match.pricedAs}.`);
  }
  if (t.cacheWrite > 0 && rates.cacheWrite === null) {
    notes.push(`${match.model}: ${fmt(t.cacheWrite)} cache-write tokens are priced at the input price, because pricing.models in config.json names no cacheWriteUsdPer1M for ${match.pricedAs}.`);
  }
  /*
   * The write lifetimes. Anthropic bills a 1-hour write at twice the input
   * and a 5-minute write at 1.25 times; its usage object splits the writes,
   * and Iris's wrappers carry the split. Without it every write is priced as
   * a 5-minute one, and for a model whose 1-hour writes cost more the notes
   * say the estimate may be low by them.
   */
  const write1h = t.cacheWrite1h === undefined ? undefined : Math.min(t.cacheWrite1h, t.cacheWrite);
  const write5m = t.cacheWrite - (write1h ?? 0);
  const write1hPrice = rates.cacheWrite1h ?? writePrice;
  if (write1h !== undefined && write1h > 0 && rates.cacheWrite1h === null) {
    notes.push(`${match.model}: ${fmt(write1h)} 1-hour cache-write tokens are priced at the cache-write price, because no 1-hour write price is known for ${match.pricedAs}.`);
  }
  if (t.cacheWrite > 0 && t.cacheWrite1h === undefined && rates.cacheWrite1h !== null) {
    notes.push(`${match.model}: ${fmt(t.cacheWrite)} cache-write tokens are priced as 5-minute writes; the trace does not say how many had a 1-hour lifetime, which costs more.`);
  }
  const perM = (n: number, price: number) => (n / 1_000_000) * price;
  return {
    model: match.model,
    priced_as: match.pricedAs,
    prompt_tokens: prompt,
    completion_tokens: t.completion,
    input_usd_per_1m: rates.input,
    output_usd_per_1m: rates.output,
    ...(cached > 0
      ? {
          cache_read_tokens: t.cacheRead,
          cache_creation_tokens: t.cacheWrite,
          cache_read_usd_per_1m: readPrice,
          cache_write_usd_per_1m: writePrice,
          ...(write1h !== undefined && t.cacheWrite > 0 ? { cache_creation_1h_tokens: write1h, cache_write_1h_usd_per_1m: write1hPrice } : {}),
        }
      : {}),
    cost_usd: usd(
      perM(uncached, rates.input) + perM(t.cacheRead, readPrice) + perM(write5m, writePrice) + perM(write1h ?? 0, write1hPrice) + perM(t.completion, rates.output),
    ),
    price_source: match.source,
    price_as_of: match.asOf,
  };
}

const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);

/** The cached part of a trace's token_usage: Iris's own fields, else OpenAI's `prompt_tokens_details.cached_tokens` as sent. */
function cachedOf(usage: TokenUsage | undefined): { cacheRead: number; cacheWrite: number; cacheWrite1h?: number } {
  const write1h = count(usage?.cache_creation_1h_tokens);
  return {
    cacheRead: count(usage?.cache_read_tokens) ?? count(usage?.prompt_tokens_details?.cached_tokens) ?? 0,
    cacheWrite: count(usage?.cache_creation_tokens) ?? 0,
    ...(write1h !== undefined ? { cacheWrite1h: write1h } : {}),
  };
}

/**
 * What a total records beyond the calls listed: each of its counts less
 * the calls' sum, never below 0, the cached part no larger than the input
 * left. Undefined when nothing is left beyond them.
 */
function remainderOf(total: Tokens, calls: readonly Tokens[]): Tokens | undefined {
  const sum = (pick: (t: Tokens) => number): number => calls.reduce((s, c) => s + pick(c), 0);
  const prompt = Math.max(0, sizeOf(total) - sum(sizeOf));
  const completion = Math.max(0, total.completion - sum((c) => c.completion));
  if (prompt === 0 && completion === 0) return undefined;
  const cacheRead = Math.min(prompt, Math.max(0, total.cacheRead - sum((c) => c.cacheRead)));
  const cacheWrite = Math.min(prompt - cacheRead, Math.max(0, total.cacheWrite - sum((c) => c.cacheWrite)));
  const cacheWrite1h = total.cacheWrite1h === undefined ? undefined : Math.min(cacheWrite, Math.max(0, total.cacheWrite1h - sum((c) => c.cacheWrite1h ?? 0)));
  return { prompt, completion, cacheRead, cacheWrite, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}) };
}

function estimated(basis: 'token_usage' | 'calls', calls: CostEstimateCall[], notes: string[]): { cost_usd: number; estimate: CostEstimate } {
  const unique = [...new Set(notes)];
  return {
    cost_usd: usd(calls.reduce((sum, c) => sum + c.cost_usd, 0)),
    estimate: { status: 'estimated', basis, calls, ...(unique.length > 0 ? { notes: unique } : {}) },
  };
}

const SEND_COST = 'Send cost_usd with the trace (or iris.cost_usd on a span)';

function unpriced(reason: 'no_tokens' | 'no_model' | 'unknown_model' | 'disabled', message: string, models?: string[]): CostEstimate {
  return { status: 'unpriced', reason, message, ...(models && models.length > 0 ? { models } : {}) };
}

function unknownModel(ids: string[]): CostEstimate {
  const named = ids.map((m) => `"${m}"`).join(', ');
  return unpriced(
    'unknown_model',
    `No cost: ${ids.length === 1 ? `the model ${named} is` : `the models ${named} are`} not in Iris's pricing table (as of ${PRICING_SOURCED_ON}). ${SEND_COST}, or price ${ids.length === 1 ? 'it' : 'them'} under pricing.models in config.json.`,
    ids,
  );
}

/**
 * The cost of a trace that reported none, or why it has none. Pure: reads
 * the trace and the pricing settings, never the clock or the store.
 */
export function estimateTraceCost(trace: Trace, using: PricingSettings = pricingSettings()): { cost_usd?: number; estimate: CostEstimate } {
  if (!using.estimate) return { estimate: unpriced('disabled', 'No cost: the trace reported none, and cost estimates are off (pricing.estimate is false in config.json).') };

  const traceModel = traceModelOf(trace);
  const calls = modelCallsOf(trace.spans);

  if (calls.length > 0) {
    const models = calls.map((c) => (c.models.length > 0 ? c.models : traceModel !== undefined ? [traceModel] : []));
    if (models.some((m) => m.length === 0)) {
      return { estimate: unpriced('no_model', `No cost: the spans record token counts but ${calls.length === 1 ? 'the call names' : 'not every call names'} a model (gen_ai.request.model or gen_ai.response.model on the span, or metadata.model on the trace). ${SEND_COST}, or record the model.`) };
    }
    // Each call is priced at the first id its span names that a table prices: the model that answered, else the one asked for.
    const matches = models.map((ids) => ids.map((id) => priceModel(id, using)).find((m) => m !== null) ?? null);
    const unknown = [...new Set(models.filter((_, i) => matches[i] === null).map((ids) => ids[0]))];
    if (unknown.length > 0) return { estimate: unknownModel(unknown) };
    const found = matches as PriceMatch[];

    const oneModel = new Set(found.map((m) => `${m.source}:${m.pricedAs}`)).size === 1;
    const usage = trace.token_usage;
    const notes: string[] = [];
    // A call over the size its provider prices higher is priced by its own size, which the run's total cannot carry: the calls are then priced one by one.
    const sized = found.some((m, i) => m.longContext !== null && calls[i].oneRequest && sizeOf(calls[i]) > m.longContext.aboveInputTokens);
    const total: Tokens | undefined =
      count(usage?.prompt_tokens) !== undefined && count(usage?.completion_tokens) !== undefined ? { prompt: usage!.prompt_tokens!, completion: usage!.completion_tokens!, ...cachedOf(usage) } : undefined;
    if (oneModel && !sized && total !== undefined) {
      // Calls that account for the whole total, none over the line, price it as exactly as they would one by one.
      const covered = calls.every((c) => c.oneRequest) && calls.reduce((sum, c) => sum + sizeOf(c), 0) >= sizeOf(total);
      return estimated('token_usage', [priced(found[0], total, notes, covered ? 'within' : 'total')], notes);
    }
    const perCall = found.map((m, i) => priced(m, calls[i], notes, calls[i].oneRequest ? 'one' : 'total'));
    // Of one model, the trace's token_usage is its whole: what it records beyond the calls on its spans is priced too, as one more total.
    const rest = oneModel && total !== undefined ? remainderOf(total, calls) : undefined;
    if (rest !== undefined) {
      notes.push(`${found[0].model}: token_usage records ${fmt(rest.prompt)} input and ${fmt(rest.completion)} output tokens beyond the calls on the spans; they are priced as one more total.`);
      perCall.push(priced(found[0], rest, notes, 'total'));
    }
    return estimated('calls', perCall, notes);
  }

  const usage = trace.token_usage;
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!valid(prompt) || !valid(completion)) {
    const has = usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined || usage.total_tokens !== undefined);
    return {
      estimate: unpriced(
        'no_tokens',
        has
          ? `No cost: token_usage needs both prompt_tokens and completion_tokens to be priced, because input and output tokens have different prices. ${SEND_COST}, or send both counts.`
          : `No cost: the trace carries no token counts (token_usage, or gen_ai.usage.* on its spans). ${SEND_COST}, or its token counts and model.`,
      ),
    };
  }
  if (traceModel === undefined) {
    return { estimate: unpriced('no_model', `No cost: the trace has token counts but names no model (metadata.model, or gen_ai.request.model on a span). ${SEND_COST}, or name the model.`) };
  }
  const match = priceModel(traceModel, using);
  if (!match) return { estimate: unknownModel([traceModel]) };
  const notes: string[] = [];
  return estimated('token_usage', [priced(match, { prompt, completion, ...cachedOf(usage) }, notes, 'total')], notes);
}

/**
 * The trace with its cost settled: `cost_source` and `cost_estimate` set.
 * Returns the same trace when it is already settled (a door priced it and
 * the adapter sees it again), so calling it twice changes nothing.
 */
export function resolveTraceCost<T extends Trace>(trace: T, using: PricingSettings = pricingSettings()): T {
  if (trace.cost_source !== undefined || trace.cost_estimate !== undefined) return trace;
  if (typeof trace.cost_usd === 'number' && Number.isFinite(trace.cost_usd)) return { ...trace, cost_source: 'reported' };
  const { cost_usd, estimate } = estimateTraceCost(trace, using);
  if (cost_usd === undefined) {
    const rest = { ...trace, cost_estimate: estimate };
    delete rest.cost_usd;
    return rest;
  }
  return { ...trace, cost_usd, cost_source: 'estimated', cost_estimate: estimate };
}

/** The cost fields a door answers with: the same names get_traces returns. */
export function costFieldsOf(trace: Trace): { cost_usd: number | null; cost_source?: Trace['cost_source']; cost_estimate?: CostEstimate } {
  return {
    cost_usd: typeof trace.cost_usd === 'number' ? trace.cost_usd : null,
    ...(trace.cost_source !== undefined ? { cost_source: trace.cost_source } : {}),
    ...(trace.cost_estimate !== undefined ? { cost_estimate: trace.cost_estimate } : {}),
  };
}
