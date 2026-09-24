/*
 * The persisted shape of a judge evaluation — one writer.
 *
 * evaluate_with_llm_judge stores its result under eval_type 'custom' with a
 * single rule_results row that says what KIND of claim it is (a judgment,
 * gating, unmeasured) so a stored judgement read back through the composer
 * has a layer to fall into (0.10.0). That block lived inline in the tool;
 * the demo needs the same rows for three canned judgements —
 * the judge cannot run without a key — and a second copy of the shape is
 * exactly the drift this file exists to stop. The tool and the demo both
 * call this; a test on the shape now covers both.
 */
import type { EvalResult } from '../../types/eval.js';
import { generateEvalId } from '../../utils/ids.js';

export interface JudgeEvalRowInput {
  /** The evaluation id; generated when omitted. */
  id?: string;
  traceId?: string;
  output: string;
  expected?: string;
  template: string;
  provider: string;
  model: string;
  score: number;
  passed: boolean;
  rationale: string;
  selfReportedPass?: boolean;
  costUsd?: number | null;
  inputTokens: number;
  outputTokens: number;
  /** ISO-8601; the store defaults to now when omitted. */
  createdAt?: string;
}

/** The EvalResult the judge tool stores — rule name `llm_judge:<template>:<provider>/<model>`, kind judgment, role gate. */
export function judgeEvalResult(input: JudgeEvalRowInput): EvalResult {
  return {
    id: input.id ?? generateEvalId(),
    trace_id: input.traceId,
    eval_type: 'custom',
    output_text: input.output,
    expected_text: input.expected,
    score: input.score,
    passed: input.passed,
    rule_results: [
      {
        ruleName: `llm_judge:${input.template}:${input.provider}/${input.model}`,
        passed: input.passed,
        score: input.score,
        message: input.rationale || 'LLM judge evaluation',
        /*
         * The row says what KIND of claim it is (0.10.0). Without it a
         * stored judge evaluation read back through the composer had no
         * layer to fall into — not a policy, not a detector with a
         * published rate — and a FAILED judgement read back as clean.
         * A judgment the caller asked and paid for decides.
         */
        kind: 'judgment',
        role: 'gate',
        saw: ['output'],
        evidence: [
          {
            type: 'sample',
            score: input.score,
            ...(input.selfReportedPass !== undefined ? { selfReportedPass: input.selfReportedPass } : {}),
            rationaleHash: '',
          },
        ],
        uncertainty: {
          basis: 'unmeasured',
          why: 'the judge is user-keyed and its accuracy is measured only by a run on a key you or the maintainer supplies (npm run proof:judge)',
        },
      },
    ],
    rules_evaluated: 1,
    rules_skipped: 0,
    insufficient_data: false,
    // What the evaluation itself cost — the description promised it was
    // kept and the write path stored none of it.
    eval_cost_usd: input.costUsd ?? undefined,
    eval_tokens: input.inputTokens + input.outputTokens,
    ...(input.createdAt !== undefined ? { created_at: input.createdAt } : {}),
  };
}
