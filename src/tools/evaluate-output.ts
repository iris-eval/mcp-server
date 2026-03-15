import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalType, CustomRuleDefinition } from '../types/eval.js';
import type { EvalEngine } from '../eval/engine.js';

const CustomRuleSchema = z.object({
  name: z.string(),
  type: z.enum([
    'regex_match', 'regex_no_match', 'min_length', 'max_length',
    'contains_keywords', 'excludes_keywords', 'json_schema', 'cost_threshold',
  ]),
  config: z.record(z.unknown()),
  weight: z.number().optional(),
});

const inputSchema = {
  output: z.string().describe('The output text to evaluate'),
  eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']).default('completeness').describe('Type of evaluation'),
  expected: z.string().optional().describe('Expected output for comparison'),
  input: z.string().optional().describe('Original input for context'),
  trace_id: z.string().optional().describe('Link evaluation to a trace'),
  custom_rules: z.array(CustomRuleSchema).optional().describe('Custom evaluation rules'),
  cost_usd: z.number().optional().describe('Cost for cost evaluation'),
  token_usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional().describe('Token usage for cost evaluation'),
};

export function registerEvaluateOutputTool(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
): void {
  server.registerTool(
    'evaluate_output',
    {
      title: 'Evaluate Output',
      description: 'Evaluate agent output quality using configurable rules',
      inputSchema,
    },
    async (args) => {
      const evalType = args.eval_type as EvalType;

      const result = evalEngine.evaluate(
        evalType,
        {
          output: args.output,
          expected: args.expected,
          input: args.input,
          costUsd: args.cost_usd,
          tokenUsage: args.token_usage,
        },
        args.custom_rules as CustomRuleDefinition[] | undefined,
      );

      if (args.trace_id) {
        result.trace_id = args.trace_id;
      }

      await storage.insertEvalResult(result);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: result.id,
              score: result.score,
              passed: result.passed,
              rule_results: result.rule_results,
              suggestions: result.suggestions,
            }),
          },
        ],
      };
    },
  );
}
