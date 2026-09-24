/*
 * The compare pages are data, and every vendor cell has a source and a date.
 *
 * website/src/lib/compare/<vendor>.json is the vendor's side of a fixed set of
 * features — the same set on every page (lib/compare/iris.ts) — with, for
 * every cell, the vendor's own page as its source, a verbatim quote from it,
 * and the date it was read. This file locks the set: every JSON file in the
 * directory is in the index and vice versa; every file carries exactly the
 * feature ids in order; every cell, reason, FAQ half and TL;DR has an
 * https source and a real date not in the future; the vendor text carries no
 * editorial adjectives; the Iris side carries no typed number (its counts
 * come from the truthbase); the eight hand-written pages are gone and the
 * one dynamic page renders the index; the compare index page and the sitemap
 * read the same list; and every OG image a file names exists. Arc 9, N-21
 * added the cost_to_run row (read from a pricing page or saying the page does
 * not answer), the five-question FAQ (two written, three derived from the
 * rows by lib/compare/faq.ts) rendered on the page, and the playground link.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const dir = join(root, 'website', 'src', 'lib', 'compare');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const FEATURE_IDS = ['integration', 'self_hosting', 'overhead', 'eval', 'cost_tracking', 'mcp_support', 'license', 'ownership', 'dashboard', 'frameworks', 'prompt_management', 'enterprise', 'cost_to_run'];
/** The three FAQ questions derived from the table, in page order (lib/compare/faq.ts). */
const DERIVED_FAQ_IDS = ['cost_to_run', 'self_hosting', 'mcp_support'];
const VERDICTS = ['iris', 'vendor', 'neither'];
const CATEGORIES = ['Observability', 'Evaluation', 'Safety', 'Testing'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS = /^https:\/\/[^\s]+$/;
/** Words that grade rather than state; a vendor cell states. */
const EDITORIAL = /\b(powerful|slow|costly|weak|best|worst|clunky|bloated|superior|inferior)\b/i;

interface Row { id: string; vendor: string; verdict: string; sourceUrl: string; quote: string; lastVerified: string; quoteVerified: boolean | null }
interface Data {
  slug: string; name: string; homepage: string; category: string; tagline: string; oneLine: string; ogImage: string | null;
  tldrVendor: string; tldrSourceUrl: string; rows: Row[]; vendorReasons: { text: string; sourceUrl: string }[];
  faq: { question: string; vendorPart: string; sourceUrl: string }[]; sources: { label: string; url: string; lastVerified: string }[]; lastVerified: string;
  quotesCheckedOn: string;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const data: Data[] = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Data);
const index = read('website/src/lib/compare/index.ts');
const today = new Date().toISOString().slice(0, 10);

describe('the compare data', () => {
  it('every JSON file is in the index and every index import is a file; slugs match file names', () => {
    const imported = [...index.matchAll(/from "\.\/([a-z0-9-]+)\.json"/g)].map((m) => m[1]).sort();
    expect(imported).toEqual(files.map((f) => f.replace(/\.json$/, '')));
    for (const [i, d] of data.entries()) expect(`${d.slug}.json`).toBe(files[i]);
    expect(data.length).toBeGreaterThanOrEqual(14);
  });

  it(`every file carries the ${FEATURE_IDS.length} features in order, a verdict the page knows, a category the index knows, and a name`, () => {
    for (const d of data) {
      expect(d.rows.map((r) => r.id), d.slug).toEqual(FEATURE_IDS);
      for (const r of d.rows) expect(VERDICTS, `${d.slug}/${r.id}`).toContain(r.verdict);
      expect(CATEGORIES, d.slug).toContain(d.category);
      expect(d.name.length, d.slug).toBeGreaterThan(1);
      expect(d.tagline, d.slug).toMatch(/^MCP-Native/);
      expect(d.homepage, d.slug).toMatch(HTTPS);
    }
  });

  it('every vendor cell, reason, FAQ half and TL;DR has an https source, a verbatim quote where a cell, and a date not in the future', () => {
    for (const d of data) {
      expect(d.lastVerified, d.slug).toMatch(DATE);
      expect(d.lastVerified <= today, d.slug).toBe(true);
      for (const r of d.rows) {
        const at = `${d.slug}/${r.id}`;
        expect(r.vendor.trim().length, at).toBeGreaterThan(2);
        expect(r.vendor.length, at).toBeLessThanOrEqual(160);
        expect(r.sourceUrl, at).toMatch(HTTPS);
        expect(r.quote.trim().length, at).toBeGreaterThan(2);
        expect(r.lastVerified, at).toMatch(DATE);
        expect(r.lastVerified <= today, at).toBe(true);
        expect(r.lastVerified <= d.lastVerified, at).toBe(true);
        expect(r.vendor, at).not.toMatch(EDITORIAL);
      }
      expect(d.vendorReasons.length, d.slug).toBeGreaterThanOrEqual(3);
      for (const x of d.vendorReasons) expect(x.sourceUrl, `${d.slug} reason`).toMatch(HTTPS);
      expect(d.faq.length, d.slug).toBe(2);
      for (const f of d.faq) expect(f.sourceUrl, `${d.slug} faq`).toMatch(HTTPS);
      expect(d.tldrSourceUrl, d.slug).toMatch(HTTPS);
      expect(d.sources.length, d.slug).toBeGreaterThan(0);
      const urls = new Set(d.sources.map((s) => s.url));
      for (const r of d.rows) expect(urls.has(r.sourceUrl), `${d.slug}/${r.id}: source not in the sources list`).toBe(true);
      if (d.ogImage) expect(existsSync(join(root, 'website', 'public', d.ogImage.replace(/^\//, ''))), `${d.slug}: ${d.ogImage}`).toBe(true);
    }
  });

  it('every quote carries its verification: true when found verbatim on a plain download of the page, false when not, null when the page does not answer; the file says when it checked', () => {
    for (const d of data) {
      expect(d.quotesCheckedOn, d.slug).toMatch(DATE);
      expect(d.quotesCheckedOn <= today, d.slug).toBe(true);
      for (const r of d.rows) {
        const at = `${d.slug}/${r.id}`;
        if (/Not stated in the vendor/.test(r.vendor)) expect(r.quoteVerified, at).toBeNull();
        else expect(typeof r.quoteVerified, at).toBe('boolean');
      }
    }
    const page = read('website/src/app/compare/[slug]/page.tsx');
    expect(page).toMatch(/row\.quoteVerified \? \{ title: row\.quote \}/);
    expect(page).toContain('quote unverified');
  });

  it('the cost_to_run row is read from a pricing page, or names free in the vendor’s words, or says the page does not answer', () => {
    for (const d of data) {
      const r = d.rows.find((x) => x.id === 'cost_to_run')!;
      const ok = /pricing/i.test(r.sourceUrl) || /^Not stated in the vendor/.test(r.vendor) || /\bfree\b/i.test(r.quote);
      expect(ok, `${d.slug}/cost_to_run: ${r.sourceUrl}`).toBe(true);
    }
    const iris = read('website/src/lib/compare/iris.ts');
    expect(iris).toMatch(/cost_to_run: "Free/);
  });

  it('a cell the vendor’s pages do not answer says so in the vendor’s own words, never with an invented value', () => {
    for (const d of data) for (const r of d.rows) {
      if (/Not stated in the vendor/.test(r.vendor)) expect(r.quote, `${d.slug}/${r.id}`).toMatch(/not stated|no page|nothing found|does not mention/i);
    }
  });
});

describe('the Iris side and the pages', () => {
  it('the Iris cells carry no typed number — every count is read from the truthbase', () => {
    const iris = read('website/src/lib/compare/iris.ts');
    const cells = iris.slice(iris.indexOf('export const IRIS_CELL'), iris.indexOf('export const IRIS_NEUTRAL'));
    const literalNumbers = cells.replace(/\$\{[^}]+\}/g, '').match(/\b\d+\b/g) ?? [];
    expect(literalNumbers).toEqual([]);
    for (const name of ['RULE_COUNT_BUILT_IN', 'CUSTOM_RULE_TYPE_COUNT', 'LLM_JUDGE_TEMPLATE_COUNT', 'MCP_TOOL_COUNT', 'CLIENTS']) expect(iris).toContain(name);
  });

  it('the hand-written vendor pages are gone; one dynamic page renders the index; the compare index and the sitemap read the same list', () => {
    const app = join(root, 'website', 'src', 'app', 'compare');
    const folders = readdirSync(app, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(folders).toEqual(['[slug]']);
    const page = read('website/src/app/compare/[slug]/page.tsx');
    expect(page).toContain('generateStaticParams');
    expect(page).toMatch(/from "@\/lib\/compare"/);
    expect(page).toContain('NOT_SERVER_TESTING');
    const indexPage = read('website/src/app/compare/page.tsx');
    expect(indexPage).toMatch(/COMPARISONS/);
    expect(indexPage).toContain('NOT_SERVER_TESTING');
    expect(indexPage).not.toMatch(/slug: "langfuse"/);
    const sitemap = read('website/src/app/sitemap.ts');
    expect(sitemap).toMatch(/COMPARISONS/);
    expect(sitemap).not.toMatch(/"langfuse",/);
  });

  it('the FAQ is five questions — two written in the JSON, three derived from the rows — rendered on the page and emitted as FAQPage JSON-LD, and the page links the playground', () => {
    const faq = read('website/src/lib/compare/faq.ts');
    const ids = [...faq.matchAll(/\{ id: "([a-z_]+)", question:/g)].map((m) => m[1]);
    expect(ids).toEqual(DERIVED_FAQ_IDS);
    for (const id of DERIVED_FAQ_IDS) expect(FEATURE_IDS).toContain(id);
    expect(faq).toContain('IRIS_CELL[id]');
    expect(faq).toMatch(/derivedVendorPart\(c\.name, row\.vendor, row\.lastVerified\)/);
    const page = read('website/src/app/compare/[slug]/page.tsx');
    expect(page).toContain('const faq = faqFor(c);');
    expect(page).toMatch(/mainEntity: faq\.map/);
    expect(page).not.toMatch(/c\.faq\.map/);
    expect(page).toContain('{faq.map((f) => (');
    expect(page).toContain('The questions buyers ask.');
    expect(page).toContain('href="/playground"');
    expect(page).toContain('{FEATURE_IDS.length} features, the same {FEATURE_IDS.length} on every comparison');
    expect(read('website/src/app/compare/page.tsx')).toContain('The same {FEATURE_IDS.length} features on every page');
    for (const d of data) for (const id of DERIVED_FAQ_IDS) expect(d.rows.some((r) => r.id === id), `${d.slug}/${id}`).toBe(true);
  });

  it('page-dates carries every comparison route', () => {
    const dates = read('website/src/lib/page-dates.ts');
    for (const d of data) expect(dates, d.slug).toContain(`"/compare/${d.slug}":`);
  });
});
