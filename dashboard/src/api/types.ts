export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ToolCallRecord {
  tool_name: string;
  input?: unknown;
  output?: unknown;
  latency_ms?: number;
  error?: string;
}

export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  kind: string;
  status_code: string;
  status_message?: string;
  start_time: string;
  end_time?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; timestamp: string; attributes?: Record<string, unknown> }>;
}

export interface Trace {
  trace_id: string;
  agent_name: string;
  framework?: string;
  input?: string;
  output?: string;
  tool_calls?: ToolCallRecord[];
  latency_ms?: number;
  token_usage?: TokenUsage;
  cost_usd?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
  created_at?: string;
  /** The conversation this turn belongs to; the trace page shows the session strip when set. */
  session_id?: string;
}

export interface EvalRuleResult {
  ruleName: string;
  passed: boolean;
  score: number;
  message: string;
  /**
   * The server sets `skipped` when a rule did not judge (no input for a
   * relevance rule, no cost for a cost rule, no trajectory for a trajectory
   * rule, an invalid custom config, a regex budget breach). A skipped rule
   * carries `passed: false, score: 0` as placeholders — it is NOT a failure
   * and must never render as one. Mirrors `EvalRuleResult` in
   * src/types/eval.ts.
   */
  skipped?: boolean;
  skipReason?: string;
  ruleId?: string;
  category?: string;
  critical?: boolean;
  criticalSource?: 'default' | 'config';
  configInvalid?: boolean;
  budgetExceeded?: boolean;
  /**
   * The stamp (server 0.9.0): what kind of claim this result makes, what the
   * composer did with it, which question it answers, what it saw, why it
   * skipped, and how wrong it tends to be. Absent on rows written before that
   * release; never fabricated.
   */
  kind?: 'measurement' | 'detection' | 'inference' | 'judgment' | 'policy' | 'verification';
  role?: 'gate' | 'veto' | 'risk' | 'advisory';
  /** Built-in or deployed by a user. */
  origin?: 'built-in' | 'custom';
  /** What the rule saw: offsets into the caller's text, a pattern count, a tool call, a citation, a measured count. */
  evidence?: Evidence[];
  /** A measurement's number, with its unit. */
  value?: MeasuredValue;
  question?: string;
  classes?: string[];
  ruleVersion?: number;
  saw?: string[];
  skipClass?: 'not_applicable' | 'defeated' | 'config_invalid';
  uncertainty?: Uncertainty;
  evidenceIncomplete?: boolean;
}

/**
 * Per-bundle verdict inside an `eval_type: "all"` response. `score` and
 * `passed` are null when that bundle evaluated no rule (every rule skipped
 * for missing context): it was not judged, so a renderer shows it as
 * "not evaluated" — never as failing, never red (#406).
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

/* ── The verdict's own vocabulary, mirrored from the server's src/types/eval.ts. ── */

export type VerdictBasis =
  | 'policy_gate'
  | 'detector_veto'
  | 'critical_unknown'
  | 'required_evidence_missing'
  | 'risk_over_loss'
  | 'clean'
  | 'no_rules';

export interface Verdict {
  state: 'pass' | 'fail' | 'unknown';
  passed: boolean;
  /** Which layer of the composer decided. */
  basis: VerdictBasis;
  /** The rules (or failure classes, under risk_over_loss) that decided. */
  by: string[];
  risk: { pBad: number; lo: number; hi: number; perClass: Record<string, number | null>; assumptions: string[] } | null;
  confidence?: 'decisive' | 'marginal';
}

export type QuestionId = 'safe_output' | 'grounded' | 'complete' | 'relevant' | 'task_completed' | 'tool_use_correct' | 'within_budget';

export interface CoverageQuestion {
  id: QuestionId;
  status: 'judged' | 'unjudged' | 'not_applicable';
  /** What was missing when a question was not judged. */
  why?: string;
  /** How many of the question's rules ran, of how many. */
  evaluated?: number;
  of?: number;
}

