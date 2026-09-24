/*
 * The release narrative is rendered from the changelog, never written twice.
 *
 * website/src/lib/changelog.generated.json is what the site's /releases page
 * renders; website/scripts/render-changelog.mjs writes it from CHANGELOG.md.
 * This file locks the three copies of the release story to each other: the
 * committed render equals a fresh render of the changelog; its current
 * release is the truthbase's current release with the same headline (the
 * nav banner's word); every entry under every heading is a real changelog
 * bullet; the history lists every production and pre-release section in
 * file order; and the page, the sitemap and the nav banner read from it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, renderToString } from '../website/scripts/render-changelog.mjs';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const changelog = read('CHANGELOG.md');
const committed = read('website/src/lib/changelog.generated.json');
const claims = JSON.parse(read('.claims.json')) as {
  version: { mcpServer: string };
  release: { currentReleaseVersion: string | null; currentReleaseDate: string | null; currentReleaseHeadline: string | null };
};

type Rendered = ReturnType<typeof render>;

describe('changelog.generated.json', () => {
  it('equals a fresh render of CHANGELOG.md', () => {
    expect(committed).toBe(renderToString(changelog));
  });

  it('its current release is the truthbase’s current release, with the same headline the nav banner shows', () => {
    const data = JSON.parse(committed) as Rendered;
    expect(data.current.version).toBe(claims.release.currentReleaseVersion);
    expect(data.current.date).toBe(claims.release.currentReleaseDate);
    expect(data.current.lead).toBe(claims.release.currentReleaseHeadline);
    expect(data.current.version).toBe(claims.version.mcpServer);
  });

  it('lists every version section of the changelog, in file order, and the current release is the first production one', () => {
    const data = JSON.parse(committed) as Rendered;
    const headings = [...changelog.matchAll(/^##\s*\[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/gm)].map((m) => [m[1], m[2]]);
    expect(data.history.map((r) => [r.version, r.date])).toEqual(headings);
    expect(data.current.version).toBe(headings.map((h) => h[0]).find((v) => !v.includes('-')));
  });

  it('every item under every heading of the current release is a bullet of that section in the changelog', () => {
    const data = JSON.parse(committed) as Rendered;
    const start = changelog.indexOf(`## [${data.current.version}]`);
    const rest = changelog.slice(start + 1);
    const end = rest.search(/^## \[/m);
    const section = rest.slice(0, end === -1 ? undefined : end);
    expect(data.current.sections.length).toBeGreaterThan(0);
    for (const s of data.current.sections) {
      expect(section, s.title).toContain(`### ${s.title}`);
      for (const item of s.items) expect(section, item.slice(0, 60)).toContain(`- ${item.split('\n')[0]}`);
    }
    for (const paragraph of data.current.intro) expect(section.replace(/\n/g, ' ')).toContain(paragraph.slice(0, 80));
  });
});

describe('the surfaces read from the render', () => {
  it('the releases page imports the generated file and the truthbase version; the sitemap lists it; the nav banner links it', () => {
    const page = read('website/src/app/releases/page.tsx');
    expect(page).toContain('@/lib/changelog.generated.json');
    expect(page).toMatch(/CURRENT_RELEASE_VERSION/);
    expect(read('website/src/app/sitemap.ts')).toContain('page("/releases"');
    expect(read('website/src/components/nav.tsx')).toContain('href="/releases"');
  });

  it('the render and the check are npm scripts, and CI runs the check beside the other rendered surfaces', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['changelog:render']).toContain('render-changelog.mjs');
    expect(pkg.scripts['changelog:check']).toContain('--check');
    expect(read('.github/workflows/claims-alignment.yml')).toContain('npm run changelog:check');
  });
});
