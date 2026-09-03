// Release generator — reads CHANGELOG.md headers + package.json for the
// current release version + date.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

// Matches `## [X.Y.Z] - YYYY-MM-DD` (the first such header is the current release).
const RELEASE_HEADER_RE = /^##\s*\[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/m;

// The release's own one-line title: the bold lead sentence directly under
// its header (`**The acceptance-test release.** Seven simulated...`). Every
// release since 0.4.5 opens this way. It feeds the website's event banner,
// which used to restate the PREVIOUS release's feature list as prose and
// read "v0.5.0 Iris v0.4" for two releases beside a pill that rendered the
// live version. Bounded to the current release's section so a release
// without a lead line yields null (the banner falls back) rather than
// borrowing the next section's.
const NEXT_HEADER_RE = /^##\s*\[/m;
const HEADLINE_RE = /^\*\*([^*\n]+?)\*\*/m;

function headlineFor(changelog, headerMatch) {
  const afterHeader = changelog.slice(headerMatch.index + headerMatch[0].length);
  const end = afterHeader.search(NEXT_HEADER_RE);
  const section = end === -1 ? afterHeader : afterHeader.slice(0, end);
  const h = section.match(HEADLINE_RE);
  if (!h) return null;
  return h[1].trim().replace(/[.:]+$/, '') || null;
}

export async function generate() {
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf-8');
  const m = changelog.match(RELEASE_HEADER_RE);
  if (!m) {
    return {
      currentReleaseVersion: null,
      currentReleaseDate: null,
      currentReleaseHeadline: null,
      nextPlannedVersion: null,
      nextPlannedScope: null,
    };
  }

  /*
   * nextPlannedVersion / nextPlannedScope are deliberately null.
   *
   * They used to be hardcoded to '0.5.0' / 'Cloud SKU foundation'. That was
   * a planning intention baked into a file whose entire purpose is to be
   * DERIVED truth, and because .claims.json feeds every public surface, it
   * kept re-injecting a roadmap that had been retired — the Cloud-tier
   * ladder was replaced by three tracks (see docs/roadmap.md) and the
   * hosted work is explicitly "under consideration, not under construction".
   *
   * Work is now tracked by track, not by a predicted version number, and
   * nothing here should assert a next version until one is actually cut.
   * If a future release genuinely has a committed next version, derive it
   * from a real source rather than restating it here.
   */
  return {
    currentReleaseVersion: m[1],
    currentReleaseDate: m[2],
    currentReleaseHeadline: headlineFor(changelog, m),
    nextPlannedVersion: null,
    nextPlannedScope: null,
  };
}
