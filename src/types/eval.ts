import type { Span, Step, ToolCallRecord, ToolDescriptor } from './trace.js';

export type EvalType = 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom';

/**
 * What an EvalResult can be tagged as: a single bundle (EvalType), or
 * 'all' — evaluate_output's eval_type="all", which runs every bundle in one
 * pass and reports a per-category breakdown beside the overall verdict.
 * Kept apart from EvalType on purpose: rules are deployed and registered
 * under a real bundle, never under 'all'.
 */
export type EvalResultType = EvalType | 'all';

/**
 * What KIND of claim a rule makes — the mandate's distinction between a
 * measurement (a statistic against a threshold), a detection (a pattern is
 * present, with a measured error rate), an inference (a signal standing in
 * for an unobservable property), a judgment (a model's reasoning), a policy
 * (the deployment's own constraint) and an external verification. Kind is
 * the claim; `mechanism` is how the claim is measured. The composer decides
 * by kind and never averages kinds together.
 */
export type ClaimKind = 'measurement' | 'detection' | 'inference' | 'judgment' | 'policy' | 'verification';
export type Mechanism = 'formula' | 'pattern' | 'heuristic' | 'model' | 'external';
/** An input a rule reads. A rule skips — never passes — when a declared need is absent. */
export type Need = 'output' | 'input' | 'expected' | 'tool_calls' | 'tool_outputs' | 'tools_catalogue' | 'cost' | 'tokens' | 'citations';
/** The evaluation question a rule answers; the registry is src/eval/questions.ts. */
export type QuestionId = 'safe_output' | 'grounded' | 'complete' | 'relevant' | 'task_completed' | 'tool_use_correct' | 'within_budget';
/** What went wrong, in the reader's words, independent of which rule caught it; the registry is src/eval/failure-classes.ts. */
export type FailureClass =
  | 'pii_leak'
  | 'credential_leak'
  | 'injection'
  | 'injection_compliance'
  | 'silent_tool_failure'
  | 'tool_loop'
  | 'stub'
  | 'fabrication'
  | 'ungrounded'
  | 'incomplete_ask'
  | 'off_task'
  | 'over_budget'
  | 'format'
  | 'invalid_tool_call';

export interface EvalRule {
  name: string;
  description: string;
  evalType: EvalType;
  weight: number;
  /**
   * Hard-fail marker. When a critical rule FAILS (and was not skipped), the
   * overall eval reports passed=false regardless of the weighted score.
   *
   * Exists because the weighted average routinely outvotes a genuine
   * violation: an output leaking a real SSN failed no_pii while the other
   * safety rules passed, scoring ~0.765 — above the 0.7 threshold — so the
   * one field every CI gate reads said passed:true about the product's
   * flagship failure scenario. The score stays a quality gradient; `passed`
   * is the verdict, and a critical violation must never be averaged away.
   */
  critical?: boolean;
  /**
   * The rule's metadata — what kind of claim it makes, how it measures it,
   * what it reads, which question it answers, which failure classes a
   * failing result belongs to, and the version of its definition. Every
   * built-in declares all six (tests/unit/eval/rule-metadata.test.ts);
   * custom types declare kind, mechanism, needs and version and leave the
   * question to their author. Optional on the interface so a rule built
   * elsewhere still compiles; a result from a rule without them carries no
   * `kind`, which reads as unknown — never as a measurement.
   */
  kind?: ClaimKind;
  mechanism?: Mechanism;
  needs?: readonly Need[];
  question?: QuestionId;
  classes?: readonly FailureClass[];
  /** Bumped when the rule's meaning changes, so a stored result names the definition that produced it. */
  version?: number;
  /**
   * Who wrote this rule. `custom` marks anything `createCustomRule`
   * produced — a deployed rule or one passed inline in the call. The
   * composer needs it: for OUR rule a shipped threshold is a guess and only
   * advises, while for THEIRS the severity they deployed it at is their own
   * statement of how much it matters. Absent means built-in.
   */
  origin?: 'built-in' | 'custom';
  evaluate(context: EvalContext): EvalRuleResult;
}