export interface Coverage {
  inputs: Record<string, boolean>;
  questions: CoverageQuestion[];
  dormant?: Array<{ ruleId: string; name: string; reason: string }>;
}

export interface Interpretation {
  severity: 'block' | 'warn' | 'note';
  addressee: 'agent' | 'operator' | 'author';
  rule?: string;
  text: string;
  /** The setting that would change the outcome. */
  configKey?: string;
}

export interface Provenance {
  irisVersion: string;
  rulesetHash: string;
  configHash: string;
  thresholds: { default: number; perRule?: Record<string, unknown> };
  corpusVersion: string;
  composer?: {
    defaultsGate: boolean;
    falsePassCost: number;
    onCriticalSkipped: 'unknown' | 'fail' | 'pass';
    /** The prior the risk estimate used and where it came from (0.14.0): your eval.prior, the one your labels implied, or the default. */
    prior?: number;
    priorSource?: 'default' | 'config' | 'estimated';
    /** How the prior was spread over the failure classes (0.19.0). */
    priorMode?: 'per-output' | 'per-class';
    /** The calibration table the confidence label was read from, by composite version (0.19.0). */
    calibration?: string;
  };
  /** The evaluation this one re-scored (0.14.0); the earlier row is kept. */
  supersedes?: string;
  [key: string]: unknown;
}

/* ── Labels on your own traffic ── */

export type VerdictLabelValue = 'right' | 'wrong';

/** One label: your judgement that a rule's FIRE on one evaluation was right or wrong. Labels measure precision only. */
export interface VerdictLabel {
  id: string;
  evalId: string;
  ruleName: string | null;
  label: VerdictLabelValue;
  note: string | null;
  labelledAt: string;
}

export interface LabelStatsRow {
  rule: string;
  kind: string | null;
  /** Whether this rule's fires enter the risk estimate, so its labels can move a verdict. */
  entersRisk: boolean;
  n: number;
  right: number;
  wrong: number;
  precision: Interval | null;
  /** True at `min` labels: the rule's number on this deployment is its own. */
  local: boolean;
  publishedPrecision: number | null;
  fireRate: number | null;
}

export interface EstimatedPrior {
  pi: number;
  lo: number;
  hi: number;
  ruleName: string;
  fireRate: number;
  sensitivity: number;
}

export interface SamplingSuggestion {
  ruleName: string;
  n: number;
  halfwidthPoints: number;
  fireRate: number;
  sentence: string;
}

/** GET /api/v1/labels/stats */
export interface LabelStats {
  rules: LabelStatsRow[];
  /** Labels on a rule's fires before its local precision replaces the published number. */
  min: number;
  /** How many recent evaluations the fire rate and the issues are read over. */
  window: number;
  estimatedPrior: EstimatedPrior | null;
  suggestion: SamplingSuggestion | null;
  refreshedAt: string;
}

/** POST /api/v1/labels */
export interface LabelResponse {
  label: VerdictLabel;
  rule: LabelStatsRow | null;
  /** Labels before a rule's local precision is in force. */
  min: number;
  estimatedPrior: EstimatedPrior | null;
  suggestion: SamplingSuggestion | null;
}

/** GET /api/v1/issues: fires grouped by (rule, evidence signature). */
export interface IssueGroup {
  key: string;
  ruleName: string;
  signature: string;
  count: number;
  agents: string[];
  firstSeen: string;
  lastSeen: string;
  exampleEvalIds: string[];
  /** The traces those evaluations scored, in the same order; null for an evaluation made from bare text. */
  exampleTraceIds: Array<string | null>;
  labelled: { right: number; wrong: number };
}

export interface IssuesResponse {
  issues: IssueGroup[];
  window: number;
}

/** POST /api/v1/evaluations/:id/reevaluate */
export interface ReevaluateResponse {
  evaluation: EvalResult;
  supersedes: string;
  before: { verdict: string | null; passed: boolean };
  after: { verdict: string | null; passed: boolean };
  changed: boolean;
}

