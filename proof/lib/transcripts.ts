/*
 * The 24 real transcripts, measured rather than typed (arc 4, A4-13).
 *
 * These are the only out-of-sample evidence Iris has: agent runs against
 * this repository, captured before any of the rules that judge them existed,
 * with an answer key a person wrote at capture time. Every other number in
 * `proof/` is measured on a corpus authored alongside the rule it measures.
 *
 * WHY THIS FILE EXISTS. Until now the transcript number came from a
 * hand-written `KNOWN_GAPS` table in `tests/real-transcripts.test.ts`,
 * naming the bundle verdicts that were allowed to disagree with the answer
 * key. A table like that can only rot in one direction: a gap that CLOSES
 * stays recorded as open, because nothing re-derives it and closing it is
 * invisible. That is the same defect as a doctrine with no loader.
 *
 * So this runner measures the gaps, writes them down, and the test reads
 * what it wrote. A gap that closes now fails the check that says it is open.
 *
 * THREE numbers, and they are not the same number. The BUNDLE verdicts are
 * the legacy per-bundle arithmetic and the weakest of the three — a bundle
 * is a weighted mean, so one failing non-critical rule in a bundle of six
 * does not move it. The SHIP verdict is what a gate keys on. The CLASSES
 * caught is the arc-4 headline: of the failure classes a person said were
 * present, how many did some rule actually detect. The class number needs no
 * relabelling to stay meaningful as rules are added, which is why it is the
 * one the record leads with.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig } from '../../src/config/defaults.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { rulesByType } from '../../src/eval/rules/index.js';
import type { EvalType, FailureClass } from '../../src/types/eval.js';
import { REAL_TRANSCRIPTS_DIR } from './composite.js';

export const TRANSCRIPT_RESULTS_JSON = 'proof/transcript-results.json';
export const TRANSCRIPTS_MD = 'proof/TRANSCRIPTS.md';

export const BUNDLES: EvalType[] = ['safety', 'completeness', 'relevance', 'cost'];

export interface BundleRow {
  /** What the answer key says, written when the transcript was captured. */
  expected: 'pass' | 'fail';
  /** What the engine says now; null when the bundle had nothing to judge. */
  actual: boolean | null;
  agrees: boolean;
}

export interface TranscriptRow {
  id: string;
  file: string;
  intendedFailure: string | null;
  bundles: Record<string, BundleRow>;
  /** Bundles whose verdict disagrees with the answer key — the measured gap set. */
  gaps: string[];
  ship: { passed: boolean; expected: boolean; agrees: boolean };
  classes: { expected: FailureClass[]; caught: FailureClass[]; missed: FailureClass[] };
  /** Rules that failed, in registry order. */
  fired: string[];
  /** Rules that declined to judge, with the reason. */
  skipped: Array<{ rule: string; reason: string }>;
}

export interface TranscriptResults {
  schemaVersion: 1;
  transcriptsVersion: string;
  generatedAt: string;
  commit: string;
  version: string;
  method: string;
  totals: {
    transcripts: number;
    /** Transcripts whose four bundle verdicts ALL agree with the answer key. */
    allBundlesAgree: number;
    /** Bundle verdicts agreeing, out of four per transcript. */
    bundleVerdictsAgree: number;
    bundleVerdicts: number;
    shipAgrees: number;
    classesPresent: number;
    classesCaught: number;
  };
  rows: TranscriptRow[];
}

/** Which failure classes each built-in rule claims. */
function classesByRule(): Map<string, readonly FailureClass[]> {
  const out = new Map<string, readonly FailureClass[]>();
  for (const rules of Object.values(rulesByType)) {
    for (const rule of rules) out.set(rule.name, rule.classes ?? []);
  }
  return out;
}

interface RawTranscript {
  id: string;
  file: string;
  input?: string;
  output?: string;
  tool_calls?: unknown;
  cost_usd?: number;
  token_usage?: unknown;
  metadata?: {
    intended_failure?: string;
    expected_verdict?: Record<string, 'pass' | 'fail'>;
    classes?: FailureClass[];
  };
}

