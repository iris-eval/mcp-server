/*
 * The Iris side of every comparison, in one place (arc 8, R-5).
 *
 * Each compare page is `website/src/lib/compare/<vendor>.json` — the vendor's
 * side of twelve fixed features, every cell with the vendor's own page as its
 * source and the date it was read — rendered by app/compare/[slug]/page.tsx.
 * The Iris side is not in those files: it is here, once, with every count
 * read from the truthbase, so fourteen pages cannot disagree about what Iris
 * is and no page carries a typed number. tests/compare-contract.test.ts
 * locks the feature ids, the sources and the dates.
 */
import {
  CLIENTS,
  CUSTOM_RULE_TYPE_COUNT,
  DATA_RESIDENCY,
  DISCOVERY_SENTENCE,
  LLM_JUDGE_TEMPLATE_COUNT,
  MCP_TOOL_COUNT,
  RULE_COUNT_BUILT_IN,
} from "@/lib/claims";

export const FEATURE_IDS = [
  "integration",
  "self_hosting",
  "overhead",
  "eval",
  "cost_tracking",
  "mcp_support",
  "license",
  "ownership",
  "dashboard",
  "frameworks",
  "prompt_management",
  "enterprise",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

export const FEATURE_LABEL: Record<FeatureId, string> = {
  integration: "Integration method",
  self_hosting: "Self-hosting",
  overhead: "Where it runs",
  eval: "Evaluation",
  cost_tracking: "Cost tracking",
  mcp_support: "MCP support",
  license: "License",
  ownership: "Ownership",
  dashboard: "Dashboard",
  frameworks: "Framework support",
  prompt_management: "Prompt management",
  enterprise: "Enterprise and compliance",
};

/** What Iris is, feature by feature — counts from the truthbase, never typed. */
export const IRIS_CELL: Record<FeatureId, string> = {
  integration: "One block in the MCP config, no code — the agent discovers Iris and its tools on connect",
  self_hosting: "One process, one SQLite file; Docker image with a health check",
  overhead: "Nothing in the agent's process — Iris is a separate server the agent calls",
  // Every rule's precision and recall: https://iris-eval.com/proof
  eval: `${RULE_COUNT_BUILT_IN} built-in deterministic rules and ${CUSTOM_RULE_TYPE_COUNT} custom-rule types, in-process; ${LLM_JUDGE_TEMPLATE_COUNT} judge templates on a key you supply; every rule's precision and recall published`,
  cost_tracking: "Per-trace USD cost and tokens; a cost spike judged against the agent's own history",
  mcp_support: `Protocol-native — Iris is an MCP server with ${MCP_TOOL_COUNT} tools; OTLP traces in`,
  license: "MIT, the whole package",
  ownership: "Independent and founder-led",
  dashboard: "A local dashboard on its own port: traces, moments, regressions, five views",
  frameworks: `Any MCP client (${CLIENTS.counts.verified} verified, ${CLIENTS.counts.claimed} claimed — see /clients); OTLP/HTTP from anything else`,
  prompt_management: "Not included",
  enterprise: `Self-hosted. ${DATA_RESIDENCY} No compliance certification is claimed before it is held`,
};

/** Rows where Iris deliberately has less; the cell is shown muted, never as a loss to hide. */
export const IRIS_NEUTRAL: ReadonlySet<FeatureId> = new Set<FeatureId>(["prompt_management", "enterprise"]);

export const IRIS_REASONS: readonly string[] = [
  "You are building with MCP-compatible agents and want the integration to be one config block",
  "You want the evaluation to be deterministic and local — no model call, nothing leaving the machine",
  // Measured on the proof corpus: https://iris-eval.com/proof
  "You want to read what each rule is worth before you trust it: every rule's precision and recall is published",
  "You want self-hosting to be one process and one file",
  "You want a fully permissive MIT license on the whole package",
];

/** The Iris half of the first FAQ answer; the vendor half comes from the vendor's page. */
export const IRIS_FAQ_SENTENCE = `Iris is an MCP-native agent eval server that needs no SDK. ${DISCOVERY_SENTENCE}`;

/** The one sentence that separates Iris from tools that test MCP servers. */
export const NOT_SERVER_TESTING =
  "Iris grades what an agent did with its tools — the trace, the answer, the cost — not whether an MCP server honours its own contract; a server test harness answers that question, and Iris runs beside it.";
