// Citation extraction — finds references inside an AI-generated output.
// No network, no judgment on validity; the resolver + verifier do that.
// This file's only job is "what did the model claim to cite, and what's
// the textual context around each citation?"
//
// Supported citation forms:
//   [1], [2], [3]            — numbered citations (bare)
//   [1][2]                   — consecutive numbered citations
//   (Author, 2021)           — author-year parenthetical
//   (Author et al., 2021)    — multi-author parenthetical
//   https://example.com/...  — bare URLs
//   10.1234/foo.bar          — DOIs (bare or with https://doi.org/)
//
// We intentionally do NOT try to parse footnote DEFINITIONS here — the
// extractor pairs each INLINE citation with a local sentence/paragraph
// context window. The verifier will match (citation, context) pairs
// against resolved sources.

export interface ExtractedCitation {
  // Raw citation as it appeared in the output.
  raw: string;
  // Classification — drives resolver selection.
  kind: 'numbered' | 'author_year' | 'url' | 'doi';
  // 1-based offset in the output for dashboards / UI pointing.
  offsetStart: number;
  offsetEnd: number;
  // ~200-char window around the citation for claim-extraction step.
  contextWindow: string;
  // For 'numbered' — the number (e.g. 1). For 'url' — the URL. For
  // 'doi' — the DOI. For 'author_year' — "Author, 2021".
  identifier: string;
}

const URL_PATTERN = /https?:\/\/[^\s)\]]+/g;
// Basic DOI — 10. prefix + registrant + slash + suffix
const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s)\];,"'<>]+/g;
// [1], [2], [12]. Avoid matching [INSERT], [FIXME] etc. by requiring digits only.
const NUMBERED_PATTERN = /\[(\d{1,3})\]/g;
// (Author, 2021), (Smith et al., 2019), (van der Berg, 2023)
// Restrictive enough to avoid matching any parenthetical aside:
// - 1-40 chars inside parens
// - ends with ", YYYY" where YYYY is 1800-2099
const AUTHOR_YEAR_PATTERN = /\(([^()]{1,50}?,\s*(?:18|19|20)\d{2})\)/g;

function makeContext(text: string, start: number, end: number): string {
  const radius = 200;
  const contextStart = Math.max(0, start - radius);
  const contextEnd = Math.min(text.length, end + radius);
  let ctx = text.slice(contextStart, contextEnd);
  if (contextStart > 0) ctx = '…' + ctx;
  if (contextEnd < text.length) ctx = ctx + '…';
  return ctx;
}

export function extractCitations(output: string): ExtractedCitation[] {
  if (!output) return [];
  const results: ExtractedCitation[] = [];

  for (const match of output.matchAll(NUMBERED_PATTERN)) {
    results.push({
      raw: match[0],
      kind: 'numbered',
      offsetStart: match.index ?? 0,
      offsetEnd: (match.index ?? 0) + match[0].length,
      contextWindow: makeContext(
        output,
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      ),
      identifier: match[1],
    });
  }

  for (const match of output.matchAll(URL_PATTERN)) {
    // Strip trailing punctuation that shouldn't be part of the URL.
    let cleaned = match[0].replace(/[.,;:!?)"'>]+$/, '');
    results.push({
      raw: match[0],
      kind: 'url',
      offsetStart: match.index ?? 0,
      offsetEnd: (match.index ?? 0) + cleaned.length,
      contextWindow: makeContext(output, match.index ?? 0, (match.index ?? 0) + cleaned.length),
      identifier: cleaned,
    });
  }

  for (const match of output.matchAll(DOI_PATTERN)) {
    // Skip DOIs that are inside a URL (already captured as a URL).
    const inUrl = /https?:\/\/[^\s]*$/.test(output.slice(0, match.index ?? 0));
    if (inUrl) continue;
    const cleaned = match[0].replace(/[.,;:!?)"'>]+$/, '');
    results.push({
      raw: match[0],
      kind: 'doi',
      offsetStart: match.index ?? 0,
      offsetEnd: (match.index ?? 0) + cleaned.length,
      contextWindow: makeContext(output, match.index ?? 0, (match.index ?? 0) + cleaned.length),
      identifier: cleaned,
    });
  }

  for (const match of output.matchAll(AUTHOR_YEAR_PATTERN)) {
    results.push({
      raw: match[0],
      kind: 'author_year',
      offsetStart: match.index ?? 0,
      offsetEnd: (match.index ?? 0) + match[0].length,
      contextWindow: makeContext(
        output,
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      ),
      identifier: match[1].trim(),
    });
  }

  // Sort by position — dashboards expect reading order.
  return results.sort((a, b) => a.offsetStart - b.offsetStart);
}

export function hasAnyCitations(output: string): boolean {
  return extractCitations(output).length > 0;
}

export function countCitationsByKind(output: string): Record<ExtractedCitation['kind'], number> {
  const counts = { numbered: 0, author_year: 0, url: 0, doi: 0 };
  for (const c of extractCitations(output)) {
    counts[c.kind]++;
  }
  return counts;
}
