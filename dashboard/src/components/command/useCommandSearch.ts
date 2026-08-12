/*
 * useCommandSearch — ⌘K data search (rules, traces, recent evals).
 *
 * In Linear and Stripe the palette IS search; ours only navigated. This
 * hook makes the palette search the user's DATA through the existing
 * dashboard APIs — no new endpoints, no new deps:
 *
 *   - rules  → GET /rules/custom  (name, description, eval type)
 *   - traces → GET /traces        (agent name, trace id, output)
 *   - evals  → GET /evaluations   (eval type, trace id, output)
 *
 * Fetch strategy: ONE corpus fetch per palette-open (fired lazily on the
 * first query that reaches MIN_QUERY_LENGTH), then every keystroke
 * filters locally — zero per-keystroke network latency, which is the
 * latency contract a palette lives or dies by. The corpus clears when
 * the palette closes so reopening always searches fresh data.
 *
 * searchCorpus() is a pure function so the matching/ranking logic is
 * unit-testable without any fetch machinery.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { DeployedCustomRule, EvalResult, Trace } from '../../api/types';

/** Two chars before we search — one char matches everything and reads as noise. */
export const MIN_QUERY_LENGTH = 2;

/** Cap per section — the palette is a ranked shortlist, not a results page. */
export const MAX_MATCHES_PER_KIND = 5;

/** How many recent traces/evals form the searchable corpus. */
const CORPUS_FETCH_LIMIT = '100';

export interface DataMatch {
  id: string;
  kind: 'rule' | 'trace' | 'eval';
  title: string;
  subtitle: string;
  /** Router path the match navigates to when selected. */
  to: string;
}

export interface DataCorpus {
  rules: DeployedCustomRule[];
  traces: Trace[];
  evals: EvalResult[];
}

/* Rank: startsWith beats includes; earlier fields beat later ones. */
function fieldScore(field: string | undefined, q: string): number {
  if (!field) return 0;
  const f = field.toLowerCase();
  if (f.startsWith(q)) return 3;
  if (f.includes(q)) return 1;
  return 0;
}

function best(...scores: number[]): number {
  return Math.max(0, ...scores);
}

/** Pure matcher — exported for unit tests. Returns [] under MIN_QUERY_LENGTH. */
export function searchCorpus(corpus: DataCorpus, query: string): DataMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LENGTH) return [];

  const rank = <T,>(items: T[], score: (item: T) => number, toMatch: (item: T) => DataMatch) =>
    items
      .map((item) => ({ item, score: score(item) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHES_PER_KIND)
      .map((entry) => toMatch(entry.item));

  const rules = rank(
    corpus.rules,
    (r) => best(fieldScore(r.name, q) * 2, fieldScore(r.description, q), fieldScore(r.evalType, q)),
    (r) => ({
      id: `rule.${r.id}`,
      kind: 'rule' as const,
      title: r.name,
      subtitle: `${r.severity} · ${r.evalType}${r.enabled ? '' : ' · disabled'}`,
      to: '/rules',
    }),
  );

  const traces = rank(
    corpus.traces,
    (t) => best(fieldScore(t.agent_name, q) * 2, fieldScore(t.trace_id, q), fieldScore(t.output, q)),
    (t) => ({
      id: `trace.${t.trace_id}`,
      kind: 'trace' as const,
      title: t.agent_name,
      subtitle: `${t.trace_id.slice(0, 12)}… · ${new Date(t.timestamp).toLocaleString()}`,
      to: `/traces/${t.trace_id}`,
    }),
  );

  const evals = rank(
    corpus.evals,
    (e) => best(fieldScore(e.eval_type, q) * 2, fieldScore(e.trace_id, q), fieldScore(e.output_text, q)),
    (e) => ({
      id: `eval.${e.id}`,
      kind: 'eval' as const,
      title: `${e.eval_type} — ${e.passed ? 'PASS' : 'FAIL'}`,
      subtitle: e.output_text.slice(0, 80),
      // An eval's home surface is the trace it evaluated; without a
      // trace link, the evals list is the closest landing.
      to: e.trace_id ? `/traces/${e.trace_id}` : '/evals',
    }),
  );

  return [...rules, ...traces, ...evals];
}

export interface UseCommandSearchResult {
  matches: DataMatch[];
  /** True while the corpus fetch is in flight (first data query only). */
  searching: boolean;
}

export function useCommandSearch(open: boolean, query: string): UseCommandSearchResult {
  const [corpus, setCorpus] = useState<DataCorpus | null>(null);
  const [searching, setSearching] = useState(false);
  const fetchStartedRef = useRef(false);
  // Session counter — bumped on close/unmount so an in-flight corpus
  // fetch from a previous palette session can't land in the next one.
  // (A `cancelled` flag in the fetch effect's cleanup would misfire:
  // that cleanup also runs when the query merely drops below
  // MIN_QUERY_LENGTH, which must NOT discard the session's corpus.)
  const sessionRef = useRef(0);

  // Clear the corpus when the palette closes so the next open re-fetches.
  useEffect(() => {
    if (!open) {
      sessionRef.current += 1;
      fetchStartedRef.current = false;
      setCorpus(null);
      setSearching(false);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
    };
  }, []);

  const wantsData = open && query.trim().length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!wantsData || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    const mySession = sessionRef.current;
    setSearching(true);
    // allSettled: a failing source (e.g. rate limit) degrades that section
    // to empty instead of killing the whole search.
    Promise.allSettled([
      api.getCustomRules(),
      api.getTraces({ limit: CORPUS_FETCH_LIMIT }),
      api.getEvaluations({ limit: CORPUS_FETCH_LIMIT }),
    ]).then(([rulesRes, tracesRes, evalsRes]) => {
      if (mySession !== sessionRef.current) return; // palette closed since
      setCorpus({
        rules: rulesRes.status === 'fulfilled' ? rulesRes.value.rules : [],
        traces: tracesRes.status === 'fulfilled' ? tracesRes.value.traces : [],
        evals: evalsRes.status === 'fulfilled' ? evalsRes.value.results : [],
      });
      setSearching(false);
    });
  }, [wantsData]);

  return {
    matches: corpus ? searchCorpus(corpus, query) : [],
    searching: wantsData && searching,
  };
}
