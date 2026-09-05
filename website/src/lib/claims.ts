// Truthbase reader for the website surface.
//
// Source of truth: iris/.claims.json (regenerated from canonical artifacts
// via `npm run claims:generate`). Always import from here on the website
// side; never hardcode the values inline.
//
// When server- or dashboard-side surfaces need their own reader, add the
// reader file in the same PR as the consumer and mirror this surface
// field-for-field (including the necessary build-context updates — see
// scripts/claims/README.md).

import claimsRaw from '../../../.claims.json' with { type: 'json' };

export const CLAIMS = claimsRaw;

// Versions
export const VERSION_MCP_SERVER = claimsRaw.version.mcpServer as string;
export const VERSION_LANGCHAIN_PACKAGE = claimsRaw.version.langchainPackage as string | null;
export const VERSION_WEBSITE_PACKAGE = claimsRaw.version.websitePackage as string | null;
export const VERSION_DASHBOARD_PACKAGE = claimsRaw.version.dashboardPackage as string | null;
// Registry status — a false entry is an in-repo package that no surface may
// present as installable (see scripts/claims/generators/version.mjs).
export const PACKAGE_PUBLISHED = claimsRaw.version.published as {
  mcpServer: boolean;
  initPackage: boolean;
  langchainPackage: boolean;
};

// Tests
export const TEST_COUNT_VITEST_ROOT = claimsRaw.tests.vitestRoot.total as number | null;
export const TEST_COUNT_VITEST_DASHBOARD = claimsRaw.tests.vitestDashboard.total as number | null;
export const TEST_COUNT_INTEGRATION = claimsRaw.tests.integration.total as number | null;
export const TEST_COUNT_PLAYWRIGHT_E2E = claimsRaw.tests.playwrightE2E.total as number | null;
export const TEST_COUNT_TOTAL = claimsRaw.tests.totalCombined as number | null;

// MCP tools
export const MCP_TOOL_COUNT = claimsRaw.mcpTools.count as number;
export const MCP_TOOL_NAMES = claimsRaw.mcpTools.names as readonly string[];

// Eval rules
export const RULE_COUNT_BUILT_IN = claimsRaw.evalRules.builtInCount as number;
export const RULE_CATEGORIES = claimsRaw.evalRules.categories as readonly string[];
export const RULE_CATEGORY_COUNT = claimsRaw.evalRules.categoryCount as number;
export const RULE_NAMES = claimsRaw.evalRules.names as readonly string[];
export const PII_PATTERN_COUNT = claimsRaw.evalRules.piiPatterns as number | null;
export const INJECTION_PATTERN_COUNT = claimsRaw.evalRules.injectionPatterns as number | null;
export const HALLUCINATION_MARKER_COUNT = claimsRaw.evalRules.hallucinationMarkers as number | null;
export const CUSTOM_RULE_TYPE_COUNT = claimsRaw.evalRules.customRuleTypeCount as number;
export const CUSTOM_RULE_TYPES = claimsRaw.evalRules.customRuleTypes as readonly string[];
export interface RuleRosterEntry {
  name: string;
  kind: 'measurement' | 'detection' | 'inference' | 'judgment' | 'policy' | 'verification';
  mechanism: 'formula' | 'pattern' | 'heuristic' | 'model' | 'external';
  needs: string[];
  question: string;
  classes: string[];
  version: number;
}
export interface EvaluationQuestion {
  id: string;
  text: string;
  answeredBy: 'rule' | 'tool' | 'surface';
}
export const RULE_ROSTER = claimsRaw.evalRules.roster as readonly RuleRosterEntry[];
export const EVALUATION_QUESTIONS = claimsRaw.evalRules.questions as readonly EvaluationQuestion[];

// LLM-judge templates
export const LLM_JUDGE_TEMPLATE_COUNT = claimsRaw.llmJudgeTemplates.count as number;
export const LLM_JUDGE_TEMPLATE_NAMES = claimsRaw.llmJudgeTemplates.names as readonly string[];

// Brand
export const TAGLINE = claimsRaw.brand.tagline as string;
export const CATEGORY_NAME = claimsRaw.brand.categoryName as string;
export const COINED_TERMS = claimsRaw.brand.coinedTerms as readonly string[];
export const WEBSITE_URL = claimsRaw.brand.websiteUrl as string;
export const PUBLIC_REPO_URL = claimsRaw.brand.publicRepoUrl as string;
export const NPM_PACKAGE = claimsRaw.brand.npmPackage as string;
export const SUPPORT_EMAIL = claimsRaw.brand.supportEmail as string;
export const SECURITY_EMAIL = claimsRaw.brand.securityEmail as string;