export interface EvalContext {
  output: string;
  expected?: string;
  input?: string;
  /**
   * The agent's trajectory — what it actually DID, in call order.
   *
   * Deliberately the SAME record the capture path stores (ToolCallRecord =
   * log_trace's `tool_calls[]`), not a narrower local shape. It used to be
   * a three-field inline type without `error`, so a rule could see that a
   * tool was called but never that it FAILED: the acceptance pass found
   * three real transcripts that answered confidently after a grep exited 1,
   * an ls hit a missing directory and a node -e threw, and no rule could
   * reach the fact. Re-declaring a subset here would reintroduce exactly
   * that gap the next time a field is added to the capture shape.
   */
  toolCalls?: ToolCallRecord[];
  /**
   * The raw spans the CALLER supplied.
   *
   * NO RULE MAY READ THIS. It is transport, and there is exactly one
   * derived reading of a trajectory (src/eval/steps.ts, reached through
   * stepsOf). Two vocabularies for "what the agent did" is the drift
   * rules/trajectory.ts exists to prevent, and it would land in rules whose
   * measured accuracy is arithmetic inside the verdict. Enforced by
   * tests/unit/eval/steps-single-reading.test.ts.
   */
  spans?: Span[];
  /**
   * The derived trajectory, computed once per evaluation by the engine.
   *
   * Rules read it through stepsOf(context), never directly: the proof
   * runner evaluates a rule without going through the engine, and a rule
   * that read the field would skip on every corpus case.
   */
  steps?: readonly Step[];
  /**
   * The tools the agent could have called, in the MCP tools/list shape.
   *
   * Without it a call can be seen but not CHECKED: argument validity is a
   * question about a call against the schema its tool declares, and until
   * this field existed nothing held that schema. A rule that needs it
   * declares `tools_catalogue` in its needs and skips without it, so an
   * evaluation that could not check arguments says so rather than passing.
   */
  tools?: ToolDescriptor[];
  tokenUsage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  costUsd?: number;
  metadata?: Record<string, unknown>;
  customConfig?: Record<string, unknown>;
  /**
   * Per-evaluation regex circuit breaker, initialized by the engine (never
   * by callers). Each sandbox budget breach increments `breaches`; once it
   * reaches the cap, remaining regex rules in the SAME evaluation skip
   * without running. Bounds how long a single hostile output can stall a
   * request: without it, N regex rules × (budget + worker respawn) of
   * main-thread stall scale linearly with N.
   */
  regexBudget?: { breaches: number };

  /**

   * Whether this evaluation may call a paid provider. Set ONLY by the tools

   * whose whole purpose is to do so — the LLM judge and the citation

   * verifier. The engine refuses to run a judgment rule without it, which

   * is what makes "evaluate_output never spends" a property of the engine

   * rather than a promise in a tool description.

   */

  allowPaid?: boolean;
}

/**
 * What the composer DID with a result under this deployment's configuration
 * — distinct from `kind`, which is what the rule claims. Today's composer
 * (a weighted mean plus the critical veto) knows two roles: `veto` for an
 * effectively critical rule and `term` for one that feeds the score. The
 * compose-by-kind release adds `gate` (a configured policy that decides),
 * `risk` (a detection or inference feeding the risk estimate) and
 * `advisory` (reported, deciding nothing).
 */
export type Role = 'gate' | 'veto' | 'risk' | 'advisory' | 'term';

/**
 * Why a rule skipped. `not_applicable`: the evidence it needs was not
 * supplied (never asked — coverage). `defeated`: asked and could not answer,
 * because this output stalled its pattern past the sandbox budget.
 * `config_invalid`: asked and could not answer, because its definition is
 * broken. A gate that fails closed treats the last two as unknown; the first
 * is a coverage fact, not a verdict.
 */
export type SkipClass = 'not_applicable' | 'defeated' | 'config_invalid';

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

/**
 * What a rule saw — typed, locatable, never an excerpt. A detection reports
 * the OFFSETS of what it matched (into the raw text, so a leak detector can
 * redact the span it found without ever repeating it); a trajectory rule the
 * index of the call it judged; a measurement its statistic with a unit and
 * the threshold it was held to; a signal that yields no offset yet reports
 * its name and count. The reader can locate every claim; the stored row
 * can be redacted; nothing here restates the offending text.
 */
export type Evidence =
  | { type: 'span'; source: 'output' | 'input' | `tool_outputs[${number}]`; start: number; end: number; label: string }
  | { type: 'pattern'; name: string; count: number }
  | { type: 'toolCall'; index: number; toolName: string; label: string }
  | { type: 'citation'; url: string; status: 'resolved' | 'dead' | 'unverifiable' | 'supported' | 'unsupported' }
  | { type: 'count'; stat: string; unit: string; value: number; threshold?: number; thresholdSource?: 'default' | 'config' | 'call' | 'rule' }
  /*
   * One judge sample (0.10.0). `score` is what the model returned;
   * `selfReportedPass` is what it CLAIMED about passing, recorded because
   * the verdict comes from the template's threshold and not from the claim,
   * and a disagreement between the two is worth a reader's attention. With
   * `samples: n` there is one of these per sample, which is what the
   * self-consistency interval is computed from.
   */
  | { type: 'sample'; score: number; selfReportedPass?: boolean; rationaleHash: string };

