/*
 * The capability map is the roadmap.
 *
 * docs/roadmap.md said in prose what docs/capabilities.md says from the
 * truthbase — every evaluation question against every subject, with what
 * Iris has, has with a limit, and lacks. Two roadmaps meant one of them was
 * always behind: the file still listed OpenTelemetry ingest and datasets as
 * open a release after they shipped. The file is gone, /roadmap redirects
 * to the map, and this holds the three things that keep it gone: no live
 * surface links the deleted file, the redirect is there and permanent, and
 * the tracks on the site do not call shipped work planned.
 *
 * The last one is the same guard docs-contract.test.ts applies to run
 * comparison, keyed the same way — on what the product actually registers —
 * so it cannot go stale in either direction.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const claims = JSON.parse(read('.claims.json')) as { mcpTools: { names: string[] }; capabilityMap?: unknown };

/**
 * Every tracked text surface a reader could follow, minus the dated
 * artifacts that are frozen by design: the blog and the launch drafts say
 * what was true when they were written, and changelog.generated.json is
 * CHANGELOG.md rendered — a release note that says a file was REMOVED has
 * to be able to name it. (The same exclusions the hardcoded-claim scanner
 * makes, for the same reason.)
 */
function liveSurfaces(): string[] {
  const out: string[] = ['README.md'];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel))) {
      const child = `${rel}/${entry}`;
      if (['node_modules', '.next', 'dist', 'blog', 'launch', 'changelog.generated.json'].includes(entry)) continue;
      if (statSync(join(root, child)).isDirectory()) walk(child);
      else if (/\.(md|mdx|ts|tsx|json|mjs)$/.test(entry)) out.push(child);
    }
  };
  walk('docs');
  walk('website/src');
  walk('scripts');
  return out;
}

describe('the roadmap is the capability map', () => {
  it('docs/roadmap.md is gone, and the map it deferred to is still rendered', () => {
    expect(existsSync(join(root, 'docs', 'roadmap.md'))).toBe(false);
    expect(existsSync(join(root, 'docs', 'capabilities.md'))).toBe(true);
    expect(claims.capabilityMap, 'the map comes from the truthbase').toBeDefined();
  });

  it('no live surface links the deleted file, and the scanner no longer exempts it', () => {
    const offenders = liveSurfaces().filter((rel) => /roadmap\.md/.test(read(rel)));
    expect(offenders, 'these still link docs/roadmap.md').toEqual([]);
    const allow = JSON.parse(read('scripts/claims/allow-list.json')) as { entries: { file: string }[] };
    expect(allow.entries.filter((e) => e.file === 'docs/roadmap.md')).toEqual([]);
  });

  it('/roadmap redirects to /capabilities, permanently', () => {
    const config = read('website/next.config.ts');
    const block = config.slice(config.indexOf('redirects:'));
    const match = /\{\s*source: "\/roadmap",\s*destination: "([^"]+)",\s*permanent: (true|false),\s*\}/.exec(block);
    expect(match, 'a /roadmap redirect in next.config.ts').not.toBeNull();
    expect(match![1]).toBe('/capabilities');
    expect(match![2]).toBe('true');
  });

  it('the tracks on the site do not call shipped work planned', () => {
    const roadmap = read('website/src/components/roadmap.tsx');
    // Keyed on what ships, so it cannot go stale in either direction.
    expect(claims.mcpTools.names).toContain('compare_runs');
    expect(existsSync(join(root, 'src', 'storage', 'migrations', '012-datasets.ts')), 'datasets shipped').toBe(true);
    expect(existsSync(join(root, 'src', 'ingest', 'otlp.ts')) || existsSync(join(root, 'src', 'dashboard', 'routes', 'otlp.ts')), 'the OTLP door shipped').toBe(true);
    const stale = [...roadmap.matchAll(/(?:still planned|still open|not shipped)[^.\n]{0,220}/gi)]
      .map((m) => m[0])
      .filter((s) => /\b(datasets|OpenTelemetry ingest|OTLP|run comparison|compare_runs)\b/i.test(s));
    expect(stale, 'a track calls shipped work planned').toEqual([]);
  });
});
