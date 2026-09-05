/*
 * Schema, loader and validator for proof/corpus/*.json — the labelled
 * families behind every built-in rule's precision/recall/F1.
 *
 * One file per rule. The header states which rule the file measures, the
 * rule's DOCUMENTED definition the labels were judged against, and how the
 * cases were made and labelled. `cases[]` hold the text and the label.
 *
 * The validator is what the unit test runs against every committed file, so
 * a malformed, mislabelled or unbalanced family fails CI before the runner
 * ever turns it into a number.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { EvalType } from '../../src/types/eval.js';
import { hasUnfilledSlots, materialiseCase, type CorpusCaseRaw } from './materialise.js';

export const CORPUS_DIR = 'proof/corpus';

export type Label = 'positive' | 'negative';

export interface CorpusFile {
  schemaVersion: 1;
  /** The registry name of the rule this family measures (`no_pii`). */
  rule: string;
  /** The rule's bundle; must equal the registry rule's evalType. */
  category: EvalType;
  /** Short family name used in ids and reports (`pii`). */
  family: string;
  /** The positive class is always the violation: the rule SHOULD fail the output. */
  positiveClass: 'fail';
  /** The documented definition the labels were judged against. */
  definition: string;
  /** Where the cases came from and how they were made. */
  source: string;
  /** How the labels were assigned and by whom. */
  labelling: string;
  /** Optional: the date the family was authored/labelled (stage-3 families). */
  authored?: string;
  /** Optional: the config the runner must pass so the documented definition holds. */
  config?: Record<string, unknown>;
  counts?: { n: number; positive: number; negative: number };
  cases: CorpusCaseRaw[];
}

export interface LoadedCorpus {
  files: CorpusFile[];
  /** 12-hex sha256 over every corpus file (LF-normalised, sorted by name). */
  corpusVersion: string;
}

/** Reads every family file in name order and hashes them together. */
export async function loadCorpus(root: string): Promise<LoadedCorpus> {
  const dir = resolve(root, CORPUS_DIR);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const hash = createHash('sha256');
  const files: CorpusFile[] = [];
  for (const name of names) {
    const raw = (await readFile(resolve(dir, name), 'utf-8')).replace(/\r\n/g, '\n');
    hash.update(`${name}\n${raw}\n`);
    files.push(JSON.parse(raw) as CorpusFile);
  }
  return { files, corpusVersion: hash.digest('hex').slice(0, 12) };
}

const LABELS: readonly Label[] = ['positive', 'negative'];
const CATEGORIES: readonly EvalType[] = ['completeness', 'relevance', 'safety', 'cost', 'custom'];
const CONTEXT_KEYS = new Set(['costUsd', 'tokenUsage', 'customConfig', 'toolCalls', 'metadata']);

/**
 * What a positive case CONTAINS, named by the case author (never by the
 * detector): the per-entity recall table reads these. The vocabulary is the
 * rule's documented definition plus the things the corpus holds that the
 * definition does not name (an address, a password, a URL-borne token), so a
 * gap in the definition shows as a row, not as silence.
 */
export const PII_ENTITIES = ['ssn', 'credit_card', 'iban', 'phone', 'email', 'dob', 'private_key', 'seed_phrase', 'api_key', 'password', 'address', 'url_token'] as const;
export type PiiEntity = (typeof PII_ENTITIES)[number];

/**
 * Every problem with a family file, as human sentences. Empty = valid.
 * `registry` maps rule name → evalType for the rules that exist in
 * src/eval/rules; a family for a rule that is not registered is a bug.
 */
