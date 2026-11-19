/*
 * The skill's worked examples, from the server.
 *
 * Why this exists: skills/iris-eval/examples/ held three walkthroughs, each
 * headed "Actual Results (captured 2026-09-03 against the shipped server)".
 * The verdict was rebuilt after that day and nothing read the pages against
 * the server. By 0.21.0 two of the three showed `passed: false` for a
 * request the server answers `passed: true`, and their prose drew its
 * conclusion from the result the server no longer gives (#1021).
 *
 * Now every request on those pages, and every response under one, is a
 * block this script writes. A page's calls are listed in EXAMPLES; the
 * script boots the real server in process on a home directory of its own,
 * makes each call over an in-memory MCP transport as a client would, and
 * splices the request as it was sent and the response as it came back
 * between the block's markers. The prose around the blocks is the author's,
 * and each call lists what that prose says of its response (`relies`). A
 * change to the engine that makes one of those sentences untrue fails the
 * render, and the failure quotes the sentence.
 *
 * A deployment the page configures is configured the way a reader would:
 * the JSON the page shows is written to config.json in that home directory
 * and read by loadConfig, so a key the loader rejects cannot be shown.
 *
 * What is shown of a response is the part a reader of the page uses
 * (`shownEvaluation`); each field shown is the server's own, unrounded. An
 * id the server mints differs on every call, so it is shown as a fixed
 * sample.
 *
 * Usage:
 *   npm run skill-examples:render   # make the calls, write the blocks
 *   npm run skill-examples:check    # exit 1 when a committed page differs, or a sentence no longer holds
 *
 * Runs under tsx, like the manifest renderer beside it.
 * tests/skill-examples-contract.test.ts calls renderSkillExamples() and
 * compares, so the check also runs in the suite.
 */
// First, before any other module: the numbers these pages publish are measured under the runtime guard.
import '../../src/apply-runtime-guard.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../../src/config/index.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { createIrisServer } from '../../src/server.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { spliceBlock } from './render-llms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/** A tool's answer as the client received it. */
export type Answer = Record<string, any>;

export interface ExampleCall {
  /** Names the call's blocks in the page: `<!-- iris:<name>-request:start -->` and `<!-- iris:<name>-response:start -->`. */
  name: string;
  tool: string;
  /** The arguments, as shown and as sent. A function reads the answers of the page's earlier calls (a trace_id). */
  arguments: Record<string, unknown> | ((earlier: Record<string, Answer>) => Record<string, unknown>);
  /** Which of the two blocks the page carries. */
  blocks: ReadonlyArray<'request' | 'response'>;
  /** What the page's prose says of this answer. Each is checked against the answer; a false one fails the render. */
  relies: ReadonlyArray<{ says: string; holds: (answer: Answer, earlier: Record<string, Answer>) => boolean }>;
}

export interface ExampleDeployment {
  /** The config.json this deployment runs with, shown in the page's `<!-- iris:<block>:start -->` block. None: the shipped settings. */
  config?: { block: string; file: Record<string, unknown> };
  calls: ReadonlyArray<ExampleCall>;
}

export interface Example {
  /** The page, from the repository root. */
  file: string;
  /** Each runs on a store of its own, in order. A later deployment's calls can read an earlier one's answers. */
  deployments: ReadonlyArray<ExampleDeployment>;
}

/** The id shown where the server mints one: a trace id is 32 hex characters and differs on every call. */
const SAMPLE_TRACE_ID = 'becb5935791b352b551ffec747a2199a';

const fired = (answer: Answer, rule: string): boolean => (answer.rule_results as Answer[]).some((r) => r.ruleName === rule && r.skipped !== true && r.passed === false);
const row = (answer: Answer, rule: string): Answer | undefined => (answer.rule_results as Answer[]).find((r) => r.ruleName === rule);
const noteFor = (answer: Answer, rule: string): Answer | undefined => ((answer.interpretations ?? []) as Answer[]).find((i) => i.rule === rule);

const QUALITY_ASK = "Summarize the quarterly report's revenue results and what drove them.";
const QUALITY_EXPECTED = 'revenue growth, drivers, customer acquisition cost';
const PROMPT_A =
  'The quarterly report shows revenue increased by 15% compared to Q3.\nKey drivers include the new enterprise tier and improved retention rates.\nCustomer acquisition cost decreased by 8% due to organic growth.';
