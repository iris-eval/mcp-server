/*
 * The OTel recipes page: every recipe names a fixture that
 * exists, every convention fixture is named by a recipe, the nine
 * frameworks the arc committed to are each a recipe with a source, and
 * the page is where a reader and an agent are told to look (llms.txt, the
 * OTel guide, the README). A recipe that named no fixture would be a claim.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const page = read('docs/otel-recipes.md');

const FRAMEWORKS = [
  'Pydantic AI',
  'Google ADK',
  "LangGraph via LangSmith's export",
  'CrewAI via OpenInference',
  'AutoGen',
  'Microsoft Agent Framework',
  'Semantic Kernel',
  'Vercel AI SDK',
  'Mastra',
];

interface Recipe {
  title: string;
  body: string;
  fixture: string | null;
  sources: string[];
}

function recipes(): Recipe[] {
  const out: Recipe[] = [];
  const parts = page.split(/^### /m).slice(1);
  for (const part of parts) {
    const [title, ...rest] = part.split('\n');
    const body = rest.join('\n');
    const fixture = body.match(/^Proved by: `([^`]+)`$/m)?.[1] ?? null;
    const sources = [...body.matchAll(/^Source: (.+)$/gm)].flatMap((m) => m[1].split(' · ').map((s) => s.trim()));
    out.push({ title: title.trim(), body, fixture, sources });
  }
  return out;
}

describe('docs/otel-recipes.md', () => {
  const all = recipes();

  it('is one recipe per framework the arc committed to, in that order', () => {
    expect(all.map((r) => r.title)).toEqual(FRAMEWORKS);
  });

  it('every recipe names a fixture that exists, on its own "Proved by" line', () => {
    for (const r of all) {
      expect(r.fixture, `${r.title} names no fixture`).not.toBeNull();
      expect(r.fixture!.startsWith('tests/fixtures/otlp/'), `${r.title}: ${r.fixture}`).toBe(true);
      expect(existsSync(join(root, r.fixture!)), `${r.title}: ${r.fixture} does not exist`).toBe(true);
    }
  });

  it('every convention fixture is named by a recipe, so a fixture without a recipe is as visible as a recipe without a fixture', () => {
    const conventions = readdirSync(join(root, 'tests', 'fixtures', 'otlp', 'conventions')).filter((f) => f.endsWith('.otlp.json'));
    expect(conventions.length).toBeGreaterThanOrEqual(8);
    const named = new Set(all.map((r) => r.fixture!.split('/').pop()));
    const unnamed = conventions.filter((f) => !named.has(f) && !page.includes(`\`${f}\``));
    expect(unnamed).toEqual([]);
  });

  it('a recipe proved by the captured GenAI fixture says so — the vocabulary, not the framework\'s own capture', () => {
    for (const r of all.filter((x) => x.fixture === 'tests/fixtures/otlp/python-genai.otlp.json')) {
      expect(r.body, r.title).toMatch(/proves the vocabulary/);
      expect(r.body, r.title).toMatch(/not in the set/);
    }
    expect(all.filter((x) => x.fixture === 'tests/fixtures/otlp/python-genai.otlp.json').map((r) => r.title)).toEqual(['AutoGen', 'Mastra']);
  });

  it('every recipe cites the vendor page it was read from, points at the OTLP door, and says what Iris reads', () => {
    for (const r of all) {
      expect(r.sources.length, `${r.title} cites no source`).toBeGreaterThan(0);
      for (const s of r.sources) expect(s, `${r.title}: ${s}`).toMatch(/^https:\/\/[^\s]+$/);
      expect(r.body, `${r.title} does not name the door`).toMatch(/127\.0\.0\.1:6920/);
      expect(r.body, `${r.title} does not say what Iris reads`).toMatch(/^What Iris reads:/m);
    }
  });

  it('the page is listed in llms.txt and linked from the OTel guide and the README', () => {
    expect(read('website/llms.template.txt')).toContain('docs/otel-recipes.md');
    expect(read('docs/otel-integration.md')).toContain('otel-recipes.md');
    expect(read('README.md')).toContain('docs/otel-recipes.md');
  });
});