export type Evidence =
  | { type: 'span'; source: string; start: number; end: number; label: string }
  | { type: 'pattern'; name: string; count: number }
  | { type: 'toolCall'; index: number; toolName: string; label: string }
  | { type: 'citation'; url: string; status: string }
  | { type: 'count'; stat: string; unit: string; value: number; threshold?: number; thresholdSource?: 'default' | 'config' | 'call' | 'rule' }
  | { type: string; [key: string]: unknown };

export interface MeasuredValue {
  stat: string;
  unit: string;
  value: number;
}

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

/**
 * The error bar a rule result carries (mirrors `src/types/eval.ts`). A fired
 * detection reports its PPV at the prior in force; a quiet one its miss rate;
 * a rule that is right by definition its conformance count; a policy has none.
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

/** GET /api/v1/capabilities → `rules[].proof`: a rule's published accuracy row, or null when it has no family. */
export interface RuleProofSummary {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  n: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ci95: {
    precision: readonly [number, number] | null;
    recall: readonly [number, number] | null;
    f1: readonly [number, number] | null;
  };
  ppvAt: Record<string, number | null>;
  corpusVersion: string;
  release: string;
  labelling: 'same-model' | 'human-verified';
}

export interface EvalResult {
  id: string;
  trace_id?: string;
  run_id?: string;
  eval_type: string;
  output_text: string;
  expected_text?: string;
  score: number;
  passed: boolean;
  /** The composed verdict (0.10.0+); absent on rows older than that. */
  verdict?: Verdict;
  rule_results: EvalRuleResult[];
  rules_evaluated?: number;
  rules_skipped?: number;
  insufficient_data?: boolean;
  /** Which inputs were present and which questions were judged, with counts. */
  coverage?: Coverage;
  /** Why a rule that fired did not decide, and what was not judged. */
  interpretations?: Interpretation[];
  provenance?: Provenance;
  /** Critical rules that could not judge — unknown, not clean. */
  critical_skipped?: string[];
  /** Set when the text of this evaluation was erased by retention or a delete. */
  erased_at?: string;
  /**
   * Rules that HARD-FAILED this evaluation — a critical safety rule
   * (no_pii / no_injection_patterns / no_blocklist_words) or a deployed rule
   * with severity high/critical. When present, `passed` is false because of
   * these regardless of `score`. Absent means nothing vetoed, or the row
   * predates migration 006.
   */
  critical_failures?: string[];
  /**
   * Per-bundle breakdown, present only on an `eval_type: "all"` evaluation
   * as the tool and the ingest route return it (response-only today —
   * stored rows carry `category` per rule instead, and the API does not
   * serve this map yet). A null `passed` means "not evaluated".
   */
  categories?: Partial<Record<'completeness' | 'relevance' | 'safety' | 'cost' | 'custom', EvalCategoryResult>>;
  created_at?: string;
}

export interface TraceQueryResult {
  traces: Trace[];
  total: number;
  limit: number;
  offset: number;
}

export interface TraceDetail {
  trace: Trace;
  spans: Span[];
  evals: EvalResult[];
}

export interface DashboardSummary {
  total_traces: number;
  avg_latency_ms: number;
  total_cost_usd: number;
  error_rate: number;
  eval_pass_rate: number;
  traces_per_hour: Array<{ hour: string; count: number }>;
  top_agents: Array<{ agent_name: string; count: number }>;
}

export interface FilterOptions {
  agent_names: string[];
  frameworks: string[];
}

export interface EvalQueryResult {
  results: EvalResult[];
  total: number;
}

/* ── Eval Stats (eval-first dashboard) ── */

export interface EvalStats {
  passRate: number;
  avgScore: number;
  totalEvals: number;
  safetyViolations: { pii: number; injection: number; hallucination: number };
  totalCost: number;
  agentCount: number;
  period: string;
}

