/*
 * The four-way article draft holds to its sources and stays a draft (arc 9, N-21).
 *
 * docs/blog/030-iris-vs-langfuse-vs-phoenix-vs-promptfoo.md is written to be
 * published when the founder says (the acceptance matrix's F-9), not before.
 * Two gates keep it unpublished: `published: false`, which the site honours,
 * and a future `date:`, which the Dev.to crossposter honours — and since
 * arc 9 the crossposter honours `published: false` too, held here. The
 * article's every vendor statement carries a URL, every vendor URL is one
 * the vendor's compare file lists as a source (so a claim on the article
 * cannot outrun the sourced table), and it grades with words a reader can
 * check, never a superlative.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const ARTICLE = 'docs/blog/030-iris-vs-langfuse-vs-phoenix-vs-promptfoo.md';
const article = read(ARTICLE);
const [, frontmatter, body] = article.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
const today = new Date().toISOString().slice(0, 10);

/** Which compare file a vendor URL must be sourced in. */
const VENDOR_DOMAIN: [RegExp, string][] = [
  [/^https:\/\/(langfuse\.com|github\.com\/langfuse)\//, 'langfuse'],
  [/^https:\/\/(arize\.com|github\.com\/Arize-ai)\//, 'arize'],
  [/^https:\/\/(www\.promptfoo\.dev|github\.com\/promptfoo|raw\.githubusercontent\.com\/promptfoo)\//, 'promptfoo'],
];
const VENDOR_NAME = /\b(Langfuse|Phoenix|Arize|Promptfoo)\b/;
/** Grades that state nothing a reader can check. */
const SUPERLATIVE = /\b(the best|best-in-class|leading|the first|the only|fastest|cheapest|number one|#1|unmatched|world-class)\b/i;

const sources = (slug: string): Set<string> => {
  const data = JSON.parse(read(`website/src/lib/compare/${slug}.json`)) as { sources: { url: string }[] };
  return new Set(data.sources.map((s) => s.url));
};

describe('the four-way article draft', () => {
  it('exists with front matter, names the four in its title, and is the next number in the blog', () => {
    expect(frontmatter, ARTICLE).toBeDefined();
    expect(frontmatter).toMatch(/^title: "Iris vs Langfuse vs Phoenix vs Promptfoo/m);
    const numbers = readdirSync(join(root, 'docs', 'blog'))
      .map((f) => /^(\d{3})-/.exec(f)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    expect(Math.max(...numbers)).toBe(30);
  });

  it('is held unpublished by both gates: `published: false` for the site and a future date for the crossposter, which now honours `published: false` as well', () => {
    expect(frontmatter).toMatch(/^published: false$/m);
    const date = /^date: (\d{4}-\d{2}-\d{2})$/m.exec(frontmatter)?.[1];
    expect(date, 'date').toBeDefined();
    expect(date! > today, `date ${date} is not after ${today}`).toBe(true);
    const crosspost = read('scripts/devto-crosspost.mjs');
    expect(crosspost).toMatch(/published[\s\S]{0,80}=== 'false'/);
    expect(crosspost).toContain('SKIP: ${filename} (published: false)');
  });

  it('every paragraph that names a vendor carries a URL, and every vendor URL is a source the vendor’s compare file lists', () => {
    const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#'));
    const naming = paragraphs.filter((p) => VENDOR_NAME.test(p));
    expect(naming.length).toBeGreaterThan(10);
    for (const p of naming) expect(p, p.slice(0, 80)).toMatch(/https:\/\//);
    const urls = [...body.matchAll(/\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(25);
    const checked = new Set<string>();
    for (const url of urls) {
      const hit = VENDOR_DOMAIN.find(([re]) => re.test(url));
      if (!hit) continue;
      expect(sources(hit[1]).has(url), `${url} is not in ${hit[1]}.json sources`).toBe(true);
      checked.add(hit[1]);
    }
    expect([...checked].sort()).toEqual(['arize', 'langfuse', 'promptfoo']);
  });

  it('links the proof page and the compare pages for the Iris side, and grades without a superlative', () => {
    expect(body).toContain('https://iris-eval.com/proof');
    expect(body).toContain('https://iris-eval.com/compare');
    expect(body).not.toMatch(SUPERLATIVE);
    expect(body).toMatch(/^## Where each wins, where each loses$/m);
    for (const name of ['Langfuse', 'Phoenix', 'Promptfoo', 'Iris']) {
      expect(body, name).toMatch(new RegExp(`\\*\\*${name} wins\\*\\*`));
      expect(body, name).toMatch(/\*\*It loses\*\*/);
    }
  });
});
