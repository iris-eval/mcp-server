/*
 * The composite corpus — the labelled corpus for the VERDICT a gate keys on.
 *
 * Every published number so far is per rule: a family of cases and the
 * rule's own evaluate. The top-level `passed` — the composition of rules
 * into one verdict — had no corpus at all (arc zero, evaluator-of-evaluators
 * question 1 for the composer). This is that corpus.
 *
 * A composite case is a whole evaluation input (output, input, tool calls,
 * cost, tokens) with what is TRUE BY CONSTRUCTION about it — which failure
 * classes are present — and what a person says about shipping it. The
 * expected verdict is never derived from the composer under test: a
 * composed case names the family cases injected into a clean base, so the
 * classes present are a fact of how it was built, and `shouldShip` follows
 * a stated rule (any tier-A class present → false) that a human label may
 * override.
 *
 * Two provenances:
 *   - `real-transcript`: one of the 24 transcripts an agent produced doing
 *     real tasks against this repository (tests/fixtures/real-transcripts),
 *     with the author's intended failure as the class label. These are the
 *     out-of-sample line: nothing in the rules was tuned on them as a set.
 *   - `composed`: a clean base (a control transcript, or a family case) with
 *     zero or more family positives injected into a named field; the
 *     lookalike negatives inject family NEGATIVES (a placeholder SSN, a
 *     quoted discussion of an injection) so a false block has somewhere to
 *     show up.
 *
 * The split is frozen by hash, never stored: fnv1a(id + SPLIT_SALT) % 100
 * < 70 is dev, the rest test. Every headline number is the test split; the
 * threshold sweep runs on dev only.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { EvalContext, EvalType, FailureClass } from '../../src/types/eval.js';
import { FAILURE_CLASS_IDS } from '../../src/eval/failure-classes.js';
import { fnv1a, materialiseCase, type CorpusCaseRaw } from './materialise.js';
import { loadCorpus, type CorpusFile } from './corpus.js';

export const COMPOSITE_DIR = 'proof/composite';
export const REAL_TRANSCRIPTS_DIR = 'tests/fixtures/real-transcripts';
export const SPLIT_SALT = 'iris-composite-split-v1';
export const DEV_SHARE = 70;

export type Split = 'dev' | 'test';
export type Provenance = 'real-transcript' | 'composed';
export type InjectWhere = 'output' | 'input' | `tool_calls[${number}].output`;
export type InjectPosition = 'append' | 'prepend' | 'replace';

export interface CompositeInject {
  /** The family file's `family` (`pii`, `injection` …). */
  family: string;
  /** The case id inside that family. */
  caseId: string;
  /** Which field of the base receives the family case's OUTPUT text. */
  where: InjectWhere;
  position: InjectPosition;
}

export interface CompositeExpected {
  /** What is true by construction: the failure classes present. Empty = clean. */
  classes: FailureClass[];
  /** The ship verdict a person gives; null when the case is a boundary nobody has ruled on. */
  shouldShip: boolean | null;
  /** Optional per-bundle expectation, where the author stated one. */
  bundles?: Partial<Record<EvalType, 'pass' | 'fail' | 'not_judged'>>;
  labelledBy: 'construction' | 'human';
}

export interface CompositeCase {
  id: string;
  provenance: Provenance;
  /**
   * `t-NN` for a real transcript; `<family>:<caseId>` for a family case used
   * whole (its own input, output, context) as the base.
   */
  base: string;
  inject?: CompositeInject[];
  /** Overrides applied after the base and the injections (costUsd, tokenUsage, toolCalls …). */
  /**
   * Overrides applied after the base and the injections.
   *
   * `output` is here for the act layer: a case about a call that was not
   * callable lives in the relationship between a call and a schema, and
   * there is no text to splice into a clean transcript that would create
   * one. Such a case states its own output, and `base` still supplies
   * everything it does not state.
   */
  context?: Partial<Pick<EvalContext, 'output' | 'costUsd' | 'tokenUsage' | 'toolCalls' | 'tools' | 'spans' | 'expected' | 'input'>>;
  notes: string;
  expected: CompositeExpected;
}

