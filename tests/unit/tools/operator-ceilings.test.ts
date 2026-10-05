import { afterEach, describe, expect, it, vi } from 'vitest';
import { citationCostCeiling, domainCeiling, fetchCeiling, judgeCostCeiling } from '../../../src/tools/operator-ceilings.js';

/*
 * Operator settings are ceilings: a tool argument can narrow what the
 * operator allowed and never widen it. Each argument that could widen it
 * before (fetching, domains, cost) is held here, case by case.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('allow_fetch can switch fetching off, never on', () => {
  it('with the operator\'s fetching off, true is refused and says why', () => {
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '');
    expect(fetchCeiling(undefined)).toEqual({ allowFetch: false });
    const asked = fetchCeiling(true);
    expect(asked.allowFetch).toBe(false);
    expect(asked.warning).toMatchObject({ code: 'IRIS_ARGUMENT_NARROWED', field: 'allow_fetch' });
    expect(asked.warning?.message).toMatch(/IRIS_CITATION_ALLOW_FETCH=1/);
  });

  it('with it on, false turns it off for the call, and true or nothing leaves it on', () => {
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '1');
    expect(fetchCeiling(false)).toEqual({ allowFetch: false });
    expect(fetchCeiling(true)).toEqual({ allowFetch: true });
    expect(fetchCeiling(undefined)).toEqual({ allowFetch: true });
  });
});

describe('domain_allowlist narrows IRIS_CITATION_DOMAINS, never adds to it', () => {
  it('with no operator list, the argument\'s list applies as given', () => {
    vi.stubEnv('IRIS_CITATION_DOMAINS', '');
    expect(domainCeiling(['arxiv.org'])).toEqual({ allowlist: ['arxiv.org'], none: false });
    expect(domainCeiling(undefined)).toEqual({ allowlist: undefined, none: false });
  });

  it('a subdomain of an operator entry is a narrowing, kept without a warning; case does not matter', () => {
    vi.stubEnv('IRIS_CITATION_DOMAINS', 'example.com,arxiv.org');
    expect(domainCeiling(['docs.example.com', 'ArXiv.org'])).toEqual({ allowlist: ['arxiv.org', 'docs.example.com'], none: false });
  });

  it('an entry outside the operator\'s list is dropped, with a warning', () => {
    vi.stubEnv('IRIS_CITATION_DOMAINS', 'arxiv.org,doi.org');
    const r = domainCeiling(['doi.org', 'attacker.example']);
    expect(r.allowlist).toEqual(['doi.org']);
    expect(r.none).toBe(false);
    expect(r.warning).toMatchObject({ code: 'IRIS_ARGUMENT_NARROWED', field: 'domain_allowlist' });
  });

  it('a broader entry keeps only the operator\'s narrower one', () => {
    vi.stubEnv('IRIS_CITATION_DOMAINS', 'docs.example.com');
    const r = domainCeiling(['example.com']);
    expect(r.allowlist).toEqual(['docs.example.com']);
    expect(r.warning?.field).toBe('domain_allowlist');
  });

  it('a name that only ends with an operator entry is not inside it', () => {
    vi.stubEnv('IRIS_CITATION_DOMAINS', 'example.com');
    const r = domainCeiling(['badexample.com']);
    // Nothing left: nothing may be fetched, and the list is not passed on as empty (empty means any domain).
    expect(r).toMatchObject({ allowlist: undefined, none: true });
    expect(r.warning?.message).toMatch(/no source was fetched/);
  });
});

describe('cost arguments are capped by the operator\'s settings', () => {
  it('max_cost_usd: lower stands, higher is lowered to IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL with a warning', () => {
    vi.stubEnv('IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL', '0.05');
    expect(judgeCostCeiling(undefined)).toEqual({ value: 0.05 });
    expect(judgeCostCeiling(0.01)).toEqual({ value: 0.01 });
    const r = judgeCostCeiling(50);
    expect(r.value).toBe(0.05);
    expect(r.warning).toMatchObject({ code: 'IRIS_ARGUMENT_NARROWED', field: 'max_cost_usd' });
    expect(r.warning?.message).toMatch(/IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL/);
  });

  it('max_cost_usd_total: capped by IRIS_CITATION_MAX_COST_USD_TOTAL, 1 USD when unset', () => {
    vi.stubEnv('IRIS_CITATION_MAX_COST_USD_TOTAL', '');
    expect(citationCostCeiling(undefined)).toEqual({ value: 1 });
    expect(citationCostCeiling(5).value).toBe(1);
    vi.stubEnv('IRIS_CITATION_MAX_COST_USD_TOTAL', '0.2');
    expect(citationCostCeiling(0.1)).toEqual({ value: 0.1 });
    const r = citationCostCeiling(3);
    expect(r.value).toBe(0.2);
    expect(r.warning?.field).toBe('max_cost_usd_total');
  });
});
