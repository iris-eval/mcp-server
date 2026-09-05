/*
 * Conformance families for the eight custom rule types (arc 2, M9).
 *
 * A custom rule is the author's own constraint: its "accuracy" is whether
 * the type does what its documented definition says under the config the
 * family declares — a conformance measurement, not a detection one. Each
 * family under proof/corpus/custom/<type>.json states the config and the
 * definition, and its cases are labelled by that definition (positive = the
 * rule should FAIL the output). The runner builds the rule with the real
 * factory (`createCustomRule`, the object `custom_rules` and deployed rules
 * run through) and evaluates every case with the context it declares.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CustomRuleType } from '../../src/types/eval.js';
import { createCustomRule } from '../../src/eval/rules/custom.js';
import { type Label } from './corpus.js';
import { materialiseCase, type CorpusCaseRaw } from './materialise.js';
import { contextFor } from './context.js';
import { summarise, type Observation, type RuleSummary } from './metrics.js';

export const CUSTOM_CORPUS_DIR = 'proof/corpus/custom';

export const CUSTOM_RULE_TYPES: readonly CustomRuleType[] = ['regex_match', 'regex_no_match', 'min_length', 'max_length', 'contains_keywords', 'excludes_keywords', 'json_schema', 'cost_threshold'];

export interface CustomCorpusFile {
  schemaVersion: 1;
  /** The custom rule type this family measures. */
  type: CustomRuleType;
  family: string;
  positiveClass: 'fail';
  /** What the type does, as documented, under `config`. Labels are judged against this. */
  definition: string;
  source: string;
  labelling: string;
  authored: string;
  /** The rule config the family is measured under. */
  config: Record<string, unknown>;
  counts?: { n: number; positive: number; negative: number };
  cases: CorpusCaseRaw[];
}

export interface LoadedCustomCorpus {
  files: CustomCorpusFile[];
  /** 12-hex sha256 over every custom family file (LF-normalised, sorted by name). */
  customCorpusVersion: string;
}

export async function loadCustomCorpus(root: string): Promise<LoadedCustomCorpus> {
  const dir = resolve(root, CUSTOM_CORPUS_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return { files: [], customCorpusVersion: '000000000000' };
  }
  const hash = createHash('sha256');
  const files: CustomCorpusFile[] = [];
  for (const name of names) {
    const raw = (await readFile(resolve(dir, name), 'utf-8')).replace(/\r\n/g, '\n');
    hash.update(`${name}\n${raw}\n`);
    files.push(JSON.parse(raw) as CustomCorpusFile);
  }
  return { files, customCorpusVersion: hash.digest('hex').slice(0, 12) };
}

const LABELS: readonly Label[] = ['positive', 'negative'];

/** Every problem with a custom family file, as human sentences. Empty = valid. */
export function validateCustomCorpusFile(file: CustomCorpusFile, fileName: string): string[] {
  const issues: string[] = [];
  const where = (s: string): string => `${fileName}: ${s}`;
  if (file.schemaVersion !== 1) issues.push(where(`schemaVersion must be 1, got ${String(file.schemaVersion)}`));
  if (!CUSTOM_RULE_TYPES.includes(file.type)) issues.push(where(`type "${String(file.type)}" is not a custom rule type`));
  if (file.positiveClass !== 'fail') issues.push(where('positiveClass must be "fail"'));
  for (const k of ['definition', 'source', 'labelling', 'authored'] as const) {
    if (typeof file[k] !== 'string' || file[k].length === 0) issues.push(where(`${k} must be a non-empty string`));
  }
  if (!file.config || typeof file.config !== 'object') issues.push(where('config must be an object'));
  if (!Array.isArray(file.cases) || file.cases.length < 24) issues.push(where(`a family needs at least 24 cases, got ${Array.isArray(file.cases) ? file.cases.length : 0}`));
  const seen = new Set<string>();
  let positive = 0;
  for (const c of file.cases ?? []) {
    if (typeof c.id !== 'string' || !c.id.startsWith(`custom-${file.type}-`)) issues.push(where(`case id "${String(c.id)}" must start with custom-${file.type}-`));
    if (seen.has(c.id)) issues.push(where(`duplicate case id ${c.id}`));
    seen.add(c.id);
    if (!LABELS.includes(c.label)) issues.push(where(`${c.id}: label must be positive or negative`));
    if (c.label === 'positive') positive += 1;
    if (typeof c.output !== 'string') issues.push(where(`${c.id}: output must be a string`));
    if (typeof c.notes !== 'string' || c.notes.length === 0) issues.push(where(`${c.id}: notes must say why the label holds`));
  }
  const n = file.cases?.length ?? 0;
  if (n > 0 && (positive / n < 0.3 || positive / n > 0.7)) issues.push(where(`positives must be 30–70% of the family, got ${positive}/${n}`));
  if (file.counts && (file.counts.n !== n || file.counts.positive !== positive || file.counts.negative !== n - positive)) issues.push(where('counts do not match the cases'));
  return issues;
}

export interface CustomRow extends RuleSummary {
  type: CustomRuleType;
  family: string;
  config: Record<string, unknown>;
  falsePositives: string[];
  falseNegatives: string[];
}

/** Runs each family through a rule built by the real factory under the family's config. */
export function measureCustom(files: CustomCorpusFile[]): CustomRow[] {
  return files.map((file) => {
    const rule = createCustomRule({ name: `proof_${file.type}`, type: file.type, config: file.config });
    const obs: Observation[] = file.cases.map((raw) => {
      const c = materialiseCase(raw);
      const result = rule.evaluate(contextFor(c));
      const skipped = result.skipped === true;
      return { id: c.id, actual: c.label === 'positive', predicted: !skipped && result.passed === false, skipped };
    });
    return {
      type: file.type,
      family: file.family,
      config: file.config,
      ...summarise(obs, `custom:${file.type}`),
      falsePositives: obs.filter((o) => !o.actual && o.predicted).map((o) => o.id),
      falseNegatives: obs.filter((o) => o.actual && !o.predicted).map((o) => o.id),
    };
  });
}