export function validateCorpusFile(file: CorpusFile, fileName: string, registry: Map<string, EvalType>): string[] {
  const issues: string[] = [];
  const where = fileName;
  if (file.schemaVersion !== 1) issues.push(`${where}: schemaVersion must be 1`);
  if (!file.rule) issues.push(`${where}: rule missing`);
  else if (!registry.has(file.rule)) issues.push(`${where}: rule "${file.rule}" is not in the rule registry`);
  else if (registry.get(file.rule) !== file.category) {
    issues.push(`${where}: category "${file.category}" does not match the registry (${registry.get(file.rule)})`);
  }
  if (!CATEGORIES.includes(file.category)) issues.push(`${where}: unknown category "${file.category}"`);
  if (!file.family) issues.push(`${where}: family missing`);
  if (file.positiveClass !== 'fail') issues.push(`${where}: positiveClass must be "fail"`);
  if (!file.definition) issues.push(`${where}: definition missing (state the documented definition the labels were judged against)`);
  if (!file.source) issues.push(`${where}: source missing`);
  if (!file.labelling) issues.push(`${where}: labelling statement missing`);
  if (!Array.isArray(file.cases)) {
    issues.push(`${where}: cases is not an array`);
    return issues;
  }

  const ids = new Set<string>();
  for (const c of file.cases) {
    const at = `${where} → ${c.id ?? '(no id)'}`;
    if (!c.id) issues.push(`${at}: missing id`);
    else if (ids.has(c.id)) issues.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (c.rule !== file.rule) issues.push(`${at}: rule "${c.rule}" differs from the file's rule "${file.rule}"`);
    if (!LABELS.includes(c.label)) issues.push(`${at}: label must be positive|negative`);
    if (typeof c.output !== 'string') issues.push(`${at}: output must be a string`);
    if (c.input !== undefined && typeof c.input !== 'string') issues.push(`${at}: input must be a string`);
    if (c.expected !== undefined && typeof c.expected !== 'string') issues.push(`${at}: expected must be a string`);
    if (typeof c.notes !== 'string' || c.notes.length === 0) issues.push(`${at}: notes missing (say why the label is what it is)`);
    if (c.context !== undefined) {
      if (c.context === null || typeof c.context !== 'object' || Array.isArray(c.context)) {
        issues.push(`${at}: context must be an object of EvalContext fields`);
      } else {
        for (const k of Object.keys(c.context)) {
          if (!CONTEXT_KEYS.has(k)) issues.push(`${at}: context.${k} is not an EvalContext field (${[...CONTEXT_KEYS].join(', ')})`);
        }
      }
    }
    if (c.entities !== undefined) {
      if (c.label !== 'positive') issues.push(`${at}: entities belong on positive cases only`);
      if (!Array.isArray(c.entities) || c.entities.length === 0 || !c.entities.every((e) => typeof e === 'string')) issues.push(`${at}: entities must be a non-empty string array`);
      else for (const e of c.entities) if (!(PII_ENTITIES as readonly string[]).includes(e)) issues.push(`${at}: unknown entity "${e}"`);
    }
    if (c.slots !== undefined) {
      for (const [name, s] of Object.entries(c.slots)) {
        if (!s || typeof s.kind !== 'string') issues.push(`${at}: slot ${name} has no kind`);
        else if (s.kind === 'pem_private_key' ? !Array.isArray(s.lines) : typeof s.mask !== 'string') {
          issues.push(`${at}: slot ${name} has no shape`);
        }
      }
    }
    if (typeof c.output === 'string') {
      const m = materialiseCase(c);
      for (const [field, value] of Object.entries({ input: m.input, output: m.output, expected: m.expected })) {
        if (value && hasUnfilledSlots(value)) issues.push(`${at}: unfilled slot in ${field}`);
      }
    }
  }

  // Size and balance: enough cases for an interval that means something,
  // and neither class so rare that precision or recall rests on a handful.
  const n = file.cases.length;
  const positives = file.cases.filter((c) => c.label === 'positive').length;
  if (n < 24) issues.push(`${where}: ${n} cases; a family needs at least 24`);
  if (n > 0 && (positives / n < 0.3 || positives / n > 0.7)) {
    issues.push(`${where}: ${positives}/${n} labelled positive; a family must be balanced (30–70% positive)`);
  }
  if (file.counts) {
    if (file.counts.n !== n || file.counts.positive !== positives || file.counts.negative !== n - positives) {
      issues.push(`${where}: counts header (${file.counts.n}/${file.counts.positive}/${file.counts.negative}) does not match the cases (${n}/${positives}/${n - positives})`);
    }
  }
  return issues;
}
