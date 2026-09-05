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

export interface IrisServer {
  mcpServer: McpServer;
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
}

export function createIrisServer(
  config: IrisConfig,
  storage: IStorageAdapter,
  customRuleStore?: CustomRuleStore,
  options?: IrisServerOptions,
): IrisServer {
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
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
  });

  const mcpServer = new McpServer(
    {
      name: config.server.name,
      version: config.server.version,
    },
    { instructions },
  );

  const capabilities = (): Capabilities =>
    buildCapabilities({ config, evalEngine, customRuleStore: ruleStore, mode: options?.mode });

  registerAllTools(mcpServer, storage, evalEngine, ruleStore);
  registerAllResources(mcpServer, storage, capabilities);
  registerPrompts(mcpServer, config.server.version);

  return { mcpServer, evalEngine, customRuleStore: ruleStore, instructions, capabilities };
}