const PROMPT_B = 'Revenue went up.';

const PII_OUTPUT =
  "Here's a summary of the customer's recent activity:\n\nThe customer placed 3 orders in the last 30 days. Their most recent order\n(#ORD-4892) was placed on March 15, 2026 for a wireless keyboard ($49.99).\nTheir account details show the primary payment method ending in\n4532-7891-2345-6789 was used for all recent purchases.";
const PII_ASK = "Summarize this customer's recent order history.";

const RETENTION_TRACE = {
  agent_name: 'retention-analyst',
  input: 'Analyze our top 10 customers and suggest retention strategies',
  output:
    'Top retention opportunities: the three enterprise accounts with declining monthly usage should get a dedicated success check-in this month; the four mid-market accounts approaching renewal should be offered the annual-plan discount; the remaining three are healthy and need no action.',
  tool_calls: [
    { tool_name: 'database_query', input: { table: 'customers', order_by: 'revenue', limit: 10 }, latency_ms: 340 },
    { tool_name: 'database_query', input: { table: 'purchases', customer_ids: 'top-10' }, latency_ms: 520 },
    { tool_name: 'analyze_data', input: { model: 'retention' }, latency_ms: 1200 },
    { tool_name: 'generate_report', input: { format: 'summary' }, latency_ms: 890 },
  ],
  token_usage: { prompt_tokens: 12800, completion_tokens: 4100, total_tokens: 16900 },
  cost_usd: 0.47,
  latency_ms: 2950,
};
/** The budget the cost page sets for itself. */
const OWN_BUDGET = 0.25;

/** The cost page's two calls, made once per deployment it describes: the run is logged, then scored by its trace_id. */
const costCalls = (suffix: string, blocks: { log: ExampleCall['blocks']; evaluate: ExampleCall['blocks'] }, relies: ExampleCall['relies']): ExampleCall[] => [
  {
    name: `cost-log${suffix}`,
    tool: 'log_trace',
    arguments: RETENTION_TRACE,
    blocks: blocks.log,
    relies: [
      { says: 'log_trace answers with the trace_id and status "stored"', holds: (a) => typeof a.trace_id === 'string' && a.status === 'stored' },
      { says: 'the stored cost is the one the caller reported', holds: (a) => a.cost_usd === RETENTION_TRACE.cost_usd && a.cost_source === 'reported' },
    ],
  },
  {
    name: `cost-evaluate${suffix}`,
    tool: 'evaluate_output',
    arguments: (earlier) => ({ trace_id: earlier[`cost-log${suffix}`].trace_id, eval_type: 'cost' }),
    blocks: blocks.evaluate,
    relies,
  },
];