// Security defaults (src/config/defaults.ts). The security page published a
// dashboard-API rate limit six times lower than the shipped default for a
// full release — wrong on the one page a reader consults BECAUSE they don't
// trust prose. There was no `security` key in the truthbase at all.
export const RATE_LIMIT_API = claimsRaw.security.rateLimit.api as number;
export const RATE_LIMIT_MCP = claimsRaw.security.rateLimit.mcp as number;
export const DEFAULT_BIND_HOST_TRANSPORT = claimsRaw.security.defaultBindHost.transport as string;
export const DEFAULT_BIND_HOST_DASHBOARD = claimsRaw.security.defaultBindHost.dashboard as string;

// Shipped limits — configuration defaults read from the line of source that
// enforces each one (generators/security.mjs). Not measurements; the page
// that renders them says so.
export const REQUEST_SIZE_LIMIT = claimsRaw.security.limits.requestSizeLimit as string;
export const REGEX_MATCH_BUDGET_MS = claimsRaw.security.limits.regexMatchBudgetMs as number;
export const REGEX_BREACHES_PER_EVALUATION = claimsRaw.security.limits.regexBreachesPerEvaluation as number;
export const CUSTOM_REGEX_MAX_LENGTH = claimsRaw.security.limits.customRegexMaxLength as number;

// Disclosure SLA — parsed out of SECURITY.md (generators/security-policy.mjs).
// The website used to promise 2 business days / 7 days while the policy
// file promised 48 hours / 5 business days. One policy, one set of numbers.
export const DISCLOSURE_ACK_HOURS = claimsRaw.security.disclosure.acknowledgeWithinHours as number;
export const DISCLOSURE_RESPONSE_BUSINESS_DAYS = claimsRaw.security.disclosure
  .detailedResponseWithinBusinessDays as number;
export const DISCLOSURE_WINDOW_DAYS = claimsRaw.security.disclosure.publicDisclosureWindowDays as number;

// Maintenance — the one MEASURED block on the security page: issue-close
// latency sampled from the public GitHub API (generators/issues.mjs).
// `source` is "live" when the numbers came from the API at `sampledAt`, and
// "cached" when a refresh was attempted, the API was unreachable, and the
// previous sample was kept. The page renders the date either way.
export interface MaintenanceClaims {
  repo: string;
  windowDays: number;
  sampledAt: string;
  source: 'live' | 'cached';
  issues: {
    closedInWindow: number;
    closedAsCompleted: number;
    closedAsNotPlanned: number;
    medianHoursToClose: number | null;
    p75HoursToClose: number | null;
    openNow: number;
  };
  method: string;
}
export const MAINTENANCE = claimsRaw.maintenance as MaintenanceClaims;

// Proof — per-rule evaluator accuracy. Written by scripts/claims/generators/
// proof.mjs from proof/results.json; ABSENT until that generator lands, and
// the /proof page must render an honest in-progress state rather than a
// placeholder number when it is.
export interface ProofInterval {
  precision: [number, number];
  recall: [number, number];
  f1: [number, number];
}
export interface ProofRule {
  name: string;
  category: string;
  n: number;
  positives: number;
  negatives: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  ci95: ProofInterval;
  /** Dirichlet credible intervals (schemaVersion 2); do not collapse at zero errors. */
  credible95?: { precision: [number, number] | null; recall: [number, number] | null; f1: [number, number] | null };
  /** What a fire is worth at prevalences 0.01, 0.05, 0.2, 0.5 (schemaVersion 2). */
  ppvAt?: Record<string, number | null>;
}
export interface ProofRate {
  k: number;
  n: number;
  rate: number | null;
  ci95: [number, number] | null;
}
export interface ProofComposerSlice {
  accuracy: ProofRate;
  falseBlock: ProofRate;
  missedBlock: ProofRate;
  calibration: { n: number; brier: number; ece: number } | null;
}
export interface ProofComposerSlices {
  test: ProofComposerSlice;
  dev: ProofComposerSlice;
  realTranscripts: ProofComposerSlice;
}
export type ProofDifference = { delta: number; lo: number; hi: number } | null;
export interface ProofComposite {
  schemaVersion: number;
  compositeVersion: string;
  corpusVersion: string;
  version: string;
  method: { priorMode: string; tau: number; falsePassCost: number; prior: number; [key: string]: unknown };
  counts: { cases: number; dev: number; test: number; realTranscripts: number; composed: number; clean: number; mustNotShip: number; unlabelled: number };
  legacy: ProofComposerSlices;
  risk: ProofComposerSlices;
  riskPerClass: ProofComposerSlices;
  difference: { risk: { test: ProofDifference; realTranscripts: ProofDifference }; riskPerClass: { test: ProofDifference; realTranscripts: ProofDifference }; reads: string };
  perClass: Array<{ class: string; present: number; caught: number; recall: number | null; ci95: [number, number] | null }>;
  sweep: { split: string; variant: string; argmaxUtility: number; shippedTau: number; note: string };
}
export interface ProofTransforms {
  method: string;
  transforms: Array<{ id: string; describe: string }>;
  rules: Array<{ rule: string; positives: number; firedOriginally: number; withSpan: number }>;
  rows: Array<{ rule: string; transform: string; n: number; caught: number; recall: number | null; ci95: [number, number] | null; dropped: string[] }>;
}
export interface ProofEntities {
  rule: string;
  method: string;
  rows: Array<{ entity: string; present: number; caught: number; named: number; recall: number | null; ci95: [number, number] | null }>;
}
export interface ProofCustom {
  method: string;
  types: Array<{ type: string; config: Record<string, unknown>; n: number; positives: number; negatives: number; skipped: number; tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null; f1: number | null; ci95: ProofInterval }>;
}
export interface ProofClaims {
  schemaVersion: number;
  corpusVersion: string;
  generatedAt: string;
  commit: string;
  /** package.json version the numbers were generated for; the page cites this, not the squashed commit. */
  version?: string;
  method: { ci: string; f1Ci: string; credible?: string; ppvAt?: string };
  rules: ProofRule[];
  humanAgreement: { status: string; note: string };
  judge?: { status: 'pending' | 'measured'; note?: string; [key: string]: unknown };
  /** schemaVersion 2 blocks; each absent until its measurement lands. */
  customCorpusVersion?: string;
  transforms?: ProofTransforms;
  entities?: ProofEntities[];
  custom?: ProofCustom;
  composite?: ProofComposite;
}
export const PROOF: ProofClaims | null =
  (claimsRaw as unknown as { proof?: ProofClaims }).proof ?? null;

