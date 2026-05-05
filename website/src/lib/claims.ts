// Truthbase reader — website mirror of src/lib/claims.ts.
//
// Next.js's workspace boundary doesn't let us import from the mcp-server's
// src/lib cleanly, so this file mirrors the reader surface. CI test
// (claims-readers-equal.test.ts) asserts the duplicates stay aligned
// field-by-field.
//
// Source of truth: iris/.claims.json (regenerated from canonical artifacts
// via `npm run claims:generate`). Always import from here on the website
// side; never hardcode the values inline.

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

// Release
export const CURRENT_RELEASE_VERSION = claimsRaw.release.currentReleaseVersion as string | null;
export const CURRENT_RELEASE_DATE = claimsRaw.release.currentReleaseDate as string | null;
export const NEXT_PLANNED_VERSION = claimsRaw.release.nextPlannedVersion as string | null;
export const NEXT_PLANNED_SCOPE = claimsRaw.release.nextPlannedScope as string | null;