export const EXAMPLES: ReadonlyArray<Example> = [
  {
    file: 'skills/iris-eval/examples/pii-detection.md',
    deployments: [
      {
        calls: [
          {
            name: 'pii-safety',
            tool: 'evaluate_output',
            arguments: { output: PII_OUTPUT, eval_type: 'safety', input: PII_ASK },
            blocks: ['request', 'response'],
            relies: [
              { says: '`passed: false` is the verdict', holds: (a) => a.passed === false && a.verdict.state === 'fail' },
              { says: 'no_pii is a critical rule, and its failure decided: basis detector_veto, by no_pii', holds: (a) => a.verdict.basis === 'detector_veto' && a.verdict.by.join() === 'no_pii' && row(a, 'no_pii')?.role === 'veto' },
              { says: 'critical_failures names the rule that vetoed', holds: (a) => (a.critical_failures ?? []).join() === 'no_pii' },
              { says: "the rule's message names the pattern that matched (Credit Card)", holds: (a) => String(row(a, 'no_pii')?.message).includes('Credit Card') },
              { says: 'the score is above 0.7, which a reading of the score alone would call good', holds: (a) => a.score > 0.7 },
              { says: 'every other safety rule that ran passed', holds: (a) => (a.rule_results as Answer[]).filter((r) => r.skipped !== true && r.ruleName !== 'no_pii').every((r) => r.passed === true) },
            ],
          },
          {
            name: 'pii-all',
            tool: 'evaluate_output',
            arguments: { output: PII_OUTPUT, input: PII_ASK },
            blocks: ['request', 'response'],
            relies: [
              { says: 'with eval_type omitted every bundle runs, and the response says so', holds: (a) => a.eval_type === 'all' && typeof a.note === 'string' && a.note.includes('eval_type was omitted') },
              { says: 'the same verdict as the safety-only call', holds: (a, earlier) => a.passed === false && a.verdict.basis === earlier['pii-safety'].verdict.basis && a.verdict.by.join() === 'no_pii' && (a.critical_failures ?? []).join() === 'no_pii' },
              { says: 'safety.passed is false in the categories map', holds: (a) => a.categories?.safety?.passed === false },
              { says: 'cost.passed is null: no cost was sent, so the cost bundle was not judged', holds: (a) => a.categories?.cost?.passed === null },
            ],
          },
        ],
      },
    ],
  },
  {
    file: 'skills/iris-eval/examples/quality-scoring.md',
    deployments: [
      {
        calls: [
          {
            name: 'quality-a-completeness',
            tool: 'evaluate_output',
            arguments: { output: PROMPT_A, eval_type: 'completeness', input: QUALITY_ASK, expected: QUALITY_EXPECTED },
            blocks: ['request', 'response'],
            relies: [
              { says: 'Prompt A passes, with no rule that ran failing', holds: (a) => a.passed === true && (a.rule_results as Answer[]).every((r) => r.skipped === true || r.passed === true) },
              { says: 'Prompt A covers every expected term', holds: (a) => row(a, 'expected_coverage')?.score === 1 },
            ],
          },
          {
            name: 'quality-b-completeness',
            tool: 'evaluate_output',
            arguments: { output: PROMPT_B, eval_type: 'completeness', input: QUALITY_ASK, expected: QUALITY_EXPECTED },
            blocks: ['response'],
            relies: [
              { says: 'Prompt B scores lower than Prompt A', holds: (a, earlier) => a.score < earlier['quality-a-completeness'].score },
              { says: 'three rules fail on Prompt B: it is under the minimum length, has one sentence where two are asked for, and covers one of the six expected terms', holds: (a) => fired(a, 'min_output_length') && fired(a, 'sentence_count') && fired(a, 'expected_coverage') && String(row(a, 'expected_coverage')?.message).includes('1/6') },
              { says: 'the verdict on Prompt B still passes: each of the three is a measurement, and its role reads advisory', holds: (a) => a.passed === true && ['min_output_length', 'sentence_count', 'expected_coverage'].every((r) => row(a, r)?.kind === 'measurement' && row(a, r)?.role === 'advisory') },
              { says: 'interpretations says of each failed measurement that it took no part, and names eval.criticalRules', holds: (a) => ['min_output_length', 'sentence_count', 'expected_coverage'].every((r) => noteFor(a, r)?.configKey === 'eval.criticalRules' && String(noteFor(a, r)?.text).includes('took no part')) },
            ],
          },
          {
            name: 'quality-a-relevance',
            tool: 'evaluate_output',
            arguments: { output: PROMPT_A, eval_type: 'relevance', input: QUALITY_ASK },
            blocks: ['request', 'response'],
            relies: [{ says: 'Prompt A passes the relevance bundle with no rule that ran failing', holds: (a) => a.passed === true && (a.rule_results as Answer[]).every((r) => r.skipped === true || r.passed === true) }],
          },
          {
            name: 'quality-b-relevance',
            tool: 'evaluate_output',
            arguments: { output: PROMPT_B, eval_type: 'relevance', input: QUALITY_ASK },
            blocks: ['response'],
            relies: [
              { says: 'Prompt B scores lower than Prompt A on relevance too', holds: (a, earlier) => a.score < earlier['quality-a-relevance'].score },
              { says: 'keyword_overlap and answers_the_ask fail on Prompt B, and the verdict passes', holds: (a) => fired(a, 'keyword_overlap') && fired(a, 'answers_the_ask') && a.passed === true },
              { says: 'answers_the_ask advises here: without a judge it reads the ask lexically, and its note names IRIS_RELEVANCE_JUDGE_MODEL', holds: (a) => row(a, 'answers_the_ask')?.role === 'advisory' && noteFor(a, 'answers_the_ask')?.configKey === 'IRIS_RELEVANCE_JUDGE_MODEL' },
              { says: 'topic_consistency skipped: the output is too brief for it', holds: (a) => row(a, 'topic_consistency')?.skipped === true },
            ],
          },
        ],
      },
      {
        config: { block: 'quality-config', file: { eval: { criticalRules: ['expected_coverage'] } } },
        calls: [
          {
            name: 'quality-b-gated',
            tool: 'evaluate_output',
            arguments: { output: PROMPT_B, eval_type: 'completeness', input: QUALITY_ASK, expected: QUALITY_EXPECTED },
            blocks: ['response'],
            relies: [
              { says: 'with expected_coverage named in eval.criticalRules, Prompt B fails: basis detector_veto, by expected_coverage', holds: (a) => a.passed === false && a.verdict.basis === 'detector_veto' && a.verdict.by.join() === 'expected_coverage' && (a.critical_failures ?? []).join() === 'expected_coverage' },
              { says: 'the score is the same as before the setting', holds: (a, earlier) => a.score === earlier['quality-b-completeness'].score },
            ],
          },
          {
            name: 'quality-a-gated',
            tool: 'evaluate_output',
            arguments: { output: PROMPT_A, eval_type: 'completeness', input: QUALITY_ASK, expected: QUALITY_EXPECTED },
            blocks: [],
            relies: [{ says: 'Prompt A still passes under the same setting', holds: (a) => a.passed === true }],
          },
        ],
      },
    ],
  },
  {
    file: 'skills/iris-eval/examples/cost-tracking.md',
    deployments: [
      {
        calls: [
          ...costCalls('', { log: ['request', 'response'], evaluate: ['request', 'response'] }, [
            { says: 'cost_under_threshold fails: $0.47 against the shipped budget of $0.10', holds: (a) => fired(a, 'cost_under_threshold') && String(row(a, 'cost_under_threshold')?.message).includes('$0.4700') && String(row(a, 'cost_under_threshold')?.message).includes('$0.1000') },
            { says: 'the verdict passes all the same: a budget Iris ships advises, and the rule reads role advisory', holds: (a) => a.passed === true && row(a, 'cost_under_threshold')?.role === 'advisory' },
            { says: 'interpretations says the rule failed against a threshold Iris ships, not one you set', holds: (a) => String(noteFor(a, 'cost_under_threshold')?.text).includes('a threshold Iris ships, not one you set') },
            { says: 'evaluate_output read the cost, the tokens and the tool calls from the stored trace', holds: (a) => row(a, 'cost_under_threshold')?.skipped !== true && row(a, 'verbosity_ratio')?.skipped !== true && row(a, 'no_tool_loop')?.skipped !== true },
          ]),
          {
            name: 'cost-traces',
            tool: 'get_traces',
            arguments: { sort_by: 'cost_usd', sort_order: 'desc', limit: 10, include_summary: true },
            blocks: ['request'],
            relies: [
              { says: 'get_traces returns the traces, most expensive first', holds: (a) => Array.isArray(a.traces) && a.traces.length === 1 && a.traces[0].cost_usd === RETENTION_TRACE.cost_usd },
              {
                says: 'with include_summary the response carries a summary block with total_traces, avg_latency_ms, total_cost_usd, error_rate, eval_pass_rate, traces_per_hour and top_agents',
                holds: (a) => ['total_traces', 'avg_latency_ms', 'total_cost_usd', 'error_rate', 'eval_pass_rate', 'traces_per_hour', 'top_agents'].every((k) => a.summary !== undefined && k in a.summary),
              },
            ],
          },
        ],
      },
      {
        config: { block: 'cost-config', file: { eval: { ruleThresholds: { cost_threshold: OWN_BUDGET } } } },
        calls: costCalls('-own-budget', { log: [], evaluate: ['response'] }, [
          { says: 'with a budget of your own the same run fails the verdict: basis policy_gate, by cost_under_threshold', holds: (a) => a.passed === false && a.verdict.basis === 'policy_gate' && a.verdict.by.join() === 'cost_under_threshold' },
          { says: 'the rule reads role gate, and its message carries your budget', holds: (a) => row(a, 'cost_under_threshold')?.role === 'gate' && String(row(a, 'cost_under_threshold')?.message).includes('$0.2500') },
        ]),
      },
      {
        calls: [
          {
            name: 'cost-deploy',
            tool: 'deploy_rule',
            arguments: { name: 'retention_budget', description: 'A retention run may cost a quarter of a dollar.', eval_type: 'cost', severity: 'high', definition: { type: 'cost_threshold', config: { max_cost: OWN_BUDGET } } },
            blocks: ['request'],
            relies: [{ says: 'deploy_rule answers with the rule as persisted', holds: (a) => a.rule?.name === 'retention_budget' }],
          },
          ...costCalls('-own-rule', { log: [], evaluate: [] }, [
            { says: 'at severity high a deployed cost_threshold rule fails the verdict', holds: (a) => a.passed === false && fired(a, 'retention_budget') && (a.critical_failures ?? []).includes('retention_budget') },
          ]),
          {
            name: 'cost-none',
            tool: 'evaluate_output',
            arguments: { output: RETENTION_TRACE.output, eval_type: 'cost' },
            blocks: [],
            relies: [{ says: 'a run with no cost, sent or stored, is not passed by either rule: each skips', holds: (a) => row(a, 'cost_under_threshold')?.skipped === true && row(a, 'retention_budget')?.skipped === true }],
          },
        ],
      },
    ],
  },
];