export interface EvalTrendPoint {
  timestamp: string;
  avgScore: number;
  passRate: number;
  evalCount: number;
  /** The run this bucket belongs to when the trend was asked for split by run; null for evaluations with no run. */
  cohort?: string | null;
}

export interface RuleBreakdown {
  rule: string;
  passRate: number;
  totalRun: number;
  failCount: number;
}

export interface EvalFailure {
  traceId: string;
  agent: string;
  rule: string;
  score: number;
  output: string;
  timestamp: string;
}

/* ── Decision Moments (B1 — the new primary unit) ── */

export type MomentVerdict = 'pass' | 'fail' | 'partial' | 'unevaluated';

export type MomentSignificanceKind =
  | 'safety-violation'
  | 'cost-spike'
  /** The agent's own stream shifted: a rule's fail rate crossed its CUSUM line at this evaluation (0.14.0). */
  | 'regression-alarm'
  | 'first-failure'
  | 'novel-pattern'
  | 'rule-collision'
  | 'normal-pass'
  | 'normal-fail'
  /** Nothing was judged: no evaluation, every rule skipped, or an unknown verdict. Not a pass. */
  | 'unevaluated';

export interface MomentSignificance {
  kind: MomentSignificanceKind;
  score: number;
  label: string;
  reason: string;
}

export interface MomentRuleSnapshot {
  failed: string[];
  skipped: string[];
  passedCount: number;
  totalCount: number;
}

export interface DecisionMoment {
  id: string;
  traceId: string;
  agentName: string;
  timestamp: string;
  input?: string;
  output?: string;
  /** Serialized as explicit null when the trace reported no cost — guard with != null, not !== undefined. */
  costUsd?: number | null;
  latencyMs?: number | null;
  verdict: MomentVerdict;
  overallScore: number;
  evalCount: number;
  ruleSnapshot: MomentRuleSnapshot;
  significance: MomentSignificance;
}

export interface DecisionMomentDetail extends DecisionMoment {
  evals: Array<{
    id: string;
    evalType: string;
    score: number;
    passed: boolean;
    /** Whole rule results, the same object the tool returns. */
    ruleResults: EvalRuleResult[];
    verdict?: Verdict;
    coverage?: Coverage;
    interpretations?: Interpretation[];
    provenance?: Provenance;
    criticalSkipped?: string[];
    /** See EvalResult.critical_failures — the rules that vetoed this eval. */
    criticalFailures?: string[];
    createdAt?: string;
  }>;
  toolCalls?: ToolCallRecord[];
  spans?: Span[];
}

export interface MomentQueryResult {
  moments: DecisionMoment[];
  /** Exact. Unfiltered by time: matching traces. Ranked, or with a verdict or significance filter: moments in the window after filters. */
  total: number;
  limit: number;
  offset: number;
  /** Present when the server ranked by significance (sort_by=significance). */
  sortBy?: 'significance';
  /** How far a ranking or a filtered read reached. Present whenever the server read a window. */
  window?: {
    size: number;
    scanned: number;
    tracesInRange: number;
    newest?: string;
    oldest?: string;
  };
}

/* ── Ranked failures (failure-first landing view) ── */

export interface RankedFailure extends DecisionMoment {
  /** Severity × recency-decay blend, 0-1. Higher = shown first. */
  rankScore: number;
}

export interface FailureQueryResult {
  failures: RankedFailure[];
  /** How many recent traces the server scanned to build the list. */
  scanned: number;
  /** Total traces matching the filter (pre-scan-cap). */
  total: number;
  limit: number;
}

/* ── Custom Rules (B3 — Make-This-A-Rule) ── */

export type RuleSeverity = 'low' | 'medium' | 'high' | 'critical';

export type CustomRuleType =
  | 'regex_match'
  | 'regex_no_match'
  | 'min_length'
  | 'max_length'
  | 'contains_keywords'
  | 'excludes_keywords'
  | 'json_schema'
  | 'cost_threshold';

export interface CustomRuleDefinition {
  name: string;
  type: CustomRuleType;
  config: Record<string, unknown>;
  weight?: number;
}

