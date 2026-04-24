import { describe, it, expect } from 'vitest';
import {
  extractCitations,
  hasAnyCitations,
  countCitationsByKind,
} from '../../../../src/eval/citation-verify/extract.js';

describe('citation extractor', () => {
  it('returns empty array for empty output', () => {
    expect(extractCitations('')).toEqual([]);
    expect(hasAnyCitations('')).toBe(false);
  });

  it('extracts numbered citations [1][2][3]', () => {
    const out = extractCitations('Studies show X [1]. Others find Y [2][3]. Also [17].');
    const numbered = out.filter((c) => c.kind === 'numbered');
    expect(numbered).toHaveLength(4);
    expect(numbered.map((c) => c.identifier)).toEqual(['1', '2', '3', '17']);
  });

  it('does not treat [TODO] or [FIXME] as numbered citations', () => {
    const out = extractCitations('Some work here [TODO] and [FIXME: finish]');
    expect(out).toHaveLength(0);
  });

  it('extracts bare URLs', () => {
    const out = extractCitations('See https://example.com/path for details.');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('url');
    expect(out[0].identifier).toBe('https://example.com/path');
  });

  it('strips trailing punctuation from URLs', () => {
    const out = extractCitations('Visit https://example.com/x).');
    expect(out[0].identifier).toBe('https://example.com/x');
  });

  it('extracts DOIs', () => {
    const out = extractCitations('See 10.1234/foo.bar for the paper.');
    const dois = out.filter((c) => c.kind === 'doi');
    expect(dois).toHaveLength(1);
    expect(dois[0].identifier).toBe('10.1234/foo.bar');
  });

  it('extracts author-year citations', () => {
    const out = extractCitations('Prior work (Smith, 2019) suggests X. (Brown et al., 2021) disagrees.');
    const ay = out.filter((c) => c.kind === 'author_year');
    expect(ay).toHaveLength(2);
    expect(ay[0].identifier).toBe('Smith, 2019');
    expect(ay[1].identifier).toBe('Brown et al., 2021');
  });

  it('does not match arbitrary parentheticals without year', () => {
    const out = extractCitations('This (as noted) is important.');
    expect(out.filter((c) => c.kind === 'author_year')).toHaveLength(0);
  });

  it('does not match (just, 1234) with nonsense', () => {
    // Years 1800-2099 only; 1234 out of range
    const out = extractCitations('Ancient text (Author, 1234) exists.');
    expect(out.filter((c) => c.kind === 'author_year')).toHaveLength(0);
  });

  it('returns results sorted by position', () => {
    const out = extractCitations('End https://last.com but first [1] middle (Smith, 2020).');
    const positions = out.map((c) => c.offsetStart);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('includes context window around each citation', () => {
    const output = 'A'.repeat(300) + ' [1] ' + 'B'.repeat(300);
    const out = extractCitations(output);
    expect(out).toHaveLength(1);
    expect(out[0].contextWindow).toContain('[1]');
    // ~400 chars total (200 on each side + the citation)
    expect(out[0].contextWindow.length).toBeGreaterThan(100);
    expect(out[0].contextWindow.length).toBeLessThan(500);
  });

  it('marks context with ellipsis when truncated', () => {
    const output = 'A'.repeat(500) + ' [1] ' + 'B'.repeat(500);
    const out = extractCitations(output);
    expect(out[0].contextWindow.startsWith('…')).toBe(true);
    expect(out[0].contextWindow.endsWith('…')).toBe(true);
  });

  it('counts citations by kind', () => {
    const counts = countCitationsByKind(
      'Intro [1] (Smith, 2019) and more at https://ex.com and 10.1234/nature.05.001',
    );
    expect(counts.numbered).toBe(1);
    expect(counts.author_year).toBe(1);
    expect(counts.url).toBe(1);
    expect(counts.doi).toBe(1);
  });

  it('handles mix of all 4 kinds in reading order', () => {
    const out = extractCitations('1. https://a.com 2. [1] 3. 10.5555/x.y.z 4. (Z, 2020)');
    const kinds = out.map((c) => c.kind);
    // Verify each appears exactly once, in the order they appeared
    expect(kinds).toEqual(['url', 'numbered', 'doi', 'author_year']);
  });

  it('does not match 10.1/short which is below DOI min-digits', () => {
    // Real DOI registrant codes are >=4 digits; we use 4-9 to avoid
    // matching incidental version strings like "Node 10.1/x".
    const out = extractCitations('Node 10.1/foo is here.');
    expect(out.filter((c) => c.kind === 'doi')).toHaveLength(0);
  });
});