/**
 * What a page shows of an evaluation: the verdict, the rules that ran, the
 * notes, and the counts. The response also carries an id, each rule's
 * evidence and measured accuracy, the risk estimate, and a row for every
 * rule that skipped with its reason; a page that needs one of those says so
 * and reads it from the answer in `relies`.
 */
export function shownEvaluation(answer: Answer): Record<string, unknown> {
  const all = answer.eval_type === 'all';
  return {
    eval_type: answer.eval_type,
    score: answer.score,
    passed: answer.passed,
    verdict: { state: answer.verdict.state, basis: answer.verdict.basis, by: answer.verdict.by },
    ...(answer.critical_failures !== undefined ? { critical_failures: answer.critical_failures } : {}),
    rule_results: (answer.rule_results as Answer[])
      .filter((r) => r.skipped !== true)
      .map((r) => ({ ruleName: r.ruleName, ...(all ? { category: r.category } : {}), passed: r.passed, score: r.score, role: r.role, message: r.message })),
    ...(answer.interpretations !== undefined && answer.interpretations.length > 0
      ? { interpretations: (answer.interpretations as Answer[]).map((i) => ({ ...(i.rule !== undefined ? { rule: i.rule } : {}), text: i.text, ...(i.configKey !== undefined ? { configKey: i.configKey } : {}) })) }
      : {}),
    rules_evaluated: answer.rules_evaluated,
    rules_skipped: answer.rules_skipped,
    ...(answer.categories !== undefined
      ? { categories: Object.fromEntries(Object.entries(answer.categories as Record<string, Answer>).map(([name, c]) => [name, { score: c.score, passed: c.passed, rules_evaluated: c.rules_evaluated, rules_skipped: c.rules_skipped }])) }
      : {}),
    ...(answer.note !== undefined ? { note: answer.note } : {}),
  };
}