export interface DeployedCustomRule {
  id: string;
  name: string;
  description: string;
  evalType: 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom';
  severity: RuleSeverity;
  definition: CustomRuleDefinition;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  sourceMomentId?: string;
  version: number;
}

export interface DeployRuleRequest {
  name: string;
  description?: string;
  evalType: DeployedCustomRule['evalType'];
  severity?: RuleSeverity;
  definition: CustomRuleDefinition;
  sourceMomentId?: string;
}

export interface RulePreviewRequest {
  definition: CustomRuleDefinition;
  evalType?: DeployedCustomRule['evalType'];
  windowDays?: number;
  maxTraces?: number;
  /** Dry-run text: when present the rule is also judged against exactly this output (`sample` in the result). */
  sampleOutput?: string;
}

export interface RulePreviewResult {
  tracesEvaluated: number;
  wouldFail: number;
  wouldPass: number;
  wouldSkip: number;
  examples: Array<{
    traceId: string;
    agentName: string;
    timestamp: string;
    outputPreview: string;
  }>;
  windowSinceIso: string;
  /** Verdict against `sampleOutput`; absent when no sample was sent. */
  sample?: {
    passed: boolean;
    score: number;
    message: string;
    skipped: boolean;
    skipReason?: string;
  };
}

/**
 * A built-in rule as the engine registers it — served by
 * GET /api/v1/rules/builtin so the dashboard never has to restate the
 * name → category map by hand.
 */
export interface BuiltInRuleMeta {
  name: string;
  category: DeployedCustomRule['evalType'];
  description: string;
  weight: number;
  /** Declared from 0.9.0: the kind of claim, how it is measured, what it reads, the question it answers, the failure classes, the definition version. */
  kind?: 'measurement' | 'detection' | 'inference' | 'judgment' | 'policy' | 'verification';
  mechanism?: 'formula' | 'pattern' | 'heuristic' | 'model' | 'external';
  needs?: string[];
  question?: string;
  classes?: string[];
  version?: number;
  /**
   * A failing critical rule forces passed=false regardless of the weighted
   * score. This is the EFFECTIVE value — what this server will apply after
   * eval.criticalRules / eval.nonCriticalRules — not the rule's declaration.
   */
  critical: boolean;
  /**
   * Who decided it: 'default' is the rule's own declaration, 'config' means
   * this deployment promoted or demoted it. Rendering `critical` without
   * this would show a promotion as though it shipped that way.
   */
  criticalSource: 'default' | 'config';
}

/* ── Preferences (B8.2 — server-mediated user preferences) ── */

export interface MomentFiltersPref {
  agentName?: string;
  verdict?: 'pass' | 'fail' | 'partial' | 'unevaluated';
  significanceKind?: MomentSignificanceKind;
}

export interface Preferences {
  autoLaunch: boolean;
  firstSeen?: string;
  dismissedBanners: string[];
  theme: 'dark' | 'light' | 'system';
  momentFilters: MomentFiltersPref;
  dismissedTours: string[];
  archivedMoments: string[];
  density: 'compact' | 'comfortable';
  sidebarCollapsed: boolean;
  notificationsLastSeen?: string;
}

export interface PreferencesEnvelope {
  preferences: Preferences;
  /**
   * Where the preferences file lives, spelled without the OS username:
   * `~/.iris/preferences.json`, `$IRIS_HOME/demo-preferences.json`, … The
   * server never sends the absolute path (install-path disclosure).
   */
  displayPath?: string;
}

export type PreferencesPatch = Partial<Preferences>;

/* ── Audit log (B8.4) ── */

export type AuditAction = 'rule.deploy' | 'rule.delete' | 'rule.toggle' | 'rule.update' | 'trace.delete';

