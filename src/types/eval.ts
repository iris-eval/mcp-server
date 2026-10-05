import type { CostEstimate, Span, Step, ToolCallRecord, ToolDescriptor, TraceCapture } from './trace.js';
import type { TenantId } from './tenant.js';
import type { JudgeRequest } from '../eval/llm-judge/budget.js';

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
export type Need = 'output' | 'input' | 'expected' | 'expected_trajectory' | 'tool_calls' | 'tool_outputs' | 'tools_catalogue' | 'cost' | 'tokens' | 'citations';

/**
 * Who wrote the evidence an evaluation judged (src/eval/evidence.ts):
 * `harness`, software that watched the agent and declared itself
 * (Trace.capture); `agent`, the agent's own report, through the log_trace
 * or evaluate_output tool; `not_declared`, a trace that said neither.
 */
export type RecordedBy = 'harness' | 'agent' | 'not_declared';

/**
 * What an evaluation's evidence was and who recorded it, stamped once by
 * the engine and stored with the evaluation, so a read composes the
 * verdict from the same facts the call was judged on.
 */
export interface EvidenceRecord {
  recordedBy: RecordedBy;
  /** The capture source's declaration, when one recorded the trace. */
  capture?: TraceCapture;
  /** The inputs the call carried (stamp.ts, inputsPresent), sorted. */
  carried: Need[];
  /** How many tool calls the record carried, when it carried its tool calls: 0 is a capture source's "none were made". */
  toolCalls?: number;
}
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
  | 'invalid_tool_call'
  | 'wrong_trajectory'
  | 'wrong_tool';

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
  /**
   * The configuration keys that make this rule the deployment's own policy
   * when one of them is set (`cost_threshold`, `max_steps`). The composer
   * reads it for one thing: a policy the deployment set, on a call that did
   * not carry what the policy reads, was asked and could not answer.
   */
  thresholdKeys?: readonly string[];
  /**
   * For a rule that compares against something the call itself supplies
   * (an expected trajectory): whether this call supplied the part this rule
   * reads. `expected_trajectory: { step_budget: 5 }` is an expectation for
   * the step budget and none for the sequence of calls.
   */
  expects?: (context: EvalContext) => boolean;
  question?: QuestionId;
  classes?: readonly FailureClass[];
  /** Bumped when the rule's meaning changes, so a stored result names the definition that produced it. */
  version?: number;
  /**
   * A hash of what the rule IS, for a rule whose definition is data the
   * deployment supplied: a deployed or inline rule's definition and
   * severity, a plugin's file. It enters the ruleset hash, so replacing a
   * rule with another under the same name changes the fingerprint of every
   * verdict that follows. A built-in rule has none: its definition is this
   * release, which `version` and the release version name.
   */
  contentHash?: string;
  /**
   * Who wrote this rule. `custom` marks anything `createCustomRule`
   * produced — a deployed rule or one passed inline in the call. The
   * composer needs it: for OUR rule a shipped threshold is a guess and only
   * advises, while for THEIRS the severity they deployed it at is their own
   * statement of how much it matters. Absent means built-in.
   */
  origin?: 'built-in' | 'custom' | 'plugin';
  /**
   * How this rule reads an output that was written as JSON
   * (src/eval/text/structured.ts): `values`, the strings, numbers and
   * booleans it carries, each its own paragraph; or `labelled`, the same
   * with the name of each field in front (`"password": hunter2`), and a
   * name alone where its value is an object, a list or null. The engine
   * hands the rule that text and maps every span it reports back onto the
   * output as sent. Absent: the rule reads the output exactly as sent,
   * which is what every custom rule does.
   */
  outputView?: 'values' | 'labelled';
  evaluate(context: EvalContext): EvalRuleResult;
}

/**
 * What the caller expected the agent to DO — the trajectory
 * counterpart of `expected`. Read by tool_sequence (the calls, in a mode)
 * and step_budget (the count, with a tolerance). Supplied per call on
 * evaluate_output as `expected_trajectory`; a dataset case's expected
 * trajectory reaching the ingest path is later work.
 */
