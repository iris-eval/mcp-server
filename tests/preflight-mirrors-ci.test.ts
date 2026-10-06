import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_ONLY, NEXT_TYPES, REACHED_CAP, STEPS, stepsFor, testsToRun } from '../scripts/preflight.mjs';

/*
 * `npm run preflight` is only worth running if it says what CI will say.
 * These hold it to the workflows: every job a pull request runs is a step
 * there or named as CI-only with a reason, every script a mirrored job runs
 * is run there too, and nothing in it points at a job that no longer exists.
 */

const root = resolve(__dirname, '..');
const dir = join(root, '.github', 'workflows');
// LF-normalised: a Windows checkout may carry CRLF.
const read = (f: string): string => readFileSync(join(dir, f), 'utf-8').replace(/\r\n/g, '\n');

/** The workflow's jobs, by id, each with its own text. */
function jobsOf(text: string): Map<string, string> {
  const jobs = new Map<string, string>();
  const at = text.search(/^jobs:\s*$/m);
  if (at < 0) return jobs;
  let current: string | null = null;
  let body: string[] = [];
  for (const line of text.slice(at).split('\n').slice(1)) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) {
      if (current) jobs.set(current, body.join('\n'));
      current = id[1];
      body = [];
    } else if (/^\S/.test(line)) {
      break;
    } else {
      body.push(line);
    }
  }
  if (current) jobs.set(current, body.join('\n'));
  return jobs;
}

