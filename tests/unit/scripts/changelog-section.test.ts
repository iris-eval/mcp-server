/*
 * scripts/changelog-section.mjs — the release page's notes, from CHANGELOG.md.
 *
 * GitHub keeps a release body to 125,000 characters, and the release action
 * cuts anything past that without saying so, after appending GitHub's own
 * list of merged pull requests. A section that does not fit is condensed:
 * everything before its first `### ` heading stays whole (the summary and
 * "Check before upgrading"), each later entry keeps its lead sentence, and a
 * link points at the notes in full. The last test holds the notes being
 * written now to that budget, so a release is never refused for its notes on
 * the day it is tagged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module
import { fitSection, sectionOf } from '../../../scripts/changelog-section.mjs';

const root = resolve(__dirname, '..', '..', '..');
const REPO = 'https://github.com/example/project';
/** The budget release.yml passes to --fit. */
const RELEASE_BUDGET = 90_000;

const changelog = [
  '# Changelog',
  '',
  '## [2.0.0] - 2026-10-10',
  '',
  '**One summary sentence.**',
  '',
  '**Check before upgrading.**',
  '',
  '- **A gate now fails what it used to pass.** Every word of this stays, because a reader must act on it.',
  '',
  '### Added',
  '',
  '- **A new tool.** ' + 'Detail. '.repeat(200),
  '  - A nested detail that the condensed page leaves out.',
  '',
  '### Fixed',
  '',
  '- **A fixed bug.** ' + 'More detail. '.repeat(200),
  '',
  '## [1.0.0] - 2026-01-01',
  '',
  '- **Older.** Not part of 2.0.0.',
].join('\n');

describe('changelog-section', () => {
  it('reads one version, heading included, up to the next version', () => {
    const s = sectionOf(changelog, '2.0.0') as string;
    expect(s.startsWith('## [2.0.0] - 2026-10-10')).toBe(true);
    expect(s).not.toContain('Older.');
    expect(sectionOf(changelog, '3.0.0')).toBeNull();
  });

  it('prints a section that fits whole', () => {
    const s = sectionOf(changelog, '2.0.0') as string;
    expect(fitSection(s, '2.0.0', s.length, REPO)).toBe(s);
  });

  it('condenses one that does not: the summary and "Check before upgrading" whole, every later entry by its lead, and a link to the rest', () => {
    const s = sectionOf(changelog, '2.0.0') as string;
    const fitted = fitSection(s, '2.0.0', 1_500, REPO) as string;
    expect(fitted.length).toBeLessThanOrEqual(1_500);
    expect(fitted).toContain('**One summary sentence.**');
    expect(fitted).toContain('- **A gate now fails what it used to pass.** Every word of this stays, because a reader must act on it.');
    expect(fitted).toContain('### Added');
    expect(fitted).toContain('- **A new tool.**');
    expect(fitted).toContain('### Fixed');
    expect(fitted).toContain('- **A fixed bug.**');
    expect(fitted).not.toContain('Detail. Detail.');
    expect(fitted).not.toContain('nested detail');
    expect(fitted).toContain(`(${REPO}/blob/v2.0.0/CHANGELOG.md)`);
  });

  it('refuses a section whose condensed form still does not fit, rather than cutting it', () => {
    const s = sectionOf(changelog, '2.0.0') as string;
    expect(fitSection(s, '2.0.0', 200, REPO)).toBeNull();
  });

  it('the notes being written now fit the release page', () => {
    const text = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    const unreleased = sectionOf(text, 'Unreleased') as string;
    expect(unreleased).not.toBeNull();
    const fitted = fitSection(unreleased, 'Unreleased', RELEASE_BUDGET, REPO);
    expect(fitted, 'the summary and "Check before upgrading" alone are over the release page budget').not.toBeNull();
    expect((fitted as string).length).toBeLessThanOrEqual(RELEASE_BUDGET);
  });

  it('release.yml uses the same budget where it composes the page and where it refuses a tag', () => {
    const release = readFileSync(resolve(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const uses = release.match(/changelog-section\.mjs "[^"]+" --fit (\d+)/g) ?? [];
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(u.endsWith(`--fit ${RELEASE_BUDGET}`)).toBe(true);
  });
});
