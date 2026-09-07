import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * One implementation of each statistic, in the product, imported by the proof.
 *
 * The measurement on /proof and the number a shipped tool returns must come
 * from the same function. Two implementations is how they start disagreeing —
 * and they disagree SILENTLY, because both look correct and differ only in
 * something small. Newcombe's interval was defined twice until 0.12.0: once
 * in `src/eval/stats.ts` and once in `proof/lib/intervals.ts`, identical
 * except that one rounded to four places.
 *
 * The dependency runs one way. `src/` ships in the npm package and `proof/`
 * does not, so a statistic the product needs lives in `src/` and the harness
 * imports it — never the reverse, which would put the harness in the artifact.
 */

const root = resolve(__dirname, '..', '..');

const STATISTICS = ['wilson', 'newcombeDifference', 'mcnemarExact', 'clusterBootstrap', 'smallestDetectableDifference'];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...tsFilesUnder(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('the statistics have one home', () => {
  const proofFiles = tsFilesUnder(join(root, 'proof'));

  it.each(STATISTICS)('%s is defined in src/eval/stats.ts and nowhere under proof/', (name) => {
    const stats = readFileSync(join(root, 'src', 'eval', 'stats.ts'), 'utf8');
    expect(stats, `${name} is not defined in src/eval/stats.ts`).toContain(`export function ${name}(`);

    const redefined = proofFiles.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return new RegExp(`export (?:function|const) ${name}\\b`).test(src);
    });
    expect(redefined.map((f) => f.slice(root.length + 1)), `${name} is defined a second time under proof/`).toEqual([]);
  });

  it('proof reads the product, and the product never reads proof', () => {
    // `proof/` is not in the package's `files`, so a src/ module importing it
    // would resolve at development time and be missing from every install.
    const srcFiles = tsFilesUnder(join(root, 'src'));
    const offenders = srcFiles.filter((f) => /from '[^']*\/proof\//.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });
});