export interface ExpectedToolCall {
  tool_name: string;
  /** When present, the call's arguments are compared under `args` (exact or subset). */
  input?: unknown;
}
export type ExpectedTrajectoryMode = 'strict' | 'unordered' | 'subset' | 'superset' | 'ordered_subset';
export type ExpectedArgsMode = 'exact' | 'subset';
export interface ExpectedTrajectory {
  /** The calls the caller expected, in order. */
  tool_calls?: ExpectedToolCall[];
  /**
   * strict = the actual calls equal the expected, in order; unordered =
   * equal as multisets; subset = every expected call is present;
   * superset = no call outside the expected set; ordered_subset = the
   * expected calls appear in order among the actual ones (default).
   */
  mode?: ExpectedTrajectoryMode;
  /** How an expected call's `input` is matched: exact (normalised) or subset (every expected key present with the same value). Default subset. */
  args?: ExpectedArgsMode;
  /** The step budget for THIS task; defaults to the number of expected calls when tool_calls is given. */
  step_budget?: number;
  /** step_budget × tolerance is the ceiling; default 1.5. */
  tolerance?: number;
}

export interface EvalContext {
  output: string;
  /**
   * Set by the engine, never by a caller: which reading of a structured
   * output `output` holds when the engine hands a rule its declared
   * reading (EvalRule.outputView). Absent: `output` is the output as sent.
   * The injection rule reads one shape only in the labelled reading: an
   * override as the value of a field.
   */
  outputRead?: 'values' | 'labelled';
  expected?: string;
  /** The trajectory the caller expected. */
  expectedTrajectory?: ExpectedTrajectory;
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
  /**
   * Where costUsd came from: the trace reported it, or Iris estimated it
   * from token counts × list price at ingest (src/cost/trace-cost.ts). The
   * cost rules act on either and say which in their message and evidence.
   * Absent means reported (a caller's own number).
   */
  costSource?: 'reported' | 'estimated';
  /** With an estimated cost: how it was computed, for the rule's message. */
  costEstimate?: CostEstimate;
  /**
   * The agent's most recent prior costs, newest first, at most 200 — the
   * baseline `cost_anomaly` reads. Supplied by the engine's callers from the
   * agent's failure log (src/eval/ingest.ts); absent on a bare
   * evaluate_output call, where the rule reports insufficient_history.
   */
  costHistory?: readonly number[];
  /**
   * Who recorded this evidence, and the capture source's declaration when
   * one recorded it (src/eval/evidence.ts, recordOfTrace). A field the
   * source declares complete is evidence even when it is empty: its empty
   * list of tool calls says none were made. Absent: nobody declared.
   */
  recordedBy?: RecordedBy;
  capture?: TraceCapture;
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
   * Where a rule's threshold came from, installed by the engine on the one
   * path every evaluation takes: 'config' when the deployment's config file
   * or the caller's context set it, 'default' otherwise. Rules read it
   * through thresholdSourceOf() (src/eval/thresholds.ts) and NEVER by
   * comparing the value to the shipped number — a deployment that sets the
   * shipped number has set it.
   */
  thresholdSourceOf?: (key: string) => 'default' | 'config';
  /**
   * Who set a threshold, where `thresholdSourceOf` says only that somebody
   * did: `call` when this call's own configuration carried the key,
   * `config` when the deployment's config file did. Installed by the engine
   * beside `thresholdSourceOf`; read through thresholdSetBy().
   */
  thresholdSetBy?: (key: string) => 'call' | 'config' | undefined;

  /**

   * Whether this evaluation may call a paid provider. Set ONLY by the tools

   * whose whole purpose is to do so — the LLM judge and the citation

   * verifier. The engine refuses to run a judgment rule without it, which

   * is what makes "evaluate_output never spends" a property of the engine

   * rather than a promise in a tool description.

   */

  allowPaid?: boolean;

  /**
   * The relevance judge's answer for this evaluation, installed by the
   * engine (never by callers) before any rule runs, when the deployment
   * installed a relevance judge and the call carries an input. The rule
   * that reads it (answers_the_ask) stays synchronous: the network call is
   * the engine's, made once, on the one path every evaluation takes.
   */
  relevanceJudgment?: JudgeRecord;