export interface AuditLogEntry {
  ts: string;
  /**
   * Which tenant the action belongs to. OSS installs always emit 'local'.
   * Cloud installs emit the tenant resolved from the authenticated session.
   *
   * Optional for backward compatibility: entries written before v0.4.0
   * don't have this field. Readers MUST treat missing tenantId as 'local'
   * so old audit logs remain queryable on upgrade.
   */
  tenantId?: string;
  action: AuditAction;
  user: string;
  /** The rule a rule.* entry is about; absent on trace.delete. */
  ruleId?: string;
  /** The trace a trace.delete entry is about. */
  traceId?: string;
  ruleName?: string;
  details?: Record<string, unknown>;
}

export interface AuditQueryResult {
  entries: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}


/**
 * The drift comparison as the server computes it.
 *
 * Every number here is served rather than derived in the browser, and that
 * is the point: the interval comes from the same newcombeDifference the
 * proof harness and compare_runs use, so the picture and the measurement
 * cannot disagree. A second implementation in the SPA would be a second
 * definition of "significant".
 */
export interface DriftComparison {
  period: string;
  run: string | null;
  current: DriftWindowSummary;
  prior: DriftWindowSummary;
  /** Null when either window is below the minimum — no direction is offered. */
  difference: { delta: number; lo: number; hi: number; significant: boolean } | null;
  enoughEvidence: boolean;
  minimumPerWindow: number;
  /** When the interval cannot exclude zero: the smallest change this much data could have seen. */
  smallestDetectable: number | null;
}

export interface DriftWindowSummary {
  since: string;
  until: string | null;
  evaluated: number;
  passed: number;
  /** Null for an empty window — "0 of 0" is unknown, not zero. */
  passRate: number | null;
  /** The 95% Wilson interval on this window's pass rate; null for an empty window. */
  interval: { lo: number; hi: number } | null;
}

/* ---------------------------------------------------------------------------
 * The shell's two reads
 * ------------------------------------------------------------------------- */

/**
 * GET /api/v1/health — unauthenticated by design (it carries no data).
 * The server answers 503 with `status: 'degraded'` when its storage is down;
 * that body is still the answer, and the client returns it as one.
 */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptime_seconds: number;
  /** The SQLite driver behind the store (0.15.0). */
  driver?: string | null;
  /** What was checked and how it went (0.15.0). */
  checks?: {
    storage: 'ok' | 'fail' | 'absent';
    rules_store: 'ok' | 'fail' | 'absent';
    migrations: { status: 'ok' | 'fail' | 'absent'; applied: number; known: number };
  };
  storage?: 'connected' | 'disconnected';
  judge: { enabled: boolean; provider?: string | null };
  mode?: 'real' | 'demo';
}

/**
 * GET /api/v1/capabilities — the fields the shell renders. The document is
 * the server's and larger than this; unknown fields pass through untouched.
 */
export interface CapabilitiesSummary {
  version?: string;
  /** The built-in roster with each rule's published accuracy (the rule rows read `proof`). */
  rules?: Array<{ name: string; proof: RuleProofSummary | null }>;
  /** The questions the server asks, with their text (the verdict panel renders coverage by question). */
  questions?: ReadonlyArray<{ id: string; text: string; answeredBy?: string }>;
  judge?: { enabled: boolean; provider?: string | null; howToEnable?: readonly string[] };
  retention?: { days: number; sweepIntervalHours: number };
  dashboard?: { enabled: boolean; url: string | null; mode: 'real' | 'demo' };
}

/* ---------------------------------------------------------------------------
 * Runs, cases and the comparison
 * ------------------------------------------------------------------------- */

/** GET /api/v1/runs → runs[] (mirrors RunSummaryRow in src/storage/sqlite-adapter.ts). */
export interface RunSummaryRow {
  runId: string;
  label: string | null;
  reevaluationOf: string | null;
  traces: number;
  evaluated: number;
  passed: number;
  agentNames: string[];
  engineVersions: string[];
  rulesetHashes: string[];
  startedAt: string | null;
  lastActivityAt: string | null;
  /** Pinned as the baseline every later run is compared against; at most one per tenant. */
  baseline: boolean;
}