const jsonBlock = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/** Runs `f` with IRIS_HOME at `home` and no other IRIS_ variable, so the server it builds is the page's and not this machine's; the environment is put back after. */
async function inHome<T>(home: string, f: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (!key.toUpperCase().startsWith('IRIS_')) continue;
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.IRIS_HOME = home;
  try {
    return await f();
  } finally {
    delete process.env.IRIS_HOME;
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  }
}

/** One deployment: the real server on a home directory, a store and a rule file of its own, called as a client calls it. */
async function withServer<T>(configFile: Record<string, unknown> | undefined, f: (call: (tool: string, args: Record<string, unknown>) => Promise<Answer>) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'iris-skill-examples-'));
  try {
    if (configFile !== undefined) await writeFile(join(home, 'config.json'), JSON.stringify(configFile, null, 2), 'utf-8');
    return await inHome(home, async () => {
      const config = loadConfig();
      const storage = new SqliteAdapter(':memory:');
      await storage.initialize();
      const rules = createCustomRuleStore({ pathFor: () => join(home, 'custom-rules.json'), auditPath: join(home, 'audit.log') });
      const { mcpServer } = createIrisServer(config, storage, rules, { warn: () => undefined });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      const client = new Client({ name: 'render-skill-examples', version: config.server.version });
      await client.connect(clientTransport);
      try {
        return await f(async (tool, args) => {
          const result = await client.callTool({ name: tool, arguments: args });
          const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
          if (result.isError === true) throw new Error(`skill-examples: ${tool} answered an error: ${text.slice(0, 400)}`);
          return (result.structuredContent as Answer | undefined) ?? (JSON.parse(text) as Answer);
        });
      } finally {
        await client.close();
        await storage.close();
      }
    });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export interface RenderedExample {
  output: string;
  text: string;
  /** Every answer the page's calls received, by call name: what the contract test reads. */
  answers: Record<string, Answer>;
}

/** Makes every page's calls and returns each page with its blocks written. Throws when a sentence a page relies on does not hold. */
export async function renderSkillExamples(rootDir = root): Promise<RenderedExample[]> {
  const rendered: RenderedExample[] = [];
  for (const example of EXAMPLES) {
    let text = await readFile(resolve(rootDir, example.file), 'utf-8');
    const answers: Record<string, Answer> = {};
    /** Ids the server minted for this page, each shown as the sample. */
    const minted: string[] = [];
    const sample = (shown: string): string => minted.reduce((s, id) => s.split(id).join(SAMPLE_TRACE_ID), shown);
    for (const deployment of example.deployments) {
      if (deployment.config !== undefined) text = spliceBlock(text, deployment.config.block, jsonBlock(deployment.config.file), example.file);
      await withServer(deployment.config?.file, async (call) => {
        for (const c of deployment.calls) {
          const args = typeof c.arguments === 'function' ? c.arguments(answers) : c.arguments;
          const answer = await call(c.tool, args);
          answers[c.name] = answer;
          if (c.tool === 'log_trace') minted.push(String(answer.trace_id));
          for (const r of c.relies) {
            let holds = false;
            try {
              holds = r.holds(answer, answers);
            } catch {
              holds = false;
            }
            if (!holds) {
              const shown = c.tool === 'evaluate_output' ? shownEvaluation(answer) : answer;
              throw new Error(`skill-examples: ${example.file} says of ${c.name} that ${r.says}. The server answers otherwise:\n${JSON.stringify(shown, null, 2).slice(0, 3000)}`);
            }
          }
          if (c.blocks.includes('request')) text = spliceBlock(text, `${c.name}-request`, sample(jsonBlock(args)), example.file);
          if (c.blocks.includes('response')) text = spliceBlock(text, `${c.name}-response`, sample(jsonBlock(c.tool === 'evaluate_output' ? shownEvaluation(answer) : answer)), example.file);
        }
      });
    }
    rendered.push({ output: example.file, text, answers });
  }
  return rendered;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const rendered = await renderSkillExamples();
  let drift = 0;
  for (const r of rendered) {
    const target = resolve(root, r.output);
    const existing = await readFile(target, 'utf-8');
    if (existing === r.text) {
      if (!check) console.log(`[skill-examples:render] ${r.output} unchanged`);
      continue;
    }
    if (check) {
      drift += 1;
      console.error(`[skill-examples:check] FAIL — ${r.output} differs from what the server answers now`);
      continue;
    }
    await writeFile(target, r.text, 'utf-8');
    console.log(`[skill-examples:render] wrote ${r.output}`);
  }
  if (check) {
    if (drift > 0) {
      console.error('Run `npm run skill-examples:render`, read each page against its new blocks, and commit the result.');
      process.exit(1);
    }
    console.log(`[skill-examples:check] OK — ${rendered.length} pages hold the server's answers, and every sentence they rely on holds`);
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`[skill-examples] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
