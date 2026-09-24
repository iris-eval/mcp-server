/*
 * The compare pages, from data.
 *
 * One JSON file per vendor under website/src/lib/compare/: the vendor's side
 * of the features in iris.ts FEATURE_IDS, every cell with the vendor's own
 * page as its source and the date it was read, plus the vendor's reasons,
 * FAQ halves and TL;DR — all sourced. This index is the only list of them;
 * app/compare/[slug]/page.tsx renders one page per entry, the compare index
 * and the sitemap read the same list, and tests/compare-contract.test.ts
 * locks every file to the schema and to the sources.
 */
import type { FeatureId } from "./iris";
import arize from "./arize.json";
import braintrust from "./braintrust.json";
import confidentAi from "./confident-ai.json";
import deepeval from "./deepeval.json";
import galileo from "./galileo.json";
import helicone from "./helicone.json";
import judgment from "./judgment.json";
import langfuse from "./langfuse.json";
import langsmith from "./langsmith.json";
import latitude from "./latitude.json";
import opik from "./opik.json";
import patronusAi from "./patronus-ai.json";
import promptfoo from "./promptfoo.json";
import weave from "./weave.json";

export type Verdict = "iris" | "vendor" | "neither";
export type CompareCategory = "Observability" | "Evaluation" | "Safety" | "Testing";

export interface CompareRow {
  id: FeatureId;
  vendor: string;
  verdict: Verdict;
  sourceUrl: string;
  quote: string;
  lastVerified: string;
  /**
   * Whether the quote was found verbatim on a plain download of the source
   * page on `quotesCheckedOn`, read as a reader would — tags stripped, inline
   * Markdown markup stripped (most vendors' docs answer a plain fetch with
   * Markdown), the spacing a stripped tag leaves before punctuation closed,
   * whitespace folded (scripts/verify-compare-quotes.mjs); null when
   * the cell says the page does not answer. The quotes were first extracted
   * through a summarising fetch, so only a verified quote is shown as the
   * source link's title — the link and the date stand either way.
   */
  quoteVerified: boolean | null;
}
export interface CompareSource {
  label: string;
  url: string;
  lastVerified: string;
}
export interface CompareData {
  slug: string;
  name: string;
  homepage: string;
  category: CompareCategory;
  tagline: string;
  oneLine: string;
  ogImage: string | null;
  tldrVendor: string;
  tldrSourceUrl: string;
  rows: CompareRow[];
  vendorReasons: { text: string; sourceUrl: string }[];
  faq: { question: string; vendorPart: string; sourceUrl: string }[];
  sources: CompareSource[];
  lastVerified: string;
  /** The date every quote in `rows` was checked against a plain download of its page. */
  quotesCheckedOn: string;
}

export const COMPARISONS: readonly CompareData[] = [
  langfuse,
  langsmith,
  helicone,
  braintrust,
  arize,
  deepeval,
  confidentAi,
  patronusAi,
  promptfoo,
  galileo,
  opik,
  weave,
  judgment,
  latitude,
] as CompareData[];

export function compareBySlug(slug: string): CompareData | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}
