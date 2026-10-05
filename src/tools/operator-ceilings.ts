/*
 * Operator settings are ceilings.
 *
 * The person who runs Iris sets what it may do with the network and with
 * their provider key: whether verify_citations fetches at all, from which
 * domains, and how much one judge call or one citation check may spend. A
 * tool argument comes from the agent, and an agent's arguments can be
 * steered by text it read, including text stored in Iris. So every
 * argument that touches the network or money passes through here, and an
 * argument may narrow what the operator allowed and never widen it.
 *
 * Until this module, three could widen it: `allow_fetch: true` turned
 * fetching on with IRIS_CITATION_ALLOW_FETCH unset, `domain_allowlist` was
 * merged into IRIS_CITATION_DOMAINS, and `max_cost_usd` and
 * `max_cost_usd_total` replaced the operator's cap with any larger number.
 *
 * When an argument asks for more than the operator allows, the operator's
 * setting applies and the call goes on; the result carries an
 * IRIS_ARGUMENT_NARROWED warning naming the argument, what it asked, what
 * applied, and the variable that would allow more, and the stored
 * evaluation keeps the same fact (provenance.narrowed) so the operator is
 * told on every read. It never fails the call: asking is not an error, and
 * the operator's answer is the setting.
 */
import { JUDGE_COST_CAP_VAR, judgeCostCapUsd } from '../judge-enablement.js';
import type { NarrowedArgument } from '../types/eval.js';

export const CITATION_ALLOW_FETCH_VAR = 'IRIS_CITATION_ALLOW_FETCH';
export const CITATION_DOMAINS_VAR = 'IRIS_CITATION_DOMAINS';
export const CITATION_TOTAL_COST_VAR = 'IRIS_CITATION_MAX_COST_USD_TOTAL';
/** What one verify_citations call may spend across its judge calls, unless the operator sets IRIS_CITATION_MAX_COST_USD_TOTAL. */
export const CITATION_DEFAULT_TOTAL_COST_USD = 1;

export const ARGUMENT_NARROWED_CODE = 'IRIS_ARGUMENT_NARROWED';

export interface ArgumentNarrowed extends NarrowedArgument {
  code: typeof ARGUMENT_NARROWED_CODE;
}

function narrowed(field: string, setting: string, message: string): ArgumentNarrowed {
  return { code: ARGUMENT_NARROWED_CODE, field, setting, message };
}

/** What the agent's reply carries: the code, the argument and the sentence. */
export function asWarning(w: ArgumentNarrowed): { code: string; field: string; message: string } {
  return { code: w.code, field: w.field, message: w.message };
}

/** What the stored evaluation carries (provenance.narrowed); the composer says it to the operator on every read. */
export function asRecord(w: ArgumentNarrowed): NarrowedArgument {
  return { field: w.field, setting: w.setting, message: w.message };
}

/** Whether the operator lets verify_citations fetch: only IRIS_CITATION_ALLOW_FETCH=1 does. */
export function operatorAllowsFetch(): boolean {
  return process.env.IRIS_CITATION_ALLOW_FETCH === '1';
}

/** `allow_fetch` can switch fetching off for one call; it cannot switch it on. */
export function fetchCeiling(asked: boolean | undefined): { allowFetch: boolean; warning?: ArgumentNarrowed } {
  const operator = operatorAllowsFetch();
  if (asked === true && !operator) {
    return {
      allowFetch: false,
      warning: narrowed(
        'allow_fetch',
        CITATION_ALLOW_FETCH_VAR,
        `allow_fetch: true asked to fetch sources, but the operator has not turned fetching on (${CITATION_ALLOW_FETCH_VAR}=1), and an argument cannot. No source was fetched.`,
      ),
    };
  }
  return { allowFetch: operator && asked !== false };
}

