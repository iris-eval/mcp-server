/*
 * Every workflow job that runs the root build installs the dashboard's
 * dependencies first (A6-9's follow-up).
 *
 * Since 0.13.0 `npm run build` builds the dashboard, then the server, so a
 * job that runs it without `dashboard/node_modules` fails on vite's first
 * import. A6-9 swept the workflows for build steps and fixed five; the
 * sixth — the release workflow's `validate` job — was missed, and v0.13.0's
 * first release run failed there before any publish job ran. A sweep is a
 * claim about a set; this file is the enumeration that claim needs, run on
 * every PR.
 *
 * Shape (line-based, no YAML parser in the tree): within each job block of
 * each workflow, a `run:` line that is exactly the root build must be
 * preceded, in the same job, by a step that installs under dashboard/
 * (`cd dashboard && npm install …` or `… npm ci`). Jobs whose default
 * working directory is elsewhere, and steps that build a sub-package
 * (`cd packages/init && npm run build`), are not root builds.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = resolve(__dirname, '..');
const dir = join(root, '.github', 'workflows');

interface Job {
  file: string;
  name: string;
  lines: string[];
}

/** Split a workflow into its jobs: the blocks under `jobs:` at two-space indent. */
function jobsOf(file: string): Job[] {
  const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs: Job[] = [];
  let current: Job | null = null;
  for (const line of lines.slice(start + 1)) {
    const head = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (head) {
      current = { file, name: head[1], lines: [] };
      jobs.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs;
}

const isRootBuild = (l: string): boolean => /^\s*(-\s*)?run:\s*npm run build\s*$/.test(l) || /^\s*npm run build\s*$/.test(l);
const installsDashboard = (l: string): boolean => /cd dashboard && npm (install|ci)\b/.test(l);
const elsewhere = (job: Job): boolean => job.lines.some((l) => /working-directory:\s*(?!\.\s*$)\S+/.test(l));

describe('workflows — the root build never runs before the dashboard is installed', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));

  it('scans every workflow file (guards the enumeration itself)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain('release.yml');
    expect(files).toContain('ci.yml');
  });

  it('every job that runs `npm run build` at the root installs dashboard/ earlier in the same job', () => {
    const offenders: string[] = [];
    let rootBuilds = 0;
    for (const file of files) {
      for (const job of jobsOf(file)) {
        if (elsewhere(job)) continue;
        job.lines.forEach((line, i) => {
          if (!isRootBuild(line)) return;
          rootBuilds += 1;
          const before = job.lines.slice(0, i);
          if (!before.some(installsDashboard)) offenders.push(`${file} → ${job.name}: line "${line.trim()}" has no dashboard install before it`);
        });
      }
    }
    // The shape check must see the real sites: ci.yml (build, e2e), lighthouse.yml, release.yml (validate, publish-npm).
    expect(rootBuilds).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });
});