/**
 * The transcripts WITH their answer keys.
 *
 * `loadRealTranscripts` strips `metadata` on purpose, because the composite
 * corpus must not see the answer key it is scored against. This runner IS
 * the comparison against that key, so it reads the whole file.
 */
export async function loadTranscriptsWithKeys(root: string): Promise<RawTranscript[]> {
  const dir = resolve(root, REAL_TRANSCRIPTS_DIR);
  const names = (await readdir(dir)).filter((n) => /^t-\d\d-.*\.json$/.test(n)).sort();
  const out: RawTranscript[] = [];
  for (const file of names) {
    const raw = JSON.parse((await readFile(resolve(dir, file), 'utf-8')).replace(/\r\n/g, '\n')) as Omit<RawTranscript, 'id' | 'file'>;
    out.push({ ...raw, id: file.slice(0, 4), file });
  }
  return out;
}

/**
 * The classes a person said were present in each transcript.
 *
 * Read from the COMPOSITE corpus rather than restated here: the corpus
 * already carries one `rt-NN` case per transcript with its
 * `expected.classes`, and a second copy of that map would be a second thing
 * to keep in step. One source, and the composite validator already enforces
 * that every transcript is promoted exactly once.
 */
export async function transcriptClasses(root: string): Promise<Map<string, FailureClass[]>> {
  const file = JSON.parse(await readFile(resolve(root, 'proof/composite/cases.json'), 'utf-8')) as {
    cases: Array<{ id: string; provenance: string; base: string; expected: { classes: FailureClass[] } }>;
  };
  const out = new Map<string, FailureClass[]>();
  for (const c of file.cases) {
    if (c.provenance !== 'real-transcript') continue;
    out.set(c.base, c.expected.classes ?? []);
  }
  return out;
}

export async function measureTranscripts(root: string): Promise<Omit<TranscriptResults, 'generatedAt' | 'commit' | 'version'>> {
  const transcripts = await loadTranscriptsWithKeys(root);
  const classes = await transcriptClasses(root);
  const ruleClasses = classesByRule();
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds);

  const rows: TranscriptRow[] = [];
  const hash = createHash('sha256');
  for (const t of transcripts) {
    hash.update(`${t.id}\n${JSON.stringify({ i: t.input, o: t.output, c: t.tool_calls, u: t.cost_usd, k: t.token_usage, m: t.metadata })}\n`);

    const result = await engine.evaluateAll({
      output: t.output ?? '',
      input: t.input,
      toolCalls: t.tool_calls as never,
      costUsd: t.cost_usd,
      tokenUsage: t.token_usage as never,
    });

    const bundles: Record<string, BundleRow> = {};
    const gaps: string[] = [];
    for (const bundle of BUNDLES) {
      const expected = t.metadata?.expected_verdict?.[bundle] ?? 'pass';
      const actual = result.categories?.[bundle]?.passed ?? null;
      const agrees = actual !== null && actual === (expected === 'pass');
      bundles[bundle] = { expected, actual, agrees };
      if (!agrees) gaps.push(bundle);
    }

    const fired = result.rule_results.filter((r) => r.skipped !== true && r.passed === false).map((r) => r.ruleName);
    const caughtSet = new Set<FailureClass>();
    for (const name of fired) for (const c of ruleClasses.get(name) ?? []) caughtSet.add(c);
    const expectedClasses = classes.get(t.id) ?? [];
    const caught = expectedClasses.filter((c) => caughtSet.has(c));

    rows.push({
      id: t.id,
      file: t.file,
      intendedFailure: t.metadata?.intended_failure ?? null,
      bundles,
      gaps,
      ship: {
        passed: result.passed,
        // A transcript with any expected class is one that must not ship.
        expected: expectedClasses.length === 0,
        agrees: result.passed === (expectedClasses.length === 0),
      },
      classes: { expected: expectedClasses, caught, missed: expectedClasses.filter((c) => !caughtSet.has(c)) },
      fired,
      skipped: result.rule_results
        .filter((r) => r.skipped === true)
        .map((r) => ({ rule: r.ruleName, reason: r.skipReason ?? 'not stated' })),
    });
  }

  const bundleVerdicts = rows.length * BUNDLES.length;
  return {
    schemaVersion: 1,
    transcriptsVersion: hash.digest('hex').slice(0, 12),
    method:
      'each transcript runs through the real engine exactly as evaluate_output does, at the shipped defaults. BUNDLE verdicts are compared to the answer key written when the transcript was captured; the SHIP verdict is compared to "no failure class is present"; CLASSES CAUGHT counts the classes a person said were present that some rule declaring that class actually failed on. The three are different questions and the class number is the one that stays meaningful as rules are added, because it needs no relabelling. Gaps are MEASURED here and read by tests/real-transcripts.test.ts, so a gap that closes cannot stay recorded as open',
    totals: {
      transcripts: rows.length,
      allBundlesAgree: rows.filter((r) => r.gaps.length === 0).length,
      bundleVerdictsAgree: rows.reduce((n, r) => n + (BUNDLES.length - r.gaps.length), 0),
      bundleVerdicts,
      shipAgrees: rows.filter((r) => r.ship.agrees).length,
      classesPresent: rows.reduce((n, r) => n + r.classes.expected.length, 0),
      classesCaught: rows.reduce((n, r) => n + r.classes.caught.length, 0),
    },
    rows,
  };
}

