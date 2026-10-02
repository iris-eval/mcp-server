/*
 * The two documents that describe the proof corpus say what the corpus is.
 *
 * docs/proof.md and proof/README.md drifted from the files they describe:
 * a blind sample called "40-case" after it grew to twenty per family; "the
 * other eight rules are arithmetic" when most of the rules were outside the
 * sample and several of those are judgements; nine families said to hold
 * real-transcript cases after every such case was removed; a `lib/risk.ts`
 * that does not exist, described as "run in the harness only" while the
 * server composes every verdict with that estimate; and a risk composer "a
 * future release may adopt", ten releases after it shipped.
 *
 * Each statement is checked against the corpus headers, the sample manifest
 * and the tree.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const readme = read('proof/README.md');
const doc = read('docs/proof.md');
/** The README quotes the source corpus's provenance verbatim, sample size included; a quote is not a statement about today's sample. */
const unquoted = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.startsWith('>'))
    .join('\n');

const families = readdirSync(join(root, 'proof', 'corpus'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(read(`proof/corpus/${f}`)) as { rule: string; labelBasis: 'reading' | 'definition'; cases: Array<{ notes?: string }> });
const sample = JSON.parse(read('proof/blind-sample.json')) as { target: number; families: string[]; ids: string[] };

describe('the blind sample, as described', () => {
  it('is twenty cases from each family it covers, and neither document calls it a 40-case sample', () => {
    expect(sample.ids.length).toBe(sample.target);
    expect(sample.target).toBe(sample.families.length * 20);
    for (const text of [unquoted(readme), doc]) expect(text).not.toMatch(/(?<!\d)40-case/);
    expect(unquoted(readme)).toMatch(/twenty\s+cases from each family it covers/);
    expect(doc).toMatch(/twenty cases from each of the seven families/);
    expect(sample.families.length).toBe(7);
  });

  it('the README names every judgement family the sample leaves out, and no other', () => {
    const unsampled = families
      .filter((f) => f.labelBasis === 'reading' && !sample.families.includes(f.rule))
      .map((f) => f.rule)
      .sort();
    expect(unsampled.length).toBeGreaterThan(0);
    const paragraph = readme.slice(readme.indexOf('The rest are judgement families the sample does not cover yet'));
    const named = [...paragraph.slice(0, paragraph.indexOf('.')).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    expect(named).toEqual(unsampled);
    expect(readme).not.toMatch(/The other eight\s+rules are arithmetic/);
  });

  it('every family the sample covers exists, and the README lists them', () => {
    const rules = new Set(families.map((f) => f.rule));
    for (const f of sample.families) {
      expect(rules.has(f), f).toBe(true);
      expect(readme).toContain(`\`${f}\``);
    }
  });
});

describe('real transcripts, as described', () => {
  it('no family case points at a transcript, and the proof page says they are held out', () => {
    for (const f of families) expect(f.cases.filter((c) => /real transcript t-\d/.test(c.notes ?? '')).map(() => f.rule)).toEqual([]);
    expect(doc).not.toMatch(/holds at least six cases/);
    expect(doc).toMatch(/No family case comes from a real transcript/);
    expect(existsSync(join(root, 'proof', 'TRANSCRIPTS.md'))).toBe(true);
    expect(existsSync(join(root, 'tests', 'proof', 'transcripts-held-out.test.ts'))).toBe(true);
  });
});

describe('the composer, as described', () => {
  it('every file the README table names exists', () => {
    const rows = [...readme.matchAll(/^\| `((?:lib|tools)\/[^`<]+\.(?:ts|mjs))` \|/gm)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(5);
    for (const rel of rows) expect(existsSync(join(root, 'proof', rel)), `proof/${rel}`).toBe(true);
  });

  it('nothing says the risk composer is harness-only or still to come', () => {
    for (const text of [readme, doc, read('src/eval/risk.ts')]) {
      expect(text).not.toMatch(/a future release may adopt/);
      expect(text).not.toMatch(/in the harness only/);
      expect(text).not.toMatch(/Nothing in the package calls it/);
    }
    // The server's composer does call it.
    expect(read('src/eval/compose.ts')).toMatch(/import \{[^}]*\briskEstimate\b[^}]*\} from '\.\/risk\.js'/);
  });
});
