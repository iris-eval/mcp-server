/*
 * The prepack guard names what a pack would ship without (A6-9).
 *
 * What this checks, precisely: with an empty dist the guard names every
 * required artifact; with the dashboard bundle absent it names exactly
 * the dashboard files; with everything present it names nothing. The
 * CI build job asserts the same list after a real build, and `npm pack`
 * runs this guard as `prepack`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingArtifacts, REQUIRED_ARTIFACTS } from '../../../scripts/check-pack.mjs';

function scratch(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'iris-check-pack-'));
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), '');
  }
  return root;
}

describe('missingArtifacts', () => {
  it('names every required artifact when dist is empty', () => {
    const root = scratch([]);
    try {
      expect(missingArtifacts(root)).toEqual(REQUIRED_ARTIFACTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the dashboard files when only the server was built — the pre-0.13.0 npm pack', () => {
    const root = scratch(['dist/index.js']);
    try {
      expect(missingArtifacts(root)).toEqual(['dist/dashboard/server.js', 'dist/dashboard/index.html']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names nothing when the server and the dashboard are both present', () => {
    const root = scratch(REQUIRED_ARTIFACTS);
    try {
      expect(missingArtifacts(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