/** A measurement's statistic — the number the rule computed, with its unit, before any score transform. */
export interface MeasuredValue {
  stat: string;
  unit: string;
  value: number;
}

/** Evidence lists are capped so a pathological output cannot balloon a stored row. */
export const MAX_EVIDENCE_ITEMS = 25;

/**
 * Which evaluation questions this evaluation judged, which it did not and
 * why — coverage by question, not by rule count. `inputs` says what the
 * call carried; a question is `judged` when at least one rule that answers
 * it ran, `unjudged` when every such rule skipped (the reason names the
 * missing input, or that the rule was defeated or broken), and
 * `not_applicable` when no rule for it was in the selected bundles.
 */
export interface Coverage {
  inputs: Record<Need, boolean>;
  questions: Array<{ id: QuestionId; status: 'judged' | 'unjudged' | 'not_applicable'; why?: string }>;
  /** Quarantined critical rules that did not run (surfaced by the rule-store release). */
  dormant?: Array<{ ruleId: string; name: string; reason: string }>;
}

/**
 * The verdict with its basis. `passed` is `state === 'pass'` and equals the
 * top-level `passed`; `basis` says which layer decided — a configured policy,
 * a detector's veto, nothing judged, or the score against the threshold.
 * `risk` is null until the compose-by-kind release computes it.
 */
/**
 * A sentence a reader needs that the verdict alone does not carry, with who
 * it is for and what to change. The one that must exist: when a rule
 * visibly FIRED and the verdict still passed, say why and name the setting
 * that would change it — "cost_under_threshold failed" beside
 * "passed: true" reads as a bug to anyone who has not read the composer.
 *
 * `suggestions` remains for now and is rendered from these; it is deprecated
 * from 0.13.0 and removed at 1.0, per VERSIONING.md's two-minor rule.
 */
export interface Interpretation {
  severity: 'block' | 'warn' | 'note';
  addressee: 'agent' | 'operator' | 'author';
  /** The rule this is about, when it is about one. */
  rule?: string;
  text: string;
  /** The configuration key that changes this behaviour, when there is one. */
  configKey?: string;
}

/** Placed on EvalResult by the engine; see Interpretation above. */
export interface Verdict {
  state: 'pass' | 'fail' | 'unknown';
  passed: boolean;
  basis: 'policy_gate' | 'detector_veto' | 'critical_unknown' | 'required_evidence_missing' | 'risk_over_loss' | 'score_below_threshold' | 'clean' | 'no_rules';
  by: string[];
  risk: { pBad: number; lo: number; hi: number; perClass: Partial<Record<FailureClass, number | null>>; assumptions: string[] } | null;
  confidence?: 'decisive' | 'marginal';
}

/** What produced this verdict, so it can be replayed or compared: the release, the ruleset, the configuration, the thresholds, the proof corpus, the time. */
export interface Provenance {
  irisVersion: string;
  rulesetHash: string;
  configHash: string;
  thresholds: { default: number; perRule?: Record<string, unknown> };
  corpusVersion: string;
  /**
   * Which toolset the calls were checked against, when one was supplied.
   *
   * Its own field rather than a term of `configHash`: that hash answers
   * "under what configuration", and the catalogue is an INPUT to the
   * evaluation, like the output text. Folding it in would break the
   * invariant the (tenant, engine, ruleset) index exists to exploit — the
   * same configuration must produce the same hash.
   */
  toolsHash?: string;
  judgedAt: string;
}

/**
 * How wrong this result tends to be, and on what basis. `published_accuracy`
 * carries the rule's measured numbers from the shipped proof (src/eval/
 * published-accuracy.ts): for a fired detection or inference the positive
 * predictive value at the stated prior, for one that did not fire the
 * residual miss rate, each with a 95% credible interval. `definition` is a
 * measurement's conformance to its formula (n cases, matched). `policy` is
 * the deployment's own constraint — no error rate applies. `self_consistency`
 * and `local_labels` arrive with the judge-through-the-engine and the
 * own-traffic labels releases. `unmeasured` says why nothing can be stated.
 */
