/*
 * Case-file schema, loader and validator for the judge and citation proof
 * sets. The validator is what the unit test runs against every committed
 * file, so a mislabelled or malformed case fails CI before it ever costs a
 * judge call.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasUnfilledSlots, materialise } from '../materialise.js';

export const TEMPLATE_NAMES = ['accuracy', 'helpfulness', 'safety', 'correctness', 'faithfulness'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export const GROUPS = ['clean', 'adversarial-clean', 'violation', 'injection'] as const;
export type Group = (typeof GROUPS)[number];

export type Label = 'pass' | 'fail';

export interface JudgeCaseRaw {
  id: string;
  group: Group;
  label: Label;
  /** Which rubric sentence (a key of the file's `rubric` map) the label was judged against. */
  rubricRef: string;
  input?: string;
  output: string;
  expected?: string;
  sourceMaterial?: string;
  /** Injection cases only: the id of the case whose output was reused unchanged. */
  twinOf?: string;
  /** Injection cases only: the instruction that was added, verbatim. */
  injection?: string;
  why: string;
}

export interface JudgeCaseFile {
  template: TemplateName;
  passThreshold: number;
  positiveClass: 'fail';
  rubric: Record<string, string>;
  labelling: string;
  cases: JudgeCaseRaw[];
}

/** A case with placeholders filled and twin context inherited: what the runner sends. */
export interface JudgeCase {
  id: string;
  template: TemplateName;
  group: Group;
  label: Label;
  rubricRef: string;
  input?: string;
  output: string;
  expected?: string;
  sourceMaterial?: string;
  twinOf?: string;
  injection?: string;
  why: string;
}

export interface CitationLabel {
  /** The identifier the extractor produces: cleaned URL, bare DOI, [n] number, or "Author, YYYY". */
  identifier: string;
  kind: 'url' | 'doi' | 'numbered' | 'author_year';
  /** Expected `resolveStatus` from the verifier. */
  resolve: 'ok' | 'error' | 'skipped';
  /** Expected judge verdict; null when the verifier is not expected to judge it. */
  supported: boolean | null;
  why: string;
}

export interface CitationCase {
  id: string;
  output: string;
  citations: CitationLabel[];
}

export interface CitationCaseFile {
  definitions: Record<string, string>;
  positiveClass: 'supported';
  cases: CitationCase[];
}

export const CASES_DIR = 'proof/judge/cases';
export const CITATIONS_FILE = 'proof/citations/cases.json';

export async function readJudgeCaseFile(root: string, template: TemplateName): Promise<JudgeCaseFile> {
  const raw = await readFile(resolve(root, CASES_DIR, `${template}.json`), 'utf-8');
  return JSON.parse(raw) as JudgeCaseFile;
}

export async function readCitationCaseFile(root: string): Promise<CitationCaseFile> {
  const raw = await readFile(resolve(root, CITATIONS_FILE), 'utf-8');
  return JSON.parse(raw) as CitationCaseFile;
}

/**
 * Fills placeholders and inherits twin context. An injection case is
 * materialised with its TWIN's seed so the two outputs differ by exactly
 * the injected instruction. That is what makes the drift number mean "the
 * delta the injection caused" and nothing else.
 */
export function materialiseCases(file: JudgeCaseFile): JudgeCase[] {
  const byId = new Map(file.cases.map((c) => [c.id, c]));
  return file.cases.map((c) => {
    const twin = c.twinOf ? byId.get(c.twinOf) : undefined;
    const seed = twin ? twin.id : c.id;
    const fill = (s: string | undefined): string | undefined =>
      s === undefined ? undefined : materialise(s, seed);
    return {
      id: c.id,
      template: file.template,
      group: c.group,
      label: c.label,
      rubricRef: c.rubricRef,
      input: fill(c.input ?? twin?.input),
      output: fill(c.output) as string,
      expected: fill(c.expected ?? twin?.expected),
      sourceMaterial: fill(c.sourceMaterial ?? twin?.sourceMaterial),
      twinOf: c.twinOf,
      injection: fill(c.injection),
      why: c.why,
    };
  });
}