// Capability map — what Iris can judge, cell by cell, read verbatim from
// capability-map.json by scripts/claims/generators/capability-map.mjs.
export type CapabilityStatus = 'has' | 'partial' | 'gap' | 'n/a';
export interface CapabilityEvidence {
  kind: 'rule' | 'tool' | 'resource' | 'route' | 'proof' | 'template';
  name: string;
}
export interface CapabilityCell {
  id: string;
  question: string;
  subject: string;
  status: CapabilityStatus;
  summary: string;
  evidence: CapabilityEvidence[];
  needs: string[];
}
export interface CapabilityMapClaims {
  version: number;
  about: string;
  questions: Array<{ id: string; registryId: string; text: string }>;
  subjects: Array<{ id: string; text: string }>;
  cells: CapabilityCell[];
  counts: Record<CapabilityStatus, number>;
  total: number;
}
export const CAPABILITY_MAP = (claimsRaw as unknown as { capabilityMap: CapabilityMapClaims }).capabilityMap;

// Evaluator of evaluators — the thirteen trust questions asked of every
// evaluator Iris ships, derived from the proof files by
// scripts/claims/generators/evaluators.mjs (tests/evaluators-matrix.test.ts).
export interface EvaluatorCell {
  status: 'measured' | 'partial' | 'stated' | 'measurable' | 'n/a';
  evidence?: string;
  note?: string;
}
export interface EvaluatorsClaims {
  version: number;
  about: string;
  statuses: string[];
  questions: Array<{ id: string; n: number; text: string }>;
  groups: Array<{ id: string; text: string }>;
  evaluators: Array<{ id: string; group: string; name: string; cells: Record<string, EvaluatorCell>; measured: number }>;
  counts: { evaluators: number; questions: number; measuredThreeOrMore: number; byGroup: Record<string, { evaluators: number; measuredThreeOrMore: number }>; byStatus: Record<string, number> };
  sources: { results: { corpusVersion: string; customCorpusVersion: string | null }; composite: { compositeVersion: string } | null; judge: { status: string } };
}
export const EVALUATORS: EvaluatorsClaims | null = (claimsRaw as unknown as { evaluators?: EvaluatorsClaims }).evaluators ?? null;

// Release
export const CURRENT_RELEASE_VERSION = claimsRaw.release.currentReleaseVersion as string | null;
export const CURRENT_RELEASE_DATE = claimsRaw.release.currentReleaseDate as string | null;
// The CHANGELOG's bold lead line for the current release - the release's own
// title, e.g. "The acceptance-test release". Null when a release has no lead
// line; consumers must fall back rather than restate one.
export const CURRENT_RELEASE_HEADLINE = claimsRaw.release.currentReleaseHeadline as string | null;
export const NEXT_PLANNED_VERSION = claimsRaw.release.nextPlannedVersion as string | null;
export const NEXT_PLANNED_SCOPE = claimsRaw.release.nextPlannedScope as string | null;
