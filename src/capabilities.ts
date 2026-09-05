/*
 * What THIS server can do — one object, served two ways.
 *
 * `iris://capabilities` (MCP) and `GET /api/v1/capabilities` (HTTP) both
 * render from buildCapabilities, so an agent on either transport reads the
 * same facts: the version, the rule roster with what each rule needs and
 * its published accuracy, the custom-rule count, the judge state with the
 * steps that enable it, the citation verifier's fetch posture, the
 * dashboard's address, the limits a caller will hit, and the tools,
 * resources and prompts that are registered. Provider name only, never a
 * key — this object is served on a dashboard others may see.
 */
import type { IrisConfig } from './types/config.js';
import type { EvalEngine } from './eval/engine.js';
import type { CustomRuleStore } from './custom-rule-store.js';
import { builtInRuleRoster, type BuiltInRuleMeta } from './eval/criticality.js';
import { QUESTIONS, type EvaluationQuestion } from './eval/questions.js';
import { publishedAccuracyFor, publishedProvenance, ppvAt, type PublishedRuleAccuracy } from './eval/accuracy.js';
import { REGEX_MATCH_BUDGET_MS } from './eval/rules/regex-sandbox.js';
import { JUDGE_ENABLE_STEPS, judgeState, type JudgeProvider } from './judge-enablement.js';
import { LOCAL_TENANT } from './types/tenant.js';
import { TOOL_NAMES } from './tools/index.js';
import { RESOURCE_URIS } from './resources/uris.js';
import { EVALUATE_MY_AGENT_PROMPT } from './instructions.js';

/** The most inline custom rules one evaluate_output call may carry. */
export const MAX_INLINE_CUSTOM_RULES = 10;
/** The most citations one verify_citations call may verify. */
export const MAX_CITATIONS_PER_CALL = 50;

export interface RuleProof extends PublishedRuleAccuracy {
  /** Positive predictive value at four prevalences: what a fire is worth when the failure is rare. */
  ppvAt: Record<string, number | null>;
  corpusVersion: string;
  release: string;
  labelling: 'same-model' | 'human-verified';
}

export interface Capabilities {
  version: string;
  transport: 'stdio' | 'http';
  questions: readonly EvaluationQuestion[];
  rules: Array<BuiltInRuleMeta & { proof: RuleProof | null }>;
  customRules: { count: number; enabled: number; quarantined: unknown[] };
  judge: {
    enabled: boolean;
    provider: JudgeProvider | null;
    providers: JudgeProvider[];
    costCapUsd: number;
    howToEnable: readonly string[];
  };
  citations: { fetchAllowed: boolean; domainsRestricted: boolean };
  dashboard: { enabled: boolean; url: string | null; mode: 'real' | 'demo' };
  limits: {
    customRulesPerCall: number;
    regexBudgetMs: number;
    httpRateLimitPerMin: number;
    citationsPerCall: number;
  };
  tools: readonly string[];
  resources: readonly string[];
  prompts: readonly string[];
}

export interface CapabilitiesContext {
  config: IrisConfig;
  evalEngine?: EvalEngine;
  customRuleStore?: CustomRuleStore;
  mode?: 'real' | 'demo';
}

export function ruleProof(name: string): RuleProof | null {
  const acc = publishedAccuracyFor(name);
  if (!acc) return null;
  const prov = publishedProvenance();
  return {
    ...acc,
    ppvAt: ppvAt(name),
    corpusVersion: prov.corpusVersion,
    release: prov.release,
    labelling: prov.labelling,
  };
}

export function buildCapabilities(ctx: CapabilitiesContext): Capabilities {
  const { config } = ctx;
  const roster = builtInRuleRoster(ctx.evalEngine ? (rule) => ctx.evalEngine!.effectiveCriticality(rule) : undefined);
  const custom = ctx.customRuleStore?.list(LOCAL_TENANT) ?? [];
  const judge = judgeState();
  const dashboardHost = config.dashboard.host === '0.0.0.0' || config.dashboard.host === '::' ? 'localhost' : config.dashboard.host;
  return {
    version: config.server.version,
    transport: config.transport.type,
    questions: QUESTIONS,
    rules: roster.map((r) => ({ ...r, proof: ruleProof(r.name) })),
    customRules: { count: custom.length, enabled: custom.filter((r) => r.enabled).length, quarantined: [] },
    judge: {
      enabled: judge.enabled,
      provider: judge.provider,
      providers: judge.providers,
      costCapUsd: judge.costCapUsd,
      howToEnable: JUDGE_ENABLE_STEPS,
    },
    citations: {
      fetchAllowed: process.env.IRIS_CITATION_ALLOW_FETCH === '1',
      domainsRestricted: Boolean(process.env.IRIS_CITATION_DOMAINS && process.env.IRIS_CITATION_DOMAINS.trim().length > 0),
    },
    dashboard: {
      enabled: config.dashboard.enabled,
      url: config.dashboard.enabled ? `http://${dashboardHost}:${config.dashboard.port}` : null,
      mode: ctx.mode ?? 'real',
    },
    limits: {
      customRulesPerCall: MAX_INLINE_CUSTOM_RULES,
      regexBudgetMs: REGEX_MATCH_BUDGET_MS,
      httpRateLimitPerMin: config.security.rateLimit.mcp,
      citationsPerCall: MAX_CITATIONS_PER_CALL,
    },
    tools: TOOL_NAMES,
    resources: RESOURCE_URIS,
    prompts: [EVALUATE_MY_AGENT_PROMPT],
  };
}