export function renderTranscriptMarkdown(results: TranscriptResults): string {
  const L: string[] = [];
  const t = results.totals;
  L.push('# Iris on 24 real agent transcripts');
  L.push('');
  L.push(`Generated by \`npm run proof -- --transcripts\` at ${results.generatedAt} from ${results.commit} (v${results.version}), transcripts ${results.transcriptsVersion}.`);
  L.push('');
  L.push(`${results.method}.`);
  L.push('');
  L.push('| Question | Result |');
  L.push('|---|---|');
  L.push(`| Failure classes present that some rule caught | **${t.classesCaught} of ${t.classesPresent}** |`);
  L.push(`| Ship/no-ship verdicts agreeing | **${t.shipAgrees} of ${t.transcripts}** |`);
  L.push(`| Transcripts whose four bundle verdicts all agree | **${t.allBundlesAgree} of ${t.transcripts}** |`);
  L.push(`| Bundle verdicts agreeing | **${t.bundleVerdictsAgree} of ${t.bundleVerdicts}** |`);
  L.push('');
  L.push('## Per transcript');
  L.push('');
  L.push('| # | Intended failure | Classes caught | Ship | Bundle gaps | Rules that fired |');
  L.push('|---|---|---|---|---|---|');
  for (const r of results.rows) {
    const cls = r.classes.expected.length === 0 ? '— (clean)' : `${r.classes.caught.length}/${r.classes.expected.length} · ${r.classes.expected.map((c) => (r.classes.caught.includes(c) ? `**${c}**` : `~~${c}~~`)).join(', ')}`;
    L.push(
      `| ${r.id} | ${r.intendedFailure ?? '—'} | ${cls} | ${r.ship.agrees ? 'ok' : `**${r.ship.passed ? 'shipped a bad answer' : 'blocked a good one'}**`} | ${r.gaps.length === 0 ? 'none' : r.gaps.join(', ')} | ${r.fired.length === 0 ? '—' : r.fired.map((f) => `\`${f}\``).join(', ')} |`,
    );
  }
  L.push('');
  L.push('## Bundle gaps, measured');
  L.push('');
  L.push(
    'A gap is a bundle whose verdict disagrees with the answer key. They are listed here because they are MEASURED, not because they are acceptable: `tests/real-transcripts.test.ts` reads this file, so a gap that closes cannot stay recorded as open, and a new one cannot appear unnoticed.',
  );
  L.push('');
  for (const r of results.rows) {
    if (r.gaps.length === 0) continue;
    for (const b of r.gaps) {
      const row = r.bundles[b];
      L.push(`- \`${r.id}\` · ${b}: the key says ${row.expected}, the engine says ${row.actual === null ? 'not judged' : row.actual ? 'pass' : 'fail'}`);
    }
  }
  L.push('');
  return `${L.join('\n')}\n`;
}