/** Every problem with a case file, as human sentences. Empty = valid. */
export function validateJudgeCaseFile(file: JudgeCaseFile, expectedTemplate: TemplateName): string[] {
  const issues: string[] = [];
  const where = `${expectedTemplate}.json`;
  if (file.template !== expectedTemplate) {
    issues.push(`${where}: template is "${file.template}", expected "${expectedTemplate}"`);
  }
  if (file.positiveClass !== 'fail') issues.push(`${where}: positiveClass must be "fail"`);
  if (typeof file.passThreshold !== 'number') issues.push(`${where}: passThreshold missing`);
  if (!file.rubric || typeof file.rubric !== 'object') issues.push(`${where}: rubric map missing`);
  if (!file.labelling) issues.push(`${where}: labelling statement missing`);
  if (!Array.isArray(file.cases)) {
    issues.push(`${where}: cases is not an array`);
    return issues;
  }

  const ids = new Set<string>();
  const byId = new Map(file.cases.map((c) => [c.id, c]));
  for (const c of file.cases) {
    const at = `${where} → ${c.id ?? '(no id)'}`;
    if (!c.id) issues.push(`${at}: missing id`);
    else if (ids.has(c.id)) issues.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (!c.id?.startsWith(`${expectedTemplate}-`)) issues.push(`${at}: id must start with "${expectedTemplate}-"`);
    if (!GROUPS.includes(c.group)) issues.push(`${at}: unknown group "${c.group}"`);
    if (c.label !== 'pass' && c.label !== 'fail') issues.push(`${at}: label must be pass|fail`);
    if (!c.rubricRef || !(c.rubricRef in (file.rubric ?? {}))) {
      issues.push(`${at}: rubricRef "${c.rubricRef}" is not a key of the file's rubric map`);
    }
    if (!c.output || typeof c.output !== 'string') issues.push(`${at}: output missing`);
    if (!c.why) issues.push(`${at}: why missing`);

    // Group ↔ label consistency: the label is the group's meaning.
    if ((c.group === 'clean' || c.group === 'adversarial-clean') && c.label !== 'pass') {
      issues.push(`${at}: group ${c.group} must be labelled pass`);
    }
    if ((c.group === 'violation' || c.group === 'injection') && c.label !== 'fail') {
      issues.push(`${at}: group ${c.group} must be labelled fail`);
    }

    // Template-specific required context.
    const twin = c.twinOf ? byId.get(c.twinOf) : undefined;
    if (expectedTemplate === 'correctness' && !(c.expected ?? twin?.expected)) {
      issues.push(`${at}: correctness cases need "expected"`);
    }
    if (expectedTemplate === 'faithfulness' && !(c.sourceMaterial ?? twin?.sourceMaterial)) {
      issues.push(`${at}: faithfulness cases need "sourceMaterial"`);
    }

    // Injection cases: a twin that exists, is a violation, and whose output
    // is reused verbatim (so drift measures the injection alone).
    if (c.group === 'injection') {
      if (!c.twinOf) issues.push(`${at}: injection case needs twinOf`);
      else if (!twin) issues.push(`${at}: twinOf "${c.twinOf}" does not exist`);
      else {
        if (twin.group !== 'violation') issues.push(`${at}: twin must be a violation case (see labelling note)`);
        if (!c.output.includes(twin.output)) issues.push(`${at}: output must contain the twin's output verbatim`);
      }
      if (!c.injection) issues.push(`${at}: injection case needs the injected instruction in "injection"`);
      else if (!c.output.includes(c.injection)) issues.push(`${at}: output must contain the injected instruction verbatim`);
    } else if (c.twinOf || c.injection) {
      issues.push(`${at}: only injection cases may carry twinOf / injection`);
    }
  }

  // Materialised text must have no unfilled slots.
  if (issues.length === 0) {
    for (const m of materialiseCases(file)) {
      for (const [field, value] of Object.entries({
        input: m.input, output: m.output, expected: m.expected, sourceMaterial: m.sourceMaterial,
      })) {
        if (value && hasUnfilledSlots(value)) issues.push(`${where} → ${m.id}: unfilled slot in ${field}`);
      }
    }
  }

  // Size and balance.
  const n = file.cases.length;
  const passes = file.cases.filter((c) => c.label === 'pass').length;
  if (n < 30 || n > 40) issues.push(`${where}: ${n} cases; the set must hold 30–40`);
  if (n > 0 && (passes / n < 0.4 || passes / n > 0.6)) {
    issues.push(`${where}: ${passes}/${n} labelled pass; the set must be balanced (40–60% pass)`);
  }
  for (const g of GROUPS) {
    if (!file.cases.some((c) => c.group === g)) issues.push(`${where}: no ${g} cases`);
  }
  return issues;
}

export function validateCitationCaseFile(file: CitationCaseFile): string[] {
  const issues: string[] = [];
  if (file.positiveClass !== 'supported') issues.push('cases.json: positiveClass must be "supported"');
  if (!file.definitions) issues.push('cases.json: definitions missing');
  if (!Array.isArray(file.cases)) return [...issues, 'cases.json: cases is not an array'];
  const ids = new Set<string>();
  for (const c of file.cases) {
    const at = `cases.json → ${c.id ?? '(no id)'}`;
    if (!c.id) issues.push(`${at}: missing id`);
    else if (ids.has(c.id)) issues.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (!c.output) issues.push(`${at}: output missing`);
    if (!Array.isArray(c.citations) || c.citations.length === 0) {
      issues.push(`${at}: needs at least one labelled citation`);
      continue;
    }
    for (const l of c.citations) {
      const lat = `${at} → ${l.identifier}`;
      if (!['ok', 'error', 'skipped'].includes(l.resolve)) issues.push(`${lat}: resolve must be ok|error|skipped`);
      if (l.resolve === 'ok' && typeof l.supported !== 'boolean') issues.push(`${lat}: a resolving citation needs a boolean supported label`);
      if (l.resolve !== 'ok' && l.supported !== null) issues.push(`${lat}: a non-resolving citation must have supported: null`);
      if (!l.why) issues.push(`${lat}: why missing`);
      if (l.kind === 'url' && !c.output.includes(l.identifier)) issues.push(`${lat}: identifier not found in output`);
    }
  }
  return issues;
}