export interface CompositeFile {
  schemaVersion: 1;
  source: string;
  labelling: string;
  /** The stated rule that assigns shouldShip by construction. */
  shouldShipRule: string;
  /** The classes the rule treats as "must not ship" when present. */
  tierA: FailureClass[];
  cases: CompositeCase[];
}

export interface RealTranscript {
  id: string;
  file: string;
  input?: string;
  output?: string;
  tool_calls?: EvalContext['toolCalls'];
  cost_usd?: number;
  token_usage?: EvalContext['tokenUsage'];
}

export interface LoadedComposite {
  files: CompositeFile[];
  cases: CompositeCase[];
  transcripts: Map<string, RealTranscript>;
  families: Map<string, CorpusFile>;
  /** 12-hex sha256 over the composite files, the transcripts they reference and the family corpus version. */
  compositeVersion: string;
  corpusVersion: string;
}

export function splitOf(id: string): Split {
  return fnv1a(id + SPLIT_SALT) % 100 < DEV_SHARE ? 'dev' : 'test';
}

/** The 24 real transcripts, keyed `t-NN`, answer keys stripped. */
export async function loadRealTranscripts(root: string): Promise<Map<string, RealTranscript>> {
  const dir = resolve(root, REAL_TRANSCRIPTS_DIR);
  const names = (await readdir(dir)).filter((n) => /^t-\d\d-.*\.json$/.test(n)).sort();
  const out = new Map<string, RealTranscript>();
  for (const name of names) {
    const raw = JSON.parse((await readFile(resolve(dir, name), 'utf-8')).replace(/\r\n/g, '\n')) as Record<string, unknown>;
    const id = name.slice(0, 4);
    out.set(id, {
      id,
      file: name,
      input: raw.input as string | undefined,
      output: raw.output as string | undefined,
      tool_calls: raw.tool_calls as EvalContext['toolCalls'],
      cost_usd: raw.cost_usd as number | undefined,
      token_usage: raw.token_usage as EvalContext['tokenUsage'],
    });
  }
  return out;
}

