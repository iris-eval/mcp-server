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
}
export interface ProofClaims {
  schemaVersion: number;
  corpusVersion: string;
  generatedAt: string;
  commit: string;
  method: { ci: string; f1Ci: string };
  rules: ProofRule[];
  humanAgreement: { status: string; note: string };
  judge?: { status: 'pending' | 'measured'; note?: string; [key: string]: unknown };
}
export const PROOF: ProofClaims | null =
  (claimsRaw as unknown as { proof?: ProofClaims }).proof ?? null;

// Release
export const CURRENT_RELEASE_VERSION = claimsRaw.release.currentReleaseVersion as string | null;
export const CURRENT_RELEASE_DATE = claimsRaw.release.currentReleaseDate as string | null;
// The CHANGELOG's bold lead line for the current release - the release's own
// title, e.g. "The acceptance-test release". Null when a release has no lead
// line; consumers must fall back rather than restate one.
export const CURRENT_RELEASE_HEADLINE = claimsRaw.release.currentReleaseHeadline as string | null;
export const NEXT_PLANNED_VERSION = claimsRaw.release.nextPlannedVersion as string | null;
export const NEXT_PLANNED_SCOPE = claimsRaw.release.nextPlannedScope as string | null;
