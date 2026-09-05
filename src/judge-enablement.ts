/*
 * The judge is a user-keyed feature (founder ruling, 2026-09-04): an end
 * user enables it by supplying their own provider key, and every surface
 * that mentions it has to say so in the same words — the error a tool
 * returns without a key, the capabilities resource, the server
 * instructions, the self-test, the README and the docs. This module is
 * the one place those words live; everything else renders from it.
 *
 * What "enabled" means: a key for at least one provider reached THIS
 * process's environment. That is the only fact Iris can check, and it is
 * the fact users get wrong — a key exported in a shell is not passed to
 * the child process an MCP client spawns unless the client's config says
 * so. Step 2 below exists because of that.
 */

export type JudgeProvider = 'anthropic' | 'openai';

export const JUDGE_KEY_VARS: Readonly<Record<JudgeProvider, string>> = {
  anthropic: 'IRIS_ANTHROPIC_API_KEY',
  openai: 'IRIS_OPENAI_API_KEY',
};

export const JUDGE_COST_CAP_VAR = 'IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL';
export const JUDGE_DEFAULT_COST_CAP_USD = 0.25;

export interface JudgeState {
  /** A key for at least one provider is present in this process's environment. */
  enabled: boolean;
  /** The provider Iris would pick when a call names no provider: the first one with a key. */
  provider: JudgeProvider | null;
  /** Every provider with a key present. */
  providers: JudgeProvider[];
  /** The per-call spend cap the judge refuses beyond, before any spend. */
  costCapUsd: number;
}

/** The per-call cap from the environment, else the shipped default. */
export function judgeCostCapUsd(): number {
  const raw = process.env.IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return JUDGE_DEFAULT_COST_CAP_USD;
}

export function judgeState(): JudgeState {
  // Literal reads on purpose: the docs contract and the manifest parity
  // test grep `process.env.IRIS_*` to learn what the server reads.
  const present: Record<JudgeProvider, boolean> = {
    anthropic: Boolean(process.env.IRIS_ANTHROPIC_API_KEY),
    openai: Boolean(process.env.IRIS_OPENAI_API_KEY),
  };
  const providers = (Object.keys(JUDGE_KEY_VARS) as JudgeProvider[]).filter((p) => present[p]);
  return {
    enabled: providers.length > 0,
    provider: providers[0] ?? null,
    providers,
    costCapUsd: judgeCostCapUsd(),
  };
}

export const JUDGE_ENABLE_TITLE = 'Enable the LLM judge (optional; the deterministic rules never need it)';

/**
 * The enable workflow, one step per entry. Rendered verbatim into the
 * IRIS_JUDGE_NOT_ENABLED error's `recovery`, the capabilities resource's
 * `howToEnable`, and (through the truthbase) the README, the judge doc and
 * the skill files. Change it here and nowhere else.
 */
export const JUDGE_ENABLE_STEPS: readonly string[] = [
  'Get an API key from Anthropic or OpenAI.',
  'Put it in the environment of the process that runs Iris, not only your shell. ' +
    'Claude Code, Claude Desktop, Cursor and most MCP clients: the "env" block of the iris-eval entry in your MCP config — ' +
    '"iris-eval": { "command": "npx", "args": ["-y", "@iris-eval/mcp-server"], "env": { "IRIS_ANTHROPIC_API_KEY": "sk-ant-..." } }. ' +
    'Docker: -e IRIS_ANTHROPIC_API_KEY=... on the run command. HTTP or CI: export it before starting iris-mcp.',
  'Restart the MCP session. A running process never sees a variable set after it started.',
  'Confirm from inside your client: read iris://capabilities — judge.enabled must be true there. ' +
    'A key exported in your shell is not passed to the process your client spawns unless its config lists it.',
  `Spend guard: each call is capped by ${JUDGE_COST_CAP_VAR} (default ${JUDGE_DEFAULT_COST_CAP_USD} USD) and refused before any spend ` +
    'if the worst case would exceed it. Iris calls the provider directly with your key and never proxies it.',
];

/** The block as prose: the title, then the numbered steps. */
export function judgeEnableBlock(): string {
  return [JUDGE_ENABLE_TITLE, ...JUDGE_ENABLE_STEPS.map((s, i) => `${i + 1}. ${s}`)].join('\n');
}

/** The steps as an error's `recovery[]`, with the variable the call needed named first. */
export function judgeRecovery(provider: JudgeProvider): string[] {
  return [`Set ${JUDGE_KEY_VARS[provider]} for the process that runs Iris.`, ...JUDGE_ENABLE_STEPS];
}

/** One line for the instructions and the self-test: what this process can see. */
export function judgeStateLine(state: JudgeState): string {
  if (state.enabled) {
    const list = state.providers.join(' and ');
    return `enabled (${list} key found in this process; each call is capped at ${state.costCapUsd} USD)`;
  }
  return `not enabled (no ${JUDGE_KEY_VARS.anthropic} or ${JUDGE_KEY_VARS.openai} reached this process)`;
}
