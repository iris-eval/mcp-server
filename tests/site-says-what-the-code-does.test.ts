/*
 * Statements on the site and the README that were not true of the code,
 * each held here to the thing it describes.
 *
 *   - The live playground said the rules ran "in your browser". The page
 *     posts the text to the site's server.
 *   - The website's Cursor button installed Iris under the key `server`;
 *     the README's, and every other surface, use `iris-eval`.
 *   - A homepage stat rendered its number without its unit ("9" above
 *     "Median eval latency"), and two cards carried numbers nothing
 *     measured ("60s to first trace", "$0.07 avg cost visibility per trace").
 *   - A learn page said the verdict is "decided by the threshold" and that
 *     how the composed verdict performs "is not yet measured". The composer
 *     never consults the score, and /proof publishes the verdict's numbers.
 *   - The downloads badge counted, for the most part, this repository's own
 *     CI installing the previous release.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...files(rel, ext));
    else if (ext.test(name)) out.push(relative(root, join(root, rel)).replace(/\\/g, '/'));
  }
  return out;
}
const site = files('website/src', /\.tsx?$/);

describe('the live playground says where the text goes', () => {
  const page = read('website/src/app/playground/live/page.tsx');
  const component = read('website/src/components/playground/live-playground.tsx');
  const route = read('website/src/app/api/playground/eval/route.ts');

  it('posts to the server, and no description says it runs in the browser', () => {
    expect(component).toContain('fetch("/api/playground/eval"');
    for (const text of [page, component]) expect(text).not.toMatch(/in (?:your|the) browser/i);
    expect(page).toMatch(/on our server/);
  });

  it('tells the reader what is sent and what is kept, beside the box', () => {
    expect(component).toContain('data-playground-disclosure');
    expect(component).toMatch(/sent to iris-eval\.com/);
    expect(component).toMatch(/not stored and not logged/);
    expect(component).toMatch(/Do not paste real personal data/);
  });

  it('the route logs no text: every log line is built from the hash, the category, a length bucket, the result and a duration', () => {
    const logs = route.split('\n').filter((l, i, all) => /console\.(log|warn|error)\(/.test(l) || /console\.(log|warn|error)\(\s*$/.test(all[i - 1] ?? ''));
    expect(logs.length).toBeGreaterThan(2);
    for (const line of logs) expect(line, line.trim()).not.toMatch(/data\.(output|input|expected)\b(?!\.length)|\bbody\b/);
    // Nothing is written anywhere but the rate-limit counter.
    expect(route).not.toMatch(/redis\.(set|lpush|rpush|hset|append)\(/);
  });
});

describe('the install buttons agree on the key', () => {
  it('no Cursor link installs Iris as "server"', () => {
    const readme = read('README.md');
    const install = read('website/src/components/install.tsx');
    expect(readme).toMatch(/cursor\.com\/install-mcp\?name=iris-eval&/);
    expect(install).toMatch(/mcp\/install\?name=iris-eval&/);
    for (const f of site) expect(read(f), f).not.toMatch(/[?&]name=server\b/);
  });
});

describe('homepage numbers', () => {
  it('a static stat renders its prefix and its unit', () => {
    const stats = read('website/src/components/stats.tsx');
    const staticBranch = stats.slice(stats.indexOf('{s.static ? ('), stats.indexOf(') : ('));
    expect(staticBranch).toContain('{s.prefix}');
    expect(staticBranch).toContain('{s.value}');
    expect(staticBranch).toContain('{s.suffix}');
  });

  it('every card metric is read from the truthbase, never typed', () => {
    const cards = read('website/src/components/customers.tsx');
    const metrics = [...cards.matchAll(/^\s*metric:\s*(.+),\s*$/gm)].map((m) => m[1]);
    expect(metrics.length).toBe(3);
    for (const m of metrics) expect(m, m).toMatch(/^String\([A-Z_]+\)$/);
  });

  it('no surface shows an npm downloads badge', () => {
    for (const f of [...site, 'README.md']) expect(read(f), f).not.toMatch(/img\.shields\.io\/npm\/d[tmwy18]*\//);
  });
});

describe('the learn page describes the verdict the server composes', () => {
  const page = read('website/src/app/learn/output-quality-score/page.tsx');

  it('does not say the verdict is thresholded, unmeasured, or weighted by configuration', () => {
    expect(page).not.toMatch(/decided by the threshold/);
    expect(page).not.toMatch(/not yet measured/);
    expect(page).not.toMatch(/configurable weights/);
  });

  it('says the score is never consulted, and points at the measurement', () => {
    expect(page).toMatch(/the score is never consulted for it/);
    expect(page).toMatch(/how often the composed verdict is, are measured and published/);
    expect(page).toContain('href="/proof"');
  });
});

describe('this repository is not counted among its own users', () => {
  const ci = read('.github/workflows/ci.yml').replace(/\r\n/g, '\n');
  const job = ci.slice(ci.indexOf('\n  upgrade:\n'), ci.indexOf('\n  # Real MCP clients against the config'));

  it('the upgrade job takes the previous release from a cache, and from the registry only on a miss', () => {
    expect(job.length).toBeGreaterThan(200);
    expect(job).toMatch(/uses: actions\/cache@[0-9a-f]{40}\s+# v\d/);
    expect(job).toMatch(/key: iris-previous-release-\$\{\{ steps\.previous\.outputs\.version \}\}/);
    const pack = job.slice(job.indexOf('- name: Fetch it from the registry once'));
    expect(pack).toMatch(/^\s+if: steps\.tarball\.outputs\.cache-hit != 'true'$/m);
    expect(pack).toMatch(/npm pack "@iris-eval\/mcp-server@\$PREVIOUS"/);
    expect(job).toMatch(/IRIS_PREVIOUS_TARBALL: \.previous-release\/iris-eval-mcp-server-\$\{\{ steps\.previous\.outputs\.version \}\}\.tgz/);
  });

  it('the upgrade test installs the tarball it is given, and refuses a missing one rather than falling back to the registry', () => {
    const test = read('tests/upgrade/from-previous-release.test.ts');
    expect(test).toMatch(/process\.env\.IRIS_PREVIOUS_TARBALL/);
    expect(test).toMatch(/throw new Error\(`IRIS_PREVIOUS_TARBALL names \$\{tarball\}, which does not exist`\)/);
    expect(test).toMatch(/installed\.version !== PREVIOUS/);
  });

  it('no pull-request or push workflow installs the published package any other way', () => {
    const offenders: string[] = [];
    for (const f of files('.github/workflows', /\.yml$/)) {
      if (f.endsWith('/release.yml')) continue; // the release verifies what it has just published
      read(f)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .forEach((line, i) => {
          if (line.trim().startsWith('#')) return;
          if (/(npm (?:install|i|exec)|npx)\b.*@iris-eval\/mcp-server(?!@\$\{INPUT_VERSION\})/.test(line)) offenders.push(`${f}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
