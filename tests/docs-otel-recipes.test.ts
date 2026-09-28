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
  'OpenAI Agents SDK (Python)',
  'OpenAI Agents SDK (JavaScript)',
  'LlamaIndex',
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

  /*
   * The captured recipes are run in CI (tests/otel-recipes/test_recipes_e2e.py)
   * from scripts under examples/otel-recipes/. What the page shows must be what
   * runs: every code line of the recipe is a line of its script, and every
   * package the install line names is pinned where CI installs from.
   */
  const RUN: Record<string, { script: string; pins: string }> = {
    'OpenAI Agents SDK (Python)': { script: 'examples/otel-recipes/openai_agents_run.py', pins: 'examples/otel-recipes/requirements-openai-agents.txt' },
    'OpenAI Agents SDK (JavaScript)': { script: 'examples/otel-recipes/js/openai-agents-run.mjs', pins: 'examples/otel-recipes/js/package.json' },
    LlamaIndex: { script: 'examples/otel-recipes/llamaindex_run.py', pins: 'examples/otel-recipes/requirements-llamaindex.txt' },
  };

  it('a recipe run in CI shows only lines its script runs, and installs only what CI pins', () => {
    for (const [title, { script, pins }] of Object.entries(RUN)) {
      const r = all.find((x) => x.title === title)!;
      expect(r, title).toBeDefined();
      // A lint marker on the script's line (`# noqa: E402`) is not part of what the reader copies.
      const scriptLines = new Set(read(script).split('\n').map((l) => l.replace(/\s+# noqa: [A-Z0-9, ]+$/, '').trim()));
      const blocks = [...r.body.matchAll(/```(?:python|ts)\n([\s\S]*?)```/g)].map((m) => m[1]);
      expect(blocks.length, `${title} shows no code`).toBeGreaterThanOrEqual(2);
      const shown = blocks.join('\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      for (const line of shown) expect(scriptLines.has(line), `${title}: "${line}" is not a line of ${script}`).toBe(true);
      const install = r.body.match(/^(?:pip|npm) install (.+)$/m)?.[1];
      expect(install, `${title} has no install line`).toBeDefined();
      const pinned = pins.endsWith('.json')
        ? new Set(Object.keys((JSON.parse(read(pins)) as { dependencies: Record<string, string> }).dependencies))
        : new Set(read(pins).split('\n').filter((l) => /^[a-z]/.test(l)).map((l) => l.split('==')[0]));
      for (const pkg of install!.split(/\s+/)) expect(pinned.has(pkg), `${title}: ${pkg} is not pinned in ${pins}`).toBe(true);
      expect(existsSync(join(root, r.fixture!.replace('.otlp.json', '.pb'))), `${title}: the captured request body is missing`).toBe(true);
    }
  });

  it('the page is listed in llms.txt and linked from the OTel guide and the README', () => {
    expect(read('website/llms.template.txt')).toContain('docs/otel-recipes.md');
    expect(read('docs/otel-integration.md')).toContain('otel-recipes.md');
    expect(read('README.md')).toContain('docs/otel-recipes.md');
  });
});
