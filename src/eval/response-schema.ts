/*
 * The one zod object that IS the evaluation response.
 *
 * Three things read it: the response-shape drift-lock test (which runs the
 * real tool handlers and validates what they return), the tools'
 * `outputSchema` once the structured-content release lands, and — at 1.0 —
 * the published response-schema-v1.json. Keeping them one object is what
 * makes "the response shape is settled" checkable: a field added here is
 * additive by construction (every object is loose — unknown keys pass), and a field
 * removed or re-meant fails the drift-lock before it can ship.
 *
 * Optional everywhere a field is optional on the TypeScript type; the test
 * asserts presence where the release promises it (every built-in result
 * carries kind, role, saw, uncertainty), so this schema states the shape
 * and the test states the promise.
 */
import { z } from 'zod';

export const intervalSchema = z.looseObject({ point: z.number(), lo: z.number(), hi: z.number() });

const priorSchema = z.looseObject({ pi: z.number(), source: z.enum(['default', 'config', 'estimated']) });
const corpusSchema = z.looseObject({
    n: z.number().int(),
    tp: z.number().int(),
    fp: z.number().int(),
    fn: z.number().int(),
    tn: z.number().int(),
    version: z.string(),
    release: z.string(),
    labelling: z.enum(['same-model', 'human-verified']),
  });

export const uncertaintySchema = z.discriminatedUnion('basis', [
  // One member per basis (zod's discriminator must be unique); the fired /
  // not-fired split is enforced by the refinement: a fire carries ppv, a
  // quiet result carries missRate.
  z
    .looseObject({ basis: z.literal('published_accuracy'), fired: z.boolean(), ppv: intervalSchema.optional(), missRate: intervalSchema.optional(), prior: priorSchema, corpus: corpusSchema })
    .refine((v) => (v.fired ? v.ppv !== undefined : v.missRate !== undefined), { message: 'a fired result carries ppv; a quiet one carries missRate' }),
  z.looseObject({ basis: z.literal('definition'), conformance: z.looseObject({ n: z.number().int(), matched: z.number().int() }) }),
  z.looseObject({ basis: z.literal('self_consistency'), samples: z.number().int(), voteFraction: z.number(), scoreSd: z.number() }),
  z.looseObject({ basis: z.literal('local_labels'), precision: intervalSchema, n: z.number().int() }),
  z.looseObject({ basis: z.literal('policy') }),
  z.looseObject({ basis: z.literal('unmeasured'), why: z.string() }),
]);

export const evidenceSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('span'), source: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), label: z.string() }),
  z.looseObject({ type: z.literal('pattern'), name: z.string(), count: z.number().int().nonnegative() }),
  z.looseObject({ type: z.literal('toolCall'), index: z.number().int().nonnegative(), toolName: z.string(), label: z.string() }),
  z.looseObject({ type: z.literal('citation'), url: z.string(), status: z.enum(['resolved', 'dead', 'unverifiable', 'supported', 'unsupported']) }),
  z.looseObject({ type: z.literal('count'), stat: z.string(), unit: z.string(), value: z.number(), threshold: z.number().optional(), thresholdSource: z.enum(['default', 'config', 'call', 'rule']).optional() }),
]);
export const measuredValueSchema = z.looseObject({ stat: z.string(), unit: z.string(), value: z.number() });

export const claimKindSchema = z.enum(['measurement', 'detection', 'inference', 'judgment', 'policy', 'verification']);
export const roleSchema = z.enum(['gate', 'veto', 'risk', 'advisory', 'term']);
export const skipClassSchema = z.enum(['not_applicable', 'defeated', 'config_invalid']);
export const needSchema = z.enum(['output', 'input', 'expected', 'tool_calls', 'tool_outputs', 'tools_catalogue', 'cost', 'tokens', 'citations']);
export const questionIdSchema = z.enum(['safe_output', 'grounded', 'complete', 'relevant', 'task_completed', 'tool_use_correct', 'within_budget']);

export const evalRuleResultSchema = z.looseObject({
    ruleName: z.string(),
    ruleId: z.string().optional(),
    category: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']).optional(),
    critical: z.boolean().optional(),
    criticalSource: z.enum(['default', 'config']).optional(),
    passed: z.boolean(),
    score: z.number(),
    message: z.string(),
    skipped: z.boolean().optional(),
    skipReason: z.string().optional(),
    configInvalid: z.boolean().optional(),
    budgetExceeded: z.boolean().optional(),
    kind: claimKindSchema.optional(),
    role: roleSchema.optional(),
    question: questionIdSchema.optional(),
    classes: z.array(z.string()).optional(),
    ruleVersion: z.number().int().optional(),
    saw: z.array(needSchema).optional(),
    skipClass: skipClassSchema.optional(),
    uncertainty: uncertaintySchema.optional(),
    evidence: z.array(evidenceSchema).optional(),
    value: measuredValueSchema.optional(),
  });

export const evalCategoryResultSchema = z.looseObject({
    score: z.number().nullable(),
    passed: z.boolean().nullable(),
    rules_evaluated: z.number().int(),
    rules_skipped: z.number().int(),
    insufficient_data: z.boolean(),
    critical_failures: z.array(z.string()).optional(),
    critical_skipped: z.array(z.string()).optional(),
  });

export const coverageSchema = z.looseObject({
  inputs: z.record(z.string(), z.boolean()),
  questions: z.array(z.looseObject({ id: questionIdSchema, status: z.enum(['judged', 'unjudged', 'not_applicable']), why: z.string().optional() })),
  dormant: z.array(z.looseObject({ ruleId: z.string(), name: z.string(), reason: z.string() })).optional(),
});
export const verdictSchema = z.looseObject({
  state: z.enum(['pass', 'fail', 'unknown']),
  passed: z.boolean(),
  basis: z.enum(['policy_gate', 'detector_veto', 'critical_unknown', 'required_evidence_missing', 'risk_over_loss', 'score_below_threshold', 'clean', 'no_rules']),
  by: z.array(z.string()),
  risk: z.looseObject({ pBad: z.number(), lo: z.number(), hi: z.number() }).nullable(),
  confidence: z.enum(['decisive', 'marginal']).optional(),
});
export const provenanceSchema = z.looseObject({
  irisVersion: z.string(),
  rulesetHash: z.string(),
  configHash: z.string(),
  thresholds: z.looseObject({ default: z.number(), perRule: z.record(z.string(), z.unknown()).optional() }),
  corpusVersion: z.string(),
  judgedAt: z.string(),
});

/** The `evaluate_output` response — the same object the engine returns plus the tool's own fields. */
export const evaluateOutputResponseSchema = z.looseObject({
    id: z.string(),
    trace_id: z.string().optional(),
    verdict: verdictSchema.optional(),
    coverage: coverageSchema.optional(),
    provenance: provenanceSchema.optional(),
    eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom', 'all']),
    score: z.number(),
    passed: z.boolean(),
    rule_results: z.array(evalRuleResultSchema),
    suggestions: z.array(z.string()),
    rules_evaluated: z.number().int(),
    rules_skipped: z.number().int(),
    insufficient_data: z.boolean(),
    critical_failures: z.array(z.string()).optional(),
    critical_skipped: z.array(z.string()).optional(),
    categories: z.record(z.string(), evalCategoryResultSchema).optional(),
    note: z.string().optional(),
  });

export type EvaluateOutputResponse = z.infer<typeof evaluateOutputResponseSchema>;