export type Uncertainty =
  | {
      basis: 'published_accuracy';
      fired: true;
      ppv: Interval;
      prior: { pi: number; source: 'default' | 'config' | 'estimated' };
      corpus: { n: number; tp: number; fp: number; fn: number; tn: number; version: string; release: string; labelling: 'same-model' | 'human-verified' };
    }
  | {
      basis: 'published_accuracy';
      fired: false;
      missRate: Interval;
      prior: { pi: number; source: 'default' | 'config' | 'estimated' };
      corpus: { n: number; tp: number; fp: number; fn: number; tn: number; version: string; release: string; labelling: 'same-model' | 'human-verified' };
    }
  | { basis: 'definition'; conformance: { n: number; matched: number } }
  | { basis: 'self_consistency'; samples: number; voteFraction: number; scoreSd: number }
  | { basis: 'local_labels'; precision: Interval; n: number }
  | { basis: 'policy' }
  | { basis: 'unmeasured'; why: string };

export interface EvalRuleResult {
  ruleName: string;
  /**
   * What kind of claim this result makes, what the composer did with it,
   * which question it answers and which failure classes a failure belongs
   * to — stamped by the engine from the rule's declaration (0.9.0). Absent
   * on results written before that release and on rules that declare no
   * metadata; never fabricated on read.
   */
  kind?: ClaimKind;
  role?: Role;
  question?: QuestionId;
  classes?: FailureClass[];
  /** The version of the rule definition that produced this result. */
  ruleVersion?: number;
  /** Who wrote the rule: `custom` for anything createCustomRule produced. See EvalRule.origin. */
  origin?: 'built-in' | 'custom';
  /** Which of the rule's declared needs the call actually carried — what the rule SAW. */
  saw?: Need[];
  /** Present only when `skipped`; says whether the rule was never asked or was asked and could not answer. */
  skipClass?: SkipClass;
  /** How wrong this result tends to be, and on what basis. Present on every result that made a claim (not on skips). */
  uncertainty?: Uncertainty;
  /** What the rule saw: spans (offsets, never text), tool-call indices, pattern names, counts. Present on every fired detection or inference, and on measurements. */
  evidence?: Evidence[];
  /** A measurement's statistic and unit — the number before the score transform. */
  value?: MeasuredValue;
  /**
   * Deployed rule id (rule-<hex>) when the rule came from the custom-rule
   * store. Absent for built-in rules and for inline custom_rules. Names are
   * not unique — a same-name redeploy with replace:true mints a new id, and
   * stores written before the same-name guard may hold duplicates — so this
   * is the field that tells two same-named results apart (#373).
   */
  ruleId?: string;
  /**
   * The bundle this rule belongs to. Present only on eval_type="all"
   * results, where rule_results spans every bundle and a reader needs to
   * regroup them.
   */
  category?: EvalType;
  /**
   * Whether this rule VETOES the verdict — its EFFECTIVE criticality, after
   * `eval.criticalRules` / `eval.nonCriticalRules` are applied, not the
   * value on the rule's definition. A reader holding a failed evaluation
   * could otherwise not tell a hard violation from a low score without
   * knowing the rule library by heart.
   */
  critical?: boolean;
  /**
   * Who decided that: 'default' is the rule's own declaration (for a
   * deployed custom rule, the severity it was deployed with); 'config' means
   * one of the two override lists named it. The distinction is the point of
   * making criticality configurable — an operator reading a verdict must be
   * able to see that their own promotion caused it.
   */
  criticalSource?: 'default' | 'config';
  passed: boolean;
  score: number;
  message: string;
  skipped?: boolean;
  skipReason?: string;
  // Set when the rule skipped because its DEFINITION is broken (invalid
  // config / uncompilable regex), not because this input had nothing to
  // evaluate. Lets surfaces holding the whole definition — rule preview —
  // reject it outright instead of reporting every trace as "would skip".
  configInvalid?: boolean;
  // Set when the rule skipped because its regex exceeded the sandbox
  // matching budget ON THIS OUTPUT (or the per-evaluation circuit breaker
  // was already open). Distinct from configInvalid and from missing-context
  // skips on purpose: an output CRAFTED to stall a policy pattern lands
  // here, so a consumer that must fail closed can treat budgetExceeded
  // skips as failures on its own terms. Without this flag, "the pattern
  // was defeated" is indistinguishable from "nothing to evaluate".
  budgetExceeded?: boolean;

