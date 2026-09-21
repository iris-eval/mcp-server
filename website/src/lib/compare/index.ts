/*
 * The compare pages, from data (arc 8, R-5).
 *
 * One JSON file per vendor under website/src/lib/compare/: the vendor's side
 * of the twelve features in compare-iris.ts, every cell with the vendor's own
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
