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

  return {
    currentReleaseVersion: m[1],
    currentReleaseDate: m[2],
    nextPlannedVersion: '0.5.0',
    nextPlannedScope: 'Cloud SKU foundation',
  };
}
