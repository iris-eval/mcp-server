/*
 * `@iris-eval/mcp-server/engine` — the evaluation engine, importable (arc 8, R-1).
 *
 * Everything an embedder needs to score an output in its own process,
 * with no server, no storage and no model: the engine, the shipped rules,
 * the composer and the published accuracy behind every stamp. Nothing
 * here opens a database or starts a listener — the storage layer, the
 * MCP server and the dashboard stay behind the package root and the CLI.
 *
 *   import { EvalEngine, defaultConfig } from '@iris-eval/mcp-server/engine';
 *   const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
 *   const result = await engine.evaluateAll({ output: 'TODO: write the summary.' });
 *   result.verdict.state; // 'fail'
 *
 * The 0.14.0 stranger, refused an env-prefixed command by its session,
 * wrote a script that spawned the CLI to evaluate three files; this
 * subpath is the supported form of that script.
 */
export { EvalEngine, ALL_EVAL_TYPES, DEFAULT_EVAL_TYPE, DEFAULT_EVAL_TYPE_NOTE } from './eval/engine.js';
export { compose, verdictPath, interpretations, roleOf, tau, DEFAULT_COMPOSE, type ComposeConfig } from './eval/compose.js';
export { riskEstimate, DEFAULT_PRIOR, DEFAULT_PRIOR_MODE, DEFAULT_FALSE_PASS_COST, type PriorMode, type RiskEstimate } from './eval/risk.js';
export { builtInRules, builtInRuleRoster, type CriticalityOverrides, type EffectiveCriticality } from './eval/criticality.js';
export { rulesByType, getRulesForType } from './eval/rules/index.js';
export { createCustomRule } from './eval/rules/custom.js';
export { publishedAccuracyFor, publishedRuleNames, publishedProvenance, ppvInterval, missRateInterval, ppvAt } from './eval/accuracy.js';
export { toEvaluationResponse } from './eval/response.js';
export { LOCAL_LABEL_MIN, localPrecision, estimatedPrior } from './eval/labels.js';
export { defaultConfig, PKG_VERSION } from './config/defaults.js';
export { PUBLIC_ID } from './identity.js';
export type {
  EvalContext,
  EvalResult,
  EvalRuleResult,
  EvalRule,
  EvalType,
  EvalResultType,
  Verdict,
  VerdictNode,
  Provenance,
  Uncertainty,
  Evidence,
  ClaimKind,
  Role,
  QuestionId,
  FailureClass,
  Need,
  SkipClass,
  Interval,
  Coverage,
  Interpretation,
  CustomRuleDefinition,
} from './types/eval.js';
export type { Trace, Span, ToolCallRecord, TokenUsage, ToolDescriptor } from './types/trace.js';
