import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IrisConfig } from './types/index.js';
import type { IStorageAdapter } from './types/query.js';
import type { CustomRuleStore } from './custom-rule-store.js';
import { EvalEngine } from './eval/engine.js';
import { rulesByType } from './eval/rules/index.js';
import { builtInRuleRoster } from './eval/criticality.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { registerPrompts } from './prompts.js';
import { createCustomRuleStore } from './custom-rule-store.js';
import { buildInstructions } from './instructions.js';
import { buildCapabilities, type Capabilities } from './capabilities.js';
import { judgeState } from './judge-enablement.js';
import { relevanceJudgeFromEnv, relevanceJudgeStartupWarnings, relevanceJudgeState } from './eval/llm-judge/relevance-judge.js';
import { judgeBudgetFromEnv } from './eval/llm-judge/budget.js';
import type { StoreGate } from './storage/ready.js';
import { errorResult } from './tools/respond.js';
import { toIrisError } from './tools/errors.js';

export interface IrisServer {
  mcpServer: McpServer;
  /**
   * Another MCP server over the same engine, store and rules. One MCP
   * server speaks to one client, so the HTTP transport asks for one per
   * session (transport/http.ts); everything they judge and store is shared.
   */
  newMcpServer: () => McpServer;
  evalEngine: EvalEngine;
  customRuleStore: CustomRuleStore;
  /** The instructions the client received at initialize — built from this server's runtime state. */
  instructions: string;
  /** What this server can do, as iris://capabilities and /api/v1/capabilities serve it. */
  capabilities: () => Capabilities;
}

export interface IrisServerOptions {
  /** `demo` when the server runs against the disposable demo database. */
  mode?: 'real' | 'demo';
  /** Where a warning line goes: the daily judge budget says here when it first refuses a call on a day. */
  warn?: (line: string) => void;
  /** Hold tool calls and resource reads until the store serves (storage/ready.ts); none when it serves from the start. */
  gate?: StoreGate;
}

/** Resources that never read the store answer during an upgrade too. */
const UNGATED_RESOURCES = new Set(['capabilities', 'proof']);

/**
 * Every tool call and resource read registered on `server` from here on
 * waits at the gate first (storage/ready.ts). A call refused there gets
 * the same error envelope as any other failure.
 */
function gateRequests(server: McpServer, gate: StoreGate): void {
  type Handler = (...args: unknown[]) => unknown;
  const registerTool = server.registerTool.bind(server) as unknown as (name: string, config: unknown, handler: Handler) => unknown;
  (server as unknown as { registerTool: typeof registerTool }).registerTool = (name, config, handler) =>
    registerTool(name, config, async (...args: unknown[]) => {
      if (!gate.open) {
        try {
          await gate.wait();
        } catch (err) {
          return errorResult(toIrisError(err));
        }
      }
      return handler(...args);
    });
  const registerResource = server.registerResource.bind(server) as unknown as (...args: unknown[]) => unknown;
  (server as unknown as { registerResource: typeof registerResource }).registerResource = (...args: unknown[]) => {
    const read = args[args.length - 1] as Handler;
    if (typeof args[0] === 'string' && UNGATED_RESOURCES.has(args[0])) return registerResource(...args);
    return registerResource(...args.slice(0, -1), async (...a: unknown[]) => {
      if (!gate.open) await gate.wait();
      return read(...a);
    });
  };
}

export function createIrisServer(
  config: IrisConfig,
  storage: IStorageAdapter,
  customRuleStore?: CustomRuleStore,
  options?: IrisServerOptions,
): IrisServer {
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
  /*
   * The relevance judge answers_the_ask gates on, when the deployment named
   * its model (IRIS_RELEVANCE_JUDGE_MODEL). A key alone never installs it:
   * the key enables evaluate_with_llm_judge, which a caller invokes and pays
   * for per call, and must not start billing every evaluation on upgrade.
   *
   * Every judge call on the user's key, its and the judge tools', draws on
   * one daily budget kept in this database, so a restart does not reset it
   * and an agent calling a judge tool in a loop stops where the operator said.
   */
  const warn = options?.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const judgeBudget = judgeBudgetFromEnv({ ledger: storage.judgeSpendLedger(), log: warn });
  for (const note of judgeBudget.notes) warn(`LLM judge: ${note}.`);
  evalEngine.setJudgeBudget(judgeBudget.budget);
  evalEngine.setRelevanceJudge(relevanceJudgeFromEnv({ budget: judgeBudget.budget }));
  // A judge that is configured and cannot run fails open; say so once, at startup, where the operator is looking.
  for (const line of relevanceJudgeStartupWarnings(evalEngine.relevanceJudgeInForce())) warn(line);
  // Caller can inject a shared rule store (e.g. index.ts passes the
  // same instance the HTTP dashboard uses, so a rule deployed via MCP
  // is immediately visible in the dashboard without a restart). If
  // none provided, create a fresh one loading from the default path.
  const ruleStore = customRuleStore ?? createCustomRuleStore();

  /*
   * The instructions are built from what THIS process will do: the
   * roster and bundles from the registry, the critical list after this
   * config's promotions and demotions, and whether a judge key reached
   * this environment. The key is read here once more at boot only to
   * describe the state; the judge tools resolve it again per call, and
   * both reads see the same environment because a process's environment
   * is fixed when its client spawns it.
   */
  const roster = builtInRuleRoster((rule) => evalEngine.effectiveCriticality(rule));
  const instructions = buildInstructions({
    ruleCount: roster.length,
    categories: Object.entries(rulesByType)
      .filter(([, rules]) => rules.length > 0)
      .map(([category]) => category),
    threshold: config.eval.defaultThreshold,
    critical: roster.filter((r) => r.critical).map((r) => r.name),
    judge: judgeState(),
    relevanceJudge: relevanceJudgeState(evalEngine.relevanceJudgeInForce()),
  });

  const capabilities = (): Capabilities =>
    buildCapabilities({ config, evalEngine, customRuleStore: ruleStore, mode: options?.mode });

  const newMcpServer = (): McpServer => {
    const server = new McpServer(
      {
        name: config.server.name,
        version: config.server.version,
      },
      { instructions },
    );
    if (options?.gate) gateRequests(server, options.gate);
    registerAllTools(server, storage, evalEngine, ruleStore);
    registerAllResources(server, storage, capabilities, ruleStore.auditPath);
    registerPrompts(server, config.server.version);
    return server;
  };

  return { mcpServer: newMcpServer(), newMcpServer, evalEngine, customRuleStore: ruleStore, instructions, capabilities };
}
