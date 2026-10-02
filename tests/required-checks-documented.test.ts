/*
 * What the repository says blocks a merge is what blocks a merge.
 *
 * Two public statements are about a repository setting no test can read
 * from the tree. CONTRIBUTING.md said "all eleven required checks" and
 * listed eleven while nineteen were required; docs/proof.md said a rule
 * change "cannot merge" without its numbers while the proof job was not a
 * required check.
 *
 * `.github/required-checks.json` is the documented list. This test holds
 * the two documents and the workflows to that file;
 * `scripts/ci/check-required-checks.mjs`, run by the claims workflow on
 * every pull request and push, holds the file to the live setting.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare } from '../scripts/ci/check-required-checks.mjs';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const required = JSON.parse(read('.github/required-checks.json')) as { branch: string; contexts: string[] };
const workflows = readdirSync(join(root, '.github', 'workflows'))
  .filter((f) => f.endsWith('.yml'))
  .map((f) => read(`.github/workflows/${f}`))
  .join('\n');

describe('the required checks, as documented', () => {
  it('the file is a sorted list with no repeats, for main', () => {
    expect(required.branch).toBe('main');
    expect(new Set(required.contexts).size).toBe(required.contexts.length);
    expect([...required.contexts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(required.contexts);
  });

  it('every context is a job some workflow defines, by id or by name', () => {
    for (const context of required.contexts) {
      // `test (22)` and `Real clients (ubuntu-latest)` are one job across a matrix: the part before the bracket names it.
      const base = context.replace(/ \(.*\)$/, '');
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const asId = new RegExp(`^  ${esc}:$`, 'm').test(workflows);
      const asName = new RegExp(`^    name: .*${esc}`, 'm').test(workflows);
      expect(asId || asName, `${context}: no workflow job has the id or name "${base}"`).toBe(true);
    }
  });

  it('CONTRIBUTING.md lists exactly these contexts, and types no count of them', () => {
    const doc = read('CONTRIBUTING.md');
    const section = doc.slice(doc.indexOf('- **CI must pass.**'), doc.indexOf('- **The two claims checks'));
    const listed = [...section.matchAll(/^  \| `([^`]+)` \|/gm)].map((m) => m[1]);
    expect(compare(listed, required.contexts)).toEqual({ missingFromFile: [], notRequired: [] });
    expect(listed.length).toBe(required.contexts.length);
    expect(section).toContain('.github/required-checks.json');
    expect(section).not.toMatch(/\ball (?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|nineteen|twenty[a-z-]*) required checks\b/i);
  });

  it('CONTRIBUTING.md does not send a contributor to a formatter CI never runs', () => {
    const doc = read('CONTRIBUTING.md');
    expect(workflows).not.toMatch(/prettier|format:check/);
    expect(doc).not.toMatch(/npm run format:check/);
    expect(doc).not.toMatch(/\| `npm run format` \|/);
  });

  it('the proof page says a rule change cannot merge without its numbers only while the proof check is required', () => {
    const proof = read('docs/proof.md');
    expect(proof).toMatch(/cannot merge without the committed numbers/);
    expect(required.contexts).toContain('Proof — rule accuracy regen vs committed');
    expect(proof).toContain('.github/required-checks.json');
  });

  it('the claims workflow compares the file with the live branch protection', () => {
    expect(workflows).toMatch(/node scripts\/ci\/check-required-checks\.mjs/);
  });

  it('compare() names a context on either side alone', () => {
    expect(compare(['a', 'b'], ['b', 'c'])).toEqual({ missingFromFile: ['c'], notRequired: ['a'] });
  });
});