  /**
   * The tenant this evaluation is for: the relevance judge charges its
   * daily budget to it. Set by the doors that know it; LOCAL_TENANT when
   * absent.
   */
  tenantId?: TenantId;

  /**
   * The request this evaluation belongs to, when a door scores many traces
   * in one (an OTLP batch, evaluate_runs): the relevance judge counts its
   * calls against IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST across all of
   * them. Absent, the evaluation is a request of its own.
   */
  judgeRequest?: JudgeRequest;
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
/**
 * What the composer DID with a result under this deployment's configuration.
 * gate: a policy the deployment configured (or a judgment it paid for) that
 * decides; veto: a critical detector; risk: a detection or inference whose
 * published accuracy enters the risk estimate; advisory: everything else —
 * measurements, a policy at a shipped default, a custom rule at medium or
 * low severity. Until 0.13.0 the stamp could only say veto or "term", and
 * the schema advertised four values nothing produced.
 */
export type Role = 'gate' | 'veto' | 'risk' | 'advisory';

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
  | { type: 'count'; stat: string; unit: string; value: number; threshold?: number; thresholdSource?: 'default' | 'config' | 'call' | 'rule'; /** On a cost stat: whether the trace reported the cost or Iris estimated it. */ costSource?: 'reported' | 'estimated' }
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
  /** `evaluated` of `of` rules answering the question ran; "judged" with 1 of 3 is a partial answer and says so in `why`. */
  questions: Array<{ id: QuestionId; status: 'judged' | 'unjudged' | 'not_applicable'; why?: string; evaluated?: number; of?: number }>;
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
 * These replaced `suggestions`, a flat `string[]` that said who the sentence
 * was for nowhere and what to change nowhere. It was deprecated in 0.13.0
 * and removed in 0.16.0, two minors later, per VERSIONING.md.
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

/**
 * One layer of the composer's decision, in the order it is asked
 * (`verdictPath` in eval/compose.ts). `by` is what that layer found: rule
 * names for the gate, veto and unknown layers, the missing inputs for the
 * evidence layer, and the failure classes over even odds for the risk
 * layer — the same vocabulary `Verdict.by` carries, because the verdict is
 * stamped from the node that decided.
 *
 * A path ends at the node that decided. A node with an empty `by` was asked
 * and found nothing. What the layers after the deciding one would have said
 * is on the verdict, as `Verdict.also`.
 */
export interface VerdictNode {
  node: 'nothing_judged' | 'gate' | 'veto' | 'unknown' | 'evidence' | 'risk';
  by: string[];
  /**
   * Whether this layer would decide the verdict on its own. The last node
   * of a path is the verdict's. An earlier node can be true as well: a
   * layer that could not check, on the way to the layer that failed.
   */
  decided: boolean;
  /** The risk estimate, on the risk node only, whether or not it decided; null when nothing carried a published rate. */
  risk?: Verdict['risk'];
}

/**
 * A layer after the one that decided, which would have decided on its own.
 *
 * `basis` names ONE layer (the first that fails, else the first that could
 * not check), and the layers do
 * not exclude each other: one output can break a policy the deployment set
 * and leak a credential. `state` is what that layer alone would have made
 * the verdict, and `by` carries what `Verdict.by` would have carried.
 */
export interface VerdictLayer {
  basis: 'detector_veto' | 'critical_unknown' | 'required_evidence_missing' | 'risk_over_loss';
  state: 'fail' | 'unknown';
  by: string[];
}

/** Placed on EvalResult by the engine; see Interpretation above. */
export interface Verdict {
  state: 'pass' | 'fail' | 'unknown';
  passed: boolean;
  /**
   * Which layer decided. `score_below_threshold` was removed in 0.12.0 with
   * the legacy composer that alone produced it: a value in this union that
   * nothing can emit is a filter option that returns nothing forever.
   */
  basis: 'policy_gate' | 'detector_veto' | 'critical_unknown' | 'required_evidence_missing' | 'risk_over_loss' | 'clean' | 'no_rules';
  by: string[];
  risk: { pBad: number; lo: number; hi: number; perClass: Partial<Record<FailureClass, number | null>>; assumptions: string[] } | null;
  confidence?: 'decisive' | 'marginal';
  /**
   * Every other layer that would have decided this verdict too, in the order
   * the composer asks them. Absent when the deciding layer was the only one,
   * and on every pass. A layer here can come before `basis` in that order:
   * a failure outranks a layer that could not check, so a verdict the risk
   * layer fails lists the evidence that was asked for and not sent here.
   *
   * Anything that acts on ONE basis reads `basis` and this, never `basis`
   * alone. `--fail-on detector_veto` and the `detector_veto` webhook once
   * read `basis` only, so a leaked credential in an output that also broke
   * a configured policy tripped neither.
   */
  also?: VerdictLayer[];
}

/** What produced this verdict, so it can be replayed or compared: the release, the ruleset, the configuration, the thresholds, the proof corpus, the time. */
export interface Provenance {
  irisVersion: string;
  rulesetHash: string;
  configHash: string;
  thresholds: { default: number; perRule?: Record<string, unknown> };
  corpusVersion: string;
  /**
   * The composer facts a read needs to re-derive the verdict and its
   * interpretations exactly as they were given: the shipped defaults are not
   * the deployment's, and a row read back under the wrong ones would report
   * a different verdict than the caller was handed. Absent on rows written
   * before 0.13.0, which then read back under the defaults and say so with
   * an empty interpretations list rather than a fabricated one.
   */
  composer?: {
    defaultsGate: boolean;
    falsePassCost: number;
    onCriticalSkipped: 'unknown' | 'fail' | 'pass';
    /**
     * The prior the risk estimate used and where it came from:
     * `config` when the deployment set eval.prior, `estimated` when the
     * deployment's own labels implied one, `default` otherwise. Flat, not
     * nested, so a stored row re-composes on read by spreading this object
     * over the defaults. Absent on rows written before 0.14.0, which read
     * back under the default prior and say so.
     */
    prior?: number;
    priorSource?: 'default' | 'config' | 'estimated';
    /**
     * How the prior was spread over the failure classes. Absent on rows
     * written before 0.19.0, which read back under the default reading —
     * wrong for a deployment that set eval.priorMode, and the reason it is
     * now stored.
     */
    priorMode?: 'per-output' | 'per-class';
    /**
     * The version of the calibration table the confidence label was read
     * from (src/eval/published-calibration.ts, `version`). A read re-derives
     * the label only under that same table; a row stamped under another
     * table, or before this field existed, reads back without a label and
     * with a note saying why, rather than silently taking today's.
     */
    calibration?: string;
    /**
     * The inputs the deployment requires (eval.requiredEvidence), when it
     * requires any. Stored because a read re-composes the verdict from
     * this object: without it a verdict that was `unknown` for missing
     * evidence read back as whatever the remaining layers said.
     */
    requiredEvidence?: Need[];
    /**
     * Which composer rules produced the verdict (compose.ts,
     * COMPOSER_RULES). A read re-composes under the same ones, so a change
     * to how the layers are ranked does not rewrite what a stored row says.
     * Absent on rows written before 0.20.0, which read back under rules 1.
     */
    rules?: number;
  };
  /** The evaluation this one re-scored, when it was produced by a re-evaluation of a stored row. The earlier row is kept: the change is the finding. */
  supersedes?: string;
  /**
   * Why this evaluation sits beside a trace rather than being its verdict
   * (eval/of-record.ts): the record fields the call passed that differed
   * (`output`, `input`, `tool_calls`, `tools`, `cost_usd`, `token_usage`),
   * `eval_type` for a narrowed bundle, `no_stored_output`, or the tool that
   * asked another question (`judge`, `citations`). Present exactly when the
   * evaluation carries `reference_trace_id`.
   */
  beside?: string[];
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
  /**
   * What the call carried and who recorded it (src/eval/evidence.ts). The
   * composer reads it: a deployment's required evidence is met by what the
   * call carried, and a field the capture source declared complete and the
   * trace left out makes the verdict not checked. Absent on rows written
   * before 0.20.0, which read back as they always did: required evidence
   * met by what an evaluated rule read, and no capture source.
   */
  evidence?: EvidenceRecord;
  /**
   * Arguments that asked for more than the operator allows and were held to
   * the operator's setting (src/tools/operator-ceilings.ts). Stored because
   * the operator reads the evaluation, not the agent's reply, and an agent
   * steered into asking need not pass the warning on: interpretations()
   * derives a sentence to the operator from each, on every read.
   */
  narrowed?: NarrowedArgument[];
  judgedAt: string;
}

/** One argument the operator's settings narrowed: the argument, the setting that applied, and what the caller was told. */
export interface NarrowedArgument {
  field: string;
  setting: string;
  message: string;
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
  origin?: 'built-in' | 'custom' | 'plugin';
  /** Which of the rule's declared needs the call actually carried — what the rule SAW. */
  saw?: Need[];
  /**
   * Present when the output was written as JSON and this rule read it as
   * text: `values` (what the fields say) or `labelled` (the same, with each
   * field's name). Its evidence offsets are into the output as sent.
   * Absent when the rule read the output as it was sent.
   */
  read?: 'values' | 'labelled';
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
  /**
   * What this rule says about the output, in one field: `pass`, `fail`, or
   * `not_checked` when it skipped. Read this, not `passed`: a rule that
   * skipped carries `passed: false` and `score: 0` (it did not pass), and a
   * script that filters on `passed === false` reads every skip as a
   * failure. Stamped by the engine; derived on read for a row stored before
   * it existed.
   */
  state?: RuleState;
  passed: boolean;
  score: number;
  message: string;
  skipped?: boolean;
  skipReason?: string;
  /** On a rule that skipped for missing evidence: the inputs it reads that the call did not carry. */
  lacked?: Need[];
  /**
   * On a rule that skipped for missing evidence, when somebody had asked
   * for it. `config`: the deployment set this rule's threshold, promoted it
   * to critical, deployed it as a gating rule of its own, or installed the
   * judge that answers it. `call`: the call itself set the threshold,
   * supplied the gating rule inline, or supplied the expectation the rule
   * compares against (an expected trajectory) and left out what to
   * compare. Such a rule was not "not applicable". It was asked and could
   * not answer, and the verdict is not a pass.
   */
  asked?: 'config' | 'call';
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