export async function loadComposite(root: string): Promise<LoadedComposite> {
  const dir = resolve(root, COMPOSITE_DIR);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const hash = createHash('sha256');
  const files: CompositeFile[] = [];
  for (const name of names) {
    const raw = (await readFile(resolve(dir, name), 'utf-8')).replace(/\r\n/g, '\n');
    hash.update(`${name}\n${raw}\n`);
    files.push(JSON.parse(raw) as CompositeFile);
  }
  const transcripts = await loadRealTranscripts(root);
  for (const [id, t] of [...transcripts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${id}\n${JSON.stringify({ input: t.input, output: t.output, tool_calls: t.tool_calls, cost_usd: t.cost_usd, token_usage: t.token_usage })}\n`);
  }
  const corpus = await loadCorpus(root);
  hash.update(`corpus\n${corpus.corpusVersion}\n`);
  const families = new Map(corpus.files.map((f) => [f.family, f]));
  return {
    files,
    cases: files.flatMap((f) => f.cases),
    transcripts,
    families,
    compositeVersion: hash.digest('hex').slice(0, 12),
    corpusVersion: corpus.corpusVersion,
  };
}

/** The EvalContext a family case declares, materialised (placeholders filled from the case id). */
export function familyCaseContext(file: CorpusFile, raw: CorpusCaseRaw): EvalContext {
  const c = materialiseCase(raw);
  const ctx: EvalContext = { output: c.output };
  if (c.input !== undefined) ctx.input = c.input;
  if (c.expected !== undefined) ctx.expected = c.expected;
  if (file.config && Object.keys(file.config).length > 0) ctx.customConfig = { ...file.config };
  if (c.context) {
    const extra = c.context as Partial<EvalContext>;
    if (extra.costUsd !== undefined) ctx.costUsd = extra.costUsd;
    if (extra.tokenUsage !== undefined) ctx.tokenUsage = extra.tokenUsage;
    if (extra.toolCalls !== undefined) ctx.toolCalls = extra.toolCalls;
    if (extra.tools !== undefined) ctx.tools = extra.tools;
    if (extra.spans !== undefined) ctx.spans = extra.spans;
    if (extra.metadata !== undefined) ctx.metadata = extra.metadata;
    if (extra.customConfig !== undefined) ctx.customConfig = { ...(ctx.customConfig ?? {}), ...extra.customConfig };
  }
  return ctx;
}

function findFamilyCase(loaded: LoadedComposite, family: string, caseId: string): { file: CorpusFile; raw: CorpusCaseRaw } {
  const file = loaded.families.get(family);
  if (!file) throw new Error(`composite: no family "${family}"`);
  const raw = file.cases.find((c) => c.id === caseId);
  if (!raw) throw new Error(`composite: no case "${caseId}" in family "${family}"`);
  return { file, raw };
}

function transcriptContext(t: RealTranscript): EvalContext {
  const ctx: EvalContext = { output: t.output ?? '' };
  if (t.input !== undefined) ctx.input = t.input;
  if (t.tool_calls !== undefined) ctx.toolCalls = t.tool_calls;
  if (t.cost_usd !== undefined) ctx.costUsd = t.cost_usd;
  if (t.token_usage !== undefined) ctx.tokenUsage = t.token_usage;
  return ctx;
}

function splice(existing: string | undefined, text: string, position: InjectPosition): string {
  if (position === 'replace' || !existing) return text;
  return position === 'append' ? `${existing}\n\n${text}` : `${text}\n\n${existing}`;
}

/** The evaluation input a composite case materialises to — what the engine is called with. */
export function compositeContext(loaded: LoadedComposite, c: CompositeCase): EvalContext {
  let ctx: EvalContext;
  if (/^t-\d\d$/.test(c.base)) {
    const t = loaded.transcripts.get(c.base);
    if (!t) throw new Error(`composite ${c.id}: no real transcript "${c.base}"`);
    ctx = transcriptContext(t);
  } else {
    const [family, caseId] = c.base.split(':');
    const { file, raw } = findFamilyCase(loaded, family, caseId);
    ctx = familyCaseContext(file, raw);
  }
  for (const inj of c.inject ?? []) {
    const { file, raw } = findFamilyCase(loaded, inj.family, inj.caseId);
    const injected = familyCaseContext(file, raw);
    if (inj.where === 'output') ctx.output = splice(ctx.output, injected.output, inj.position);
    else if (inj.where === 'input') ctx.input = splice(ctx.input, injected.input ?? injected.output, inj.position);
    else {
      const m = /^tool_calls\[(\d+)\]\.output$/.exec(inj.where);
      const index = m ? Number(m[1]) : NaN;
      const calls = [...(ctx.toolCalls ?? [])];
      if (!calls[index]) throw new Error(`composite ${c.id}: ${inj.where} does not exist on the base`);
      calls[index] = { ...calls[index], output: splice(String(calls[index].output ?? ''), injected.output, inj.position) };
      ctx.toolCalls = calls;
    }
    // A family case with a trajectory or a cost carries it into the composite.
    if (injected.toolCalls && !ctx.toolCalls) ctx.toolCalls = injected.toolCalls;
    if (injected.costUsd !== undefined && ctx.costUsd === undefined) ctx.costUsd = injected.costUsd;
    if (injected.customConfig) ctx.customConfig = { ...(ctx.customConfig ?? {}), ...injected.customConfig };
  }
  if (c.context) {
    if (c.context.output !== undefined) ctx.output = c.context.output;
    if (c.context.costUsd !== undefined) ctx.costUsd = c.context.costUsd;
    if (c.context.tokenUsage !== undefined) ctx.tokenUsage = c.context.tokenUsage;
    if (c.context.toolCalls !== undefined) ctx.toolCalls = c.context.toolCalls;
    if (c.context.tools !== undefined) ctx.tools = c.context.tools;
    if (c.context.spans !== undefined) ctx.spans = c.context.spans;
    if (c.context.expected !== undefined) ctx.expected = c.context.expected;
    if (c.context.input !== undefined) ctx.input = c.context.input;
  }
  return ctx;
}

const PROVENANCES: readonly Provenance[] = ['real-transcript', 'composed'];
const POSITIONS: readonly InjectPosition[] = ['append', 'prepend', 'replace'];

/** Every problem with the composite corpus, as sentences. Empty = valid. */
export function validateComposite(loaded: LoadedComposite): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const classes = new Set<FailureClass>(FAILURE_CLASS_IDS);
  for (const file of loaded.files) {
    if (file.schemaVersion !== 1) issues.push('composite: schemaVersion must be 1');
    if (!file.source || !file.labelling || !file.shouldShipRule) issues.push('composite: source, labelling and shouldShipRule must be stated');
    if (!Array.isArray(file.tierA) || file.tierA.length === 0) issues.push('composite: tierA must list the must-not-ship classes');
    for (const t of file.tierA ?? []) if (!classes.has(t)) issues.push(`composite: tierA names an unknown class "${t}"`);
    for (const c of file.cases) {
      const at = `composite → ${c.id ?? '(no id)'}`;
      if (!c.id) issues.push(`${at}: missing id`);
      else if (ids.has(c.id)) issues.push(`${at}: duplicate id`);
      ids.add(c.id);
      if (!PROVENANCES.includes(c.provenance)) issues.push(`${at}: provenance must be real-transcript | composed`);
      if (typeof c.notes !== 'string' || c.notes.length === 0) issues.push(`${at}: notes missing`);
      if (!c.expected) {
        issues.push(`${at}: expected missing`);
        continue;
      }
      for (const k of c.expected.classes ?? []) if (!classes.has(k)) issues.push(`${at}: unknown class "${k}"`);
      if (!['construction', 'human'].includes(c.expected.labelledBy)) issues.push(`${at}: labelledBy must be construction | human`);
      if (c.expected.shouldShip !== null && typeof c.expected.shouldShip !== 'boolean') issues.push(`${at}: shouldShip must be true, false or null`);
      if (c.provenance === 'real-transcript' && !/^t-\d\d$/.test(c.base)) issues.push(`${at}: a real transcript's base must be t-NN`);
      if (c.expected.labelledBy === 'construction' && c.expected.shouldShip !== null) {
        const tierA = new Set(file.tierA);
        const expectedShip = !(c.expected.classes ?? []).some((k) => tierA.has(k));
        if (c.expected.shouldShip !== expectedShip) issues.push(`${at}: shouldShip ${c.expected.shouldShip} contradicts the stated rule for classes [${(c.expected.classes ?? []).join(', ')}]`);
      }
      for (const inj of c.inject ?? []) {
        if (!POSITIONS.includes(inj.position)) issues.push(`${at}: inject position must be append | prepend | replace`);
        if (!(inj.where === 'output' || inj.where === 'input' || /^tool_calls\[\d+\]\.output$/.test(inj.where))) issues.push(`${at}: inject where "${inj.where}" is not a field`);
      }
      try {
        const ctx = compositeContext(loaded, c);
        // An empty output is itself the format failure a case may carry.
        if (typeof ctx.output !== 'string' || (ctx.output.length === 0 && !c.expected.classes.includes('format'))) issues.push(`${at}: materialises to an empty output`);
      } catch (err) {
        issues.push(`${at}: ${(err as Error).message}`);
      }
    }
  }
  if (ids.size < 100) issues.push(`composite: ${ids.size} cases; the corpus needs at least 100`);
  const real = loaded.cases.filter((c) => c.provenance === 'real-transcript').length;
  if (real !== loaded.transcripts.size) issues.push(`composite: ${real} real-transcript cases for ${loaded.transcripts.size} transcripts; every transcript is promoted exactly once`);
  return issues;
}