/** Whether a workflow runs on pull requests. */
function onPullRequest(text: string): boolean {
  const on = /^on:(.*)\n((?:[ #].*\n|\n)*)/m.exec(text);
  return on !== null && /\bpull_request\b/.test(`${on[1]}\n${on[2]}`);
}

const workflows = readdirSync(dir).filter((f) => f.endsWith('.yml') && onPullRequest(read(f)));
const jobs = new Map<string, string>();
for (const f of workflows) for (const [id, body] of jobsOf(read(f))) jobs.set(`${f}#${id}`, body);

const mirrored = new Set(STEPS.flatMap((s) => s.ci));
const runs = STEPS.map((s) => s.run ?? '').join('\n');

/** Whether a step runs `npm run <name>` (or `npm run -s <name>`), and not merely a script whose name starts with it. */
function runsScript(name: string): boolean {
  for (const phrase of [`npm run ${name}`, `npm run -s ${name}`]) {
    for (let at = runs.indexOf(phrase); at >= 0; at = runs.indexOf(phrase, at + 1)) {
      if (!/[\w:-]/.test(runs[at + phrase.length] ?? '')) return true;
    }
  }
  return false;
}

describe('the preflight says what the pull-request workflows say', () => {
  it('reads the workflows (guards the parser itself)', () => {
    expect(workflows).toEqual(expect.arrayContaining(['ci.yml', 'claims-alignment.yml']));
    for (const job of ['ci.yml#test', 'ci.yml#proof', 'claims-alignment.yml#check-truthbase-regen']) expect(jobs.has(job), job).toBe(true);
  });

  it('every job a pull request runs is a step or CI-only, never both', () => {
    const neither = [...jobs.keys()].filter((j) => !mirrored.has(j) && !(j in CI_ONLY));
    expect(neither, 'add a preflight step for each, or a CI_ONLY entry with the reason').toEqual([]);
    expect([...mirrored].filter((j) => j in CI_ONLY)).toEqual([]);
  });

  it('nothing in it names a job that no longer runs on a pull request', () => {
    expect([...mirrored, ...Object.keys(CI_ONLY)].filter((j) => !jobs.has(j))).toEqual([]);
  });

  it('every script a mirrored job runs, it runs', () => {
    // How CI and the preflight phrase the same check differently, and why that is the same check.
    const sameCheck: Record<string, string> = {
      'test:coverage': 'the preflight runs the same vitest --coverage, adding a JSON report the capture reads',
      'test:integration': 'tests/integration is inside the root suite the preflight runs',
    };
    const missing: string[] = [];
    for (const job of mirrored) {
      const body = jobs.get(job) ?? '';
      for (const m of body.matchAll(/npm run(?: -s)? ([\w:-]+)|(?:node|bash) (scripts\/[\w./-]+)|--config (tests\/[\w./-]+)/g)) {
        const script = m[1] ?? m[2] ?? m[3];
        if (script in sameCheck) continue;
        const ran = m[1] ? runsScript(script) : runs.includes(script);
        if (!ran) missing.push(`${job}: ${m[0]}`);
      }
      for (const m of body.matchAll(/npm run proof -- (--check[^\n]*)/g)) if (!runs.includes(`proof -- ${m[1].trim()}`)) missing.push(`${job}: ${m[0]}`);
    }
    expect(missing).toEqual([]);
  });

  it('runs actionlint at the version CI pins', () => {
    const pinned = /rhysd\/actionlint@sha256:[0-9a-f]{64}/.exec(jobs.get('ci.yml#actionlint') ?? '')?.[0];
    expect(pinned).toBeTruthy();
    expect(runs).toContain(pinned as string);
  });
});

describe('the default preflight is the fast one', () => {
  const names = (full: boolean, changed: string[]) => stepsFor(full, changed).map((s: { name: string }) => s.name);

  it('runs the tests a change reaches, never the whole suite or the builds', () => {
    const fast = names(false, ['src/tools/get-traces.ts']);
    expect(fast).toContain('the tests this change reaches');
    expect(fast).toContain('typecheck');
    expect(fast).not.toContain('every test, with the coverage floors');
    expect(fast).not.toContain('build');
  });

  it("runs the dashboard's checks when the branch touches it or the server source its tests import, and the website's only when it touches the website", () => {
    expect(names(false, ['docs/x.md'])).not.toContain('dashboard tests');
    expect(names(false, ['src/x.ts'])).toContain('dashboard tests');
    expect(names(false, ['src/x.ts'])).not.toContain('website lint and types');
    expect(names(false, ['dashboard/src/App.tsx'])).toContain('dashboard tests');
    expect(names(false, ['website/src/app/page.tsx'])).toContain('website lint and types');
  });

  it('--full runs every mirrored step and none of the fast-only ones', () => {
    const full = names(true, []);
    expect(full).toContain('every test, with the coverage floors');
    expect(full).not.toContain('the tests this change reaches');
    expect(full).not.toContain('website lint and types');
  });

  it("type-checks the website without the route types a local build left behind, as CI's fresh checkout does", () => {
    const tsconfig = readFileSync(join(root, 'website', 'tsconfig.json'), 'utf-8');
    const generated = [...tsconfig.matchAll(/"(\.next\/[^"*]+?)\/\*\*/g)].map((m) => m[1]).sort();
    expect(generated.length).toBeGreaterThan(0);
    expect([...NEXT_TYPES].sort()).toEqual(generated);
    const websiteTypeChecks = STEPS.filter((s: { cwd?: string; run?: string }) => s.cwd === 'website' && s.run?.includes('tsc'));
    expect(websiteTypeChecks.length).toBe(2);
    for (const s of websiteTypeChecks) expect(s.fresh).toEqual(NEXT_TYPES);
  });
});

describe('the fast run picks the tests a change reaches, within a cap', () => {
  it('runs every reached root-suite file, the branch\'s own included, when there are few', () => {
    const r = testsToRun(['tests/a.test.ts', 'tests/b.test.ts'], ['src/x.ts', 'tests/c.test.ts']);
    expect(r.files).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']);
  });

  it('above the cap, runs only the branch\'s own test files and says CI runs the rest', () => {
    const many = Array.from({ length: REACHED_CAP + 1 }, (_, i) => `tests/t${i}.test.ts`);
    const r = testsToRun(many, ['tests/mine.test.ts']);
    expect(r.files).toEqual(['tests/mine.test.ts']);
    expect(r.why).toMatch(/CI runs the rest/);
  });

  it('leaves out the folders that run under their own CI jobs', () => {
    expect(testsToRun(['tests/upgrade/x.test.ts', 'tests/stall/y.test.ts', 'tests/z.test.ts'], []).files).toEqual(['tests/z.test.ts']);
  });
});