  /**
   * The LLM judge this result consulted, when the deployment configured one
   * for it: which model, what it scored against which pass line, what it
   * said, what it cost, and — when it could not answer — why. Present only
   * on answers_the_ask, and only when IRIS_RELEVANCE_JUDGE_MODEL (or an
   * embedder's setRelevanceJudge) installed a judge and the call carried
   * an input. A result that carries it without `error` was decided by the
   * judge; one with `error` fell back to the lexical reading.
   */
  judge?: JudgeRecord;
}

/**
 * One judge consultation, recorded on the rule result it decided (or tried
 * to). `score`, `passThreshold`, `passed` and `rationale` are present when
 * the judge answered; `error` when it did not. `costUsd` is 0 when nothing
 * was called (a misconfiguration, a cost-cap refusal) and null when a
 * provider call failed after it may have been billed.
 */
export interface JudgeRecord {
  template: 'relevance';
  provider: 'anthropic' | 'openai' | null;
  model: string;
  score?: number;
  passThreshold?: number;
  passed?: boolean;
  /** What the model said about passing. Recorded, never obeyed: the threshold decides. */
  selfReportedPass?: boolean;
  /** The model's boolean disagrees with the threshold's verdict. */
  disagreement?: boolean;
  rationale?: string;
  dimensions?: Record<string, number>;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** The model that produced the output, when the call recorded it (trace metadata or a span). */
  agentModel?: string;
  /** The judge shares a model family with that agent: its verdict stands, and is read as a same-family opinion. */
  sameFamily?: boolean;
  /**
   * What was replaced before the ask and the answer were sent, counted per
   * no_pii pattern (`{ "Email": 2 }`); absent when nothing was.
   */
  redacted?: Record<string, number>;
  /** The deployment turned redaction off (IRIS_RELEVANCE_JUDGE_REDACT=off), and this call sent the text as it was. */
  sentUnredacted?: boolean;
  /**
   * Why the judge was not asked although it could have been: the tenant's
   * daily budget could not cover the call's worst case, or this request had
   * already made its most judge calls. Nothing was spent; `error` says it in
   * a sentence.
   */
  withheld?: 'daily_budget' | 'request_cap';
  /** Why the judge gave no answer. */
  error?: string;
}

/** What one rule says about an output: it passed it, failed it, or did not check it. */
export type RuleState = 'pass' | 'fail' | 'not_checked';

/**
 * One bundle's row inside an eval_type="all" result.
 *
 * `state` is the evaluation's verdict, read for the rules this bundle holds
 * (compose.ts, bundleState): `fail` when a layer of the verdict rests on
 * one of them, `unknown` when the bundle evaluated no rule or the
 * evaluation lacked evidence somebody asked for, `pass` otherwise. The
 * composer is not run again over the bundle alone, so a row and the
 * verdict cannot disagree. `passed` is `state === 'pass'`. Until 0.20.0
 * a row carried the pre-0.10.0 arithmetic (weighted score against the
 * threshold, plus the critical veto), which the verdict stopped using in
 * 0.10.0: every row could read `passed: true` on an evaluation that
 * failed, and a script keyed on `categories.safety.passed` shipped it.
 *
 * `score` and `passed` are null when the bundle evaluated no rule (every
 * rule skipped for missing context — cost without cost_usd, relevance
 * without input). Such a bundle was not judged: `state` is `unknown`,
 * `insufficient_data` is true, and it never counted toward the overall
 * verdict (#406). The top-level EvalResult keeps a boolean `passed` on
 * purpose — a gate keyed on it must fail closed.
 */
export interface EvalCategoryResult {
  score: number | null;
  /** pass, fail, or unknown (not checked): the verdict, read for this bundle's rules. Absent on a result the composer has not read yet. */
  state?: 'pass' | 'fail' | 'unknown';
  passed: boolean | null;
  rules_evaluated: number;
  rules_skipped: number;
  insufficient_data: boolean;
  critical_failures?: string[];
  critical_skipped?: string[];
}

export interface EvalResult {
  id: string;
  /**
   * The trace this evaluation is a VERDICT on. Set only when the server
   * scored the trace as stored (at ingest, by evaluate_runs, by the
   * re-evaluate route, or by evaluate_output passing nothing that differs
   * from the record). Every reader of "a trace's verdict" takes the newest
   * evaluation carrying it.
   */
  trace_id?: string;
  /**
   * The trace this evaluation was made BESIDE, when it is not that trace's
   * verdict: the caller chose the text, the evidence or the bundle, or
   * another tool (the LLM judge, the citation verifier) judged a different
   * question. Listed with the trace's evaluations; never its verdict, so it
   * cannot replace one (migration 020). Never set together with `trace_id`.
   */
  reference_trace_id?: string;
  /**
   * The run this EVALUATION belongs to, when it differs from the run of the
   * trace it evaluated.
   *
   * Normally a run is a property of the execution and is read off the trace.
   * A re-evaluation breaks that: the same traces are scored again under new
   * rules, and those verdicts belong to a new run while the traces keep
   * pointing at the old one. Without this field the new verdicts would land
   * inside the original run and a comparison would be reading one run
   * against itself.
   */
  run_id?: string;
  eval_type: EvalResultType;
  output_text: string;
  expected_text?: string;
  score: number;
  passed: boolean;
  rule_results: EvalRuleResult[];
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
  /**
   * What a failure DOES, for a rule passed inline (2026-09-23):
   * high and critical gate like a deployed rule at that severity; low,
   * medium or absent advise. Before this an inline rule could never fail a
   * verdict, whatever it found.
   */
  severity?: 'low' | 'medium' | 'high' | 'critical';
}
