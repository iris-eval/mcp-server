import type { EvalType, EvalRule } from '../../types/eval.js';
import { completenessRules } from './completeness.js';
import { relevanceRules } from './relevance.js';
import { safetyRules } from './safety.js';
import { costRules } from './cost.js';

export const rulesByType: Record<EvalType, EvalRule[]> = {
  completeness: completenessRules,
  relevance: relevanceRules,
  safety: safetyRules,
  cost: costRules,
  custom: [],
};

export function getRulesForType(evalType: EvalType): EvalRule[] {
  return rulesByType[evalType] ?? [];
}

export { createCustomRule } from './custom.js';