/** The operator's domains, as IRIS_CITATION_DOMAINS lists them; empty means any public domain. */
export function operatorDomains(): string[] {
  const raw = process.env.IRIS_CITATION_DOMAINS;
  return raw ? [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))] : [];
}

/** Whether `entry` covers only hosts `within` covers too: the same host, or a subdomain of it (the resolver's suffix match). */
function inside(entry: string, within: string): boolean {
  return entry === within || entry.endsWith(`.${within}`);
}

/**
 * The domains a fetch may use: the argument's list can only narrow the
 * operator's. With no operator list the argument's list applies as given
 * (it narrows "any domain"); with one, each argument entry keeps only its
 * overlap with an operator entry, and an entry outside every one is
 * dropped. `none` is true when nothing is left, and then nothing may be
 * fetched: an empty list means "any domain" to the resolver, so it must
 * never stand for "none".
 */
export function domainCeiling(asked: readonly string[] | undefined): { allowlist: string[] | undefined; none: boolean; warning?: ArgumentNarrowed } {
  const operator = operatorDomains();
  const wanted = asked ? [...new Set(asked.map((s) => s.trim().toLowerCase()).filter(Boolean))] : [];
  if (wanted.length === 0) return { allowlist: operator.length > 0 ? operator : undefined, none: false };
  if (operator.length === 0) return { allowlist: wanted, none: false };

  // For each overlapping pair, the narrower entry: together they cover exactly the hosts both lists allow.
  const kept = new Set<string>();
  for (const w of wanted) {
    for (const o of operator) {
      if (inside(w, o)) kept.add(w);
      else if (inside(o, w)) kept.add(o);
    }
  }
  const allowlist = [...kept].sort();
  const none = allowlist.length === 0;
  // Narrowed when some entry asked for a host no operator entry covers.
  if (wanted.every((w) => operator.some((o) => inside(w, o)))) return { allowlist, none };
  return {
    allowlist: none ? undefined : allowlist,
    none,
    warning: narrowed(
      'domain_allowlist',
      CITATION_DOMAINS_VAR,
      none
        ? `domain_allowlist named only domains outside the operator's ${CITATION_DOMAINS_VAR} (${operator.join(', ')}), so no source was fetched.`
        : `domain_allowlist asked for ${wanted.join(', ')}; the operator's ${CITATION_DOMAINS_VAR} allows ${operator.join(', ')}, so fetches were limited to ${allowlist.join(', ')}.`,
    ),
  };
}

/** The operator's cap on one verify_citations call's judge spend: IRIS_CITATION_MAX_COST_USD_TOTAL, else 1 USD. */
export function citationTotalCostCapUsd(): number {
  const raw = process.env.IRIS_CITATION_MAX_COST_USD_TOTAL;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return CITATION_DEFAULT_TOTAL_COST_USD;
}

/** A cost argument, never above the operator's cap for it. */
export function costCeiling(field: string, asked: number | undefined, cap: number, capVar: string): { value: number; warning?: ArgumentNarrowed } {
  if (asked === undefined) return { value: cap };
  if (asked <= cap) return { value: asked };
  return {
    value: cap,
    warning: narrowed(field, capVar, `${field}: ${asked} asked for more than the operator's cap of ${cap} USD (${capVar}), so ${cap} USD applied.`),
  };
}

/** evaluate_with_llm_judge's `max_cost_usd`, under IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL. */
export function judgeCostCeiling(asked: number | undefined): { value: number; warning?: ArgumentNarrowed } {
  return costCeiling('max_cost_usd', asked, judgeCostCapUsd(), JUDGE_COST_CAP_VAR);
}

/** verify_citations's `max_cost_usd_total`, under IRIS_CITATION_MAX_COST_USD_TOTAL. */
export function citationCostCeiling(asked: number | undefined): { value: number; warning?: ArgumentNarrowed } {
  return costCeiling('max_cost_usd_total', asked, citationTotalCostCapUsd(), CITATION_TOTAL_COST_VAR);
}
