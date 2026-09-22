/*
 * The FAQ on every compare page, derived (arc 9, N-21).
 *
 * Two questions are hand-written in the vendor's JSON with a sourced vendor
 * half. The other three are the questions a buyer types — what it costs to
 * run, whether it self-hosts, whether it works with MCP agents — and their
 * answers are projections of the table: the Iris half is the Iris cell, the
 * vendor half is the vendor cell with its page and date. Nothing is written
 * twice, so the FAQ cannot say something the table does not; the page
 * renders the five and emits them as FAQPage JSON-LD.
 * tests/compare-contract.test.ts holds the five and the projection.
 */
import type { CompareData } from "./index";
import { type FeatureId, IRIS_CELL, IRIS_FAQ_SENTENCE } from "./iris";

export interface FaqEntry {
  question: string;
  /** Iris's half of the answer, when the question has one. */
  irisPart: string | null;
  /** The vendor's half, from its own page. */
  vendorPart: string;
  sourceUrl: string;
}

/** The three derived questions, in page order, each the projection of one feature row. */
export const DERIVED_FAQ: readonly { id: FeatureId; question: (name: string) => string }[] = [
  { id: "cost_to_run", question: (name) => `How much does ${name} cost to run?` },
  { id: "self_hosting", question: (name) => `Can I self-host ${name}?` },
  { id: "mcp_support", question: (name) => `Does ${name} work with MCP agents?` },
];

/** The vendor half of a derived answer: the cell, or the honest sentence when the vendor's pages do not answer. */
export function derivedVendorPart(name: string, cell: string, readOn: string): string {
  if (/^Not stated in the vendor/.test(cell)) return `${name}'s pages, read ${readOn}, do not state it.`;
  const sentence = /[.!?]$/.test(cell) ? cell : `${cell}.`;
  return `${name}, from its own page read ${readOn}: ${sentence}`;
}

/** The five questions for one comparison: the two hand-written, then the three derived from the rows. */
export function faqFor(c: CompareData): FaqEntry[] {
  const written = c.faq.map((f, i) => ({
    question: f.question,
    irisPart: i === 0 ? IRIS_FAQ_SENTENCE : null,
    vendorPart: f.vendorPart,
    sourceUrl: f.sourceUrl,
  }));
  const derived = DERIVED_FAQ.map(({ id, question }) => {
    const row = c.rows.find((r) => r.id === id);
    if (!row) throw new Error(`${c.slug}: no ${id} row to derive the FAQ from`);
    return {
      question: question(c.name),
      irisPart: `Iris: ${IRIS_CELL[id]}.`,
      vendorPart: derivedVendorPart(c.name, row.vendor, row.lastVerified),
      sourceUrl: row.sourceUrl,
    };
  });
  return [...written, ...derived];
}