/** GET /api/v1/runs/:id → results[]: one evaluation per trace, the most recent. */
export interface RunResultRow {
  evalId: string;
  traceId: string | null;
  caseKey: string | null;
  agentName: string | null;
  passed: boolean;
  failedRules: string[];
  engineVersion: string | null;
  rulesetHash: string | null;
  configHash: string | null;
  createdAt: string;
  supersededInRun?: number;
}

/** GET /api/v1/cases/:key → results[]: every attempt, not collapsed. */
export interface CaseResultRow {
  evalId: string;
  traceId: string | null;
  caseKey: string | null;
  runId: string | null;
  passed: boolean;
  createdAt: string;
}

export interface RunsResponse {
  runs: RunSummaryRow[];
  count: number;
}

export interface RunDetailResponse {
  run: RunSummaryRow;
  results: RunResultRow[];
}

export interface CaseResponse {
  caseKey: string;
  attempts: number;
  passed: number;
  flaky: boolean;
  runs: string[];
  results: CaseResultRow[];
}

/** POST /api/v1/compare body — the compare_runs tool's input. */
export interface CompareRunsRequest {
  /** Omitted: the run pinned as the baseline. */
  before?: string;
  after: string;
  force?: boolean;
  /** δ for the equivalence test, as a difference in pass rate in (0, 1]; absent, the smallest detectable difference. */
  equivalence_margin?: number;
}

export interface CompareRunSummary {
  run_id: string;
  n: number;
  passed: number;
  rate: number | null;
  interval: { lo: number; hi: number } | null;
  agent_names: string[];
  engine_versions: string[];
  ruleset_hashes: string[];
  config_hashes: string[];
  superseded: number;
}

export interface CompareRuleDelta {
  rule: string;
  failed_before: number;
  failed_after: number;
  delta: number;
  /** After minus before on this rule's own pass rate, 95% Newcombe; null when a side is empty. */
  difference: { delta: number; lo: number; hi: number; significant: boolean } | null;
  /** The one-sided test behind p. */
  test: 'mcnemar-exact' | 'newcombe-z' | null;
  /** One-sided, in the regression direction. */
  p: number | null;
  /** Benjamini–Hochberg over every rule tested in the comparison. */
  q: number | null;
  /** True only at q ≤ 0.05 in the regression direction. */
  worse: boolean;
}

/** The third answer a comparison can give: equivalent within a margin (two one-sided tests at α = 0.05, the 90% interval). */
export interface CompareEquivalence {
  margin: number;
  margin_source: 'caller' | 'smallest-detectable';
  interval: { lo: number; hi: number };
  holds: boolean;
}

/** POST /api/v1/compare response — the compare_runs tool's output, unchanged. */
export interface CompareRunsResult {
  comparable: boolean;
  incomparable_because: string[];
  forced: boolean;
  method: 'paired-mcnemar' | 'unpaired-newcombe' | 'none';
  before: CompareRunSummary;
  after: CompareRunSummary;
  difference: { delta: number; lo: number; hi: number; significant: boolean } | null;
  paired: { method: 'mcnemar-exact'; b: number; c: number; concordant: number; pairs: number; p_value: number; significant: boolean } | null;
  worse: boolean;
  better: boolean;
  smallest_detectable: number | null;
  equivalent_within: CompareEquivalence | null;
  rules_tested: number;
  regressions: CompareRuleDelta[];
  improvements: CompareRuleDelta[];
  /** The paired cases that disagreed, regressions first; absent from an older server. */
  discordant?: CompareDiscordantCase[];
  discordant_total?: number;
  summary: string;
}

/** One case whose verdict flipped between the two runs, with the rules that flipped and the ids to open the moment. */
export interface CompareDiscordantCase {
  case_key: string;
  before: { eval_id: string; trace_id: string | null; passed: boolean };
  after: { eval_id: string; trace_id: string | null; passed: boolean };
  direction: 'regressed' | 'recovered';
  rules: Array<{ rule: string; before: boolean; after: boolean }>;
}
