// Release generator — reads CHANGELOG.md headers + package.json for the
// current release version + date.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

// Matches `## [X.Y.Z] - YYYY-MM-DD` (the first such header is the current release).
const RELEASE_HEADER_RE = /^##\s*\[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/m;

export async function generate() {
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf-8');
  const m = changelog.match(RELEASE_HEADER_RE);
  if (!m) {
    return {
      currentReleaseVersion: null,
      currentReleaseDate: null,
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
    nextPlannedVersion: null,
    nextPlannedScope: null,
  };
}