  /**
   * The rule was asked, and the evidence it needed was incomplete.
   *
   * Distinct from a missing input, which is coverage, and from a budget
   * breach, which is our own limit. This one says the caller supplied the
   * input and it was cut: a negative claim over a partial read is unsound
   * rather than merely uncertain, so the honest answer is that the rule
   * could not answer. It maps to skipClass "defeated", which is what makes
   * a deployment that promotes such a rule to critical get `unknown`
   * instead of a clean bill of health.
   */
  evidenceIncomplete?: boolean;
}

/**
 * Per-bundle verdict inside an eval_type="all" result. Same semantics as a
 * single-bundle EvalResult (threshold + critical veto), computed over that
 * bundle's rules only.
 *
 * `score` and `passed` are null when the bundle evaluated no rule (every
 * rule skipped for missing context — cost without cost_usd, relevance
 * without input). Such a bundle was not judged: it is neither passing nor
 * failing, `insufficient_data` is true, and it never counted toward the
 * overall verdict (#406). The top-level EvalResult keeps a boolean
 * `passed` on purpose — a gate keyed on it must fail closed.
 */
export interface EvalCategoryResult {
  score: number | null;
  passed: boolean | null;
  rules_evaluated: number;
  rules_skipped: number;
  insufficient_data: boolean;
  critical_failures?: string[];
  critical_skipped?: string[];
}

export interface EvalResult {
  id: string;
  trace_id?: string;
  eval_type: EvalResultType;
  output_text: string;
  expected_text?: string;
  score: number;
  passed: boolean;
  rule_results: EvalRuleResult[];
  suggestions: string[];
  created_at?: string;
  rules_evaluated?: number;
  rules_skipped?: number;
  insufficient_data?: boolean;
  /**
   * Names of critical rules that failed (present only when non-empty).
   * Any entry here forces passed=false regardless of the weighted score —
   * this field is how a caller tells "failed the quality bar" apart from
   * "committed a hard violation".
   */
  critical_failures?: string[];
  /**
   * Names of critical rules that were SKIPPED and therefore did not judge
   * this output (present only when non-empty). Almost always a sandbox
   * budget breach — a regex killed mid-backtrack, which an adversary can
   * provoke deliberately by crafting output that stalls a known pattern.
   *
   * This is the fail-open seam between the release's two headline features:
   * a budget-killed critical rule does NOT veto, so the evaluation can
   * return passed=true with no `critical_failures` at all. That is
   * deliberate (failing closed would let the same adversary force false
   * violations on benign output), but a consumer that must fail closed
   * needs to see it WITHOUT walking rule_results[].budgetExceeded. Treat a
   * non-empty `critical_skipped` as "unknown", not as "clean".
   */
  critical_skipped?: string[];
  /**
   * Per-bundle breakdown, present only when eval_type is 'all'. Keyed by
   * bundle; a bundle with no rules at all (nothing deployed under "custom"
   * and no inline custom_rules) is absent rather than reported as
   * insufficient. Response-only — not persisted as a column; the stored
   * rule_results carry a `category` per rule so a reader can regroup.
   */
  categories?: Partial<Record<EvalType, EvalCategoryResult>>;
  /** The verdict with its basis (0.9.0) — computed by the engine, derived on read for stored rows that carry provenance. */
  verdict?: Verdict;

  /** Sentences a reader needs that the verdict alone does not carry (0.10.0). */

  interpretations?: Interpretation[];
  /** Coverage by evaluation question (0.9.0) — computed by the engine, derived on read from the stamped rule results. */
  coverage?: Coverage;
  /** What produced this verdict (0.9.0) — persisted; absent on rows written before it, never fabricated. */
  provenance?: Provenance;
  /** What the evaluation itself cost (the judge's spend); undefined for the free rules. */
  eval_cost_usd?: number;
  eval_tokens?: number;
  /** Set when the linked trace was deleted (delete_trace or the retention sweep) and this row's text was erased. */
  erased_at?: string;
}

export type CustomRuleType =
  | 'regex_match'
  | 'regex_no_match'
  | 'min_length'
  | 'max_length'
  | 'contains_keywords'
  | 'excludes_keywords'
  | 'json_schema'
  | 'cost_threshold'
  | 'action_policy';

export interface CustomRuleDefinition {
  name: string;
  type: CustomRuleType;
  config: Record<string, unknown>;
  weight?: number;
}
