/*
 * Plugin rules — a rule you wrote, loaded from a file you hash-pinned.
 *
 * The built-in roster is twenty-five rules in this package; custom rules are
 * eight shapes deployed as JSON. Neither lets a deployment write its own
 * detector in code. A plugin does: an ES module whose default export is
 *
 *   { name, kind, mechanism, version, needs: [...], evaluate(ctx) }
 *
 * named in config.json as
 *
 *   "eval": { "plugins": [{ "path": "./rules/no-competitor.mjs", "sha256": "<hex>" }] }
 *
 * A plugin runs in-process with the server's privileges — that is the point
 * of the hash: the file is read, its sha256 compared to the pinned one, and
 * only then imported. A wrong hash, a missing file, a module without the
 * contract, a name that clashes with a built-in or another plugin, each
 * refuses STARTUP with a sentence naming the path and the problem, before
 * any port is bound. Relative paths resolve against the Iris home, where
 * config.json lives.
 *
 * Once loaded a plugin rule is registered exactly as a deployed custom rule
 * is: it fires on every evaluation of its type, its result is stamped like
 * a built-in's (kind, mechanism, version, `origin: 'plugin'`; the
 * uncertainty basis is `unmeasured` until the deployment's own labels
 * measure it), and `list_rules` names it under `plugins`. A plugin that
 * throws, or answers with the wrong shape, skips that evaluation as
 * `config_invalid` naming itself — the server never goes down for a rule.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { ClaimKind, EvalContext, EvalRule, EvalRuleResult, EvalType, FailureClass, Mechanism, Need, QuestionId } from '../types/eval.js';
import type { IrisConfig } from '../types/config.js';
import { builtInRules } from './criticality.js';
import { irisHome } from '../utils/iris-home.js';

const CLAIM_KINDS = ['measurement', 'detection', 'inference', 'judgment', 'policy', 'verification'] as const satisfies readonly ClaimKind[];
const MECHANISMS = ['formula', 'pattern', 'heuristic', 'model', 'external'] as const satisfies readonly Mechanism[];
const NEEDS = ['output', 'input', 'expected', 'tool_calls', 'tool_outputs', 'tools_catalogue', 'cost', 'tokens', 'citations'] as const satisfies readonly Need[];
const EVAL_TYPES = ['completeness', 'relevance', 'safety', 'cost', 'custom'] as const satisfies readonly EvalType[];
const QUESTION_IDS = ['safe_output', 'grounded', 'complete', 'relevant', 'task_completed', 'tool_use_correct', 'within_budget'] as const satisfies readonly QuestionId[];

/** The contract a plugin module's default export must satisfy. */
export const pluginContractSchema = z.looseObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'a lowercase snake_case name, 2–64 characters, as the built-in rules are named'),
  kind: z.enum(CLAIM_KINDS),
  mechanism: z.enum(MECHANISMS),
  version: z.number().int().min(1),
  needs: z.array(z.enum(NEEDS)).min(1),
  evaluate: z.custom<(ctx: EvalContext) => EvalRuleResult>((v) => typeof v === 'function', 'evaluate must be a function (ctx) => result'),
  description: z.string().min(1).optional(),
  evalType: z.enum(EVAL_TYPES).optional(),
  critical: z.boolean().optional(),
  weight: z.number().positive().optional(),
  question: z.enum(QUESTION_IDS).optional(),
  classes: z.array(z.string().min(1)).optional(),
});
export type PluginContract = z.infer<typeof pluginContractSchema>;

export interface PluginEntry {
  path: string;
  sha256: string;
}

export interface LoadedPlugin {
  /** As configured. */
  entry: PluginEntry;
  /** The file that was read and imported. */
  resolvedPath: string;
  /** `plugin:<name>` — the id the engine registers it under. */
  id: string;
  rule: EvalRule;
  evalType: EvalType;
}

const HEX_64 = /^[0-9a-f]{64}$/i;

function refusal(entry: PluginEntry, resolvedPath: string, problem: string): Error {
  return new Error(
    `Refusing to start: eval.plugins entry "${entry.path}" (${resolvedPath}) ${problem}. ` +
      'Fix the entry in config.json, or remove it — a plugin runs in-process, so Iris loads none it cannot verify.',
  );
}

/** Resolve a plugin path: absolute as given, relative against the Iris home (where config.json lives). */
export function resolvePluginPath(path: string, home: string = irisHome()): string {
  return isAbsolute(path) ? path : resolve(home, path);
}

/** Wrap the plugin's evaluate so a throw or a wrong shape skips the evaluation as config_invalid, naming the plugin. */
function guardedEvaluate(name: string, evaluate: (ctx: EvalContext) => EvalRuleResult): (ctx: EvalContext) => EvalRuleResult {
  const skip = (why: string): EvalRuleResult => ({
    ruleName: name,
    passed: true,
    score: 0,
    message: `plugin "${name}" ${why}`,
    skipped: true,
    skipReason: `plugin "${name}" ${why}`,
    // The stamp derives skipClass from this flag (stamp.ts skipClassOf).
    configInvalid: true,
  });
  return (ctx) => {
    let out: unknown;
    try {
      out = evaluate(ctx);
    } catch (err) {
      return skip(`threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (out === null || typeof out !== 'object') return skip('returned no result object');
    const r = out as Partial<EvalRuleResult>;
    if (typeof r.passed !== 'boolean') return skip('returned a result without a boolean `passed`');
    if (typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > 1) return skip('returned a score outside 0..1');
    if (typeof r.message !== 'string') return skip('returned a result without a `message`');
    return { ...(r as EvalRuleResult), ruleName: name };
  };
}

/**
 * Read, verify and import every plugin in `entries`. Throws on the first
 * entry Iris cannot verify — the caller is a boot path, and a boot that
 * silently dropped a plugin would leave the deployment believing a rule ran.
 */
export async function loadPlugins(entries: readonly PluginEntry[] | undefined, options: { home?: string } = {}): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  if (!entries || entries.length === 0) return loaded;
  const builtInNames = new Set(builtInRules().map((r) => r.name));
  const seen = new Set<string>();
  for (const entry of entries) {
    const resolvedPath = resolvePluginPath(entry.path, options.home);
    if (!HEX_64.test(entry.sha256)) throw refusal(entry, resolvedPath, 'has a sha256 that is not 64 hex characters (openssl dgst -sha256 <file>)');
    let bytes: Buffer;
    try {
      bytes = await readFile(resolvedPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
      throw refusal(entry, resolvedPath, `cannot be read (${code})`);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256.toLowerCase()) {
      throw refusal(entry, resolvedPath, `does not match its pinned hash: pinned ${entry.sha256.toLowerCase()}, file ${actual}. The file changed since it was pinned — re-pin it on purpose, or restore the file`);
    }
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(resolvedPath).href);
    } catch (err) {
      throw refusal(entry, resolvedPath, `could not be imported as an ES module: ${err instanceof Error ? err.message : String(err)}`);
    }
    const candidate = (mod as { default?: unknown; plugin?: unknown }).default ?? (mod as { plugin?: unknown }).plugin;
    const parsed = pluginContractSchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || 'default export'}: ${i.message}`).join('; ');
      throw refusal(entry, resolvedPath, `does not export the plugin contract { name, kind, mechanism, version, needs, evaluate } as its default: ${issues}`);
    }
    const p = parsed.data;
    if (builtInNames.has(p.name)) throw refusal(entry, resolvedPath, `is named "${p.name}", which is a built-in rule; choose another name`);
    if (seen.has(p.name)) throw refusal(entry, resolvedPath, `is named "${p.name}", which an earlier plugin already uses`);
    seen.add(p.name);
    const evalType: EvalType = p.evalType ?? 'custom';
    const rule: EvalRule = {
      name: p.name,
      description: p.description ?? `Plugin rule: ${p.name}`,
      evalType,
      weight: p.weight ?? 1,
      critical: p.critical === true,
      kind: p.kind,
      mechanism: p.mechanism,
      needs: p.needs,
      ...(p.question ? { question: p.question } : {}),
      classes: (p.classes ?? []) as FailureClass[],
      version: p.version,
      origin: 'plugin',
      evaluate: guardedEvaluate(p.name, p.evaluate),
    };
    loaded.push({ entry, resolvedPath, id: `plugin:${p.name}`, rule, evalType });
  }
  return loaded;
}

/* ---- The process-wide list, so list_rules can name what was loaded ---- */

let registry: LoadedPlugin[] = [];

export function loadedPlugins(): readonly LoadedPlugin[] {
  return registry;
}

export function __resetPluginsForTests(): void {
  registry = [];
}

/** What `list_rules` shows for a plugin: never the code, never the evaluate. */
export interface PluginRow {
  name: string;
  description: string;
  evalType: EvalType;
  kind: ClaimKind;
  mechanism: Mechanism;
  needs: readonly Need[];
  version: number;
  critical: boolean;
  weight: number;
  question?: QuestionId;
  classes: readonly FailureClass[];
  origin: 'plugin';
  path: string;
  sha256: string;
}

export function pluginRows(): PluginRow[] {
  return registry.map(({ entry, rule, evalType }) => ({
    name: rule.name,
    description: rule.description,
    evalType,
    kind: rule.kind as ClaimKind,
    mechanism: rule.mechanism as Mechanism,
    needs: rule.needs ?? [],
    version: rule.version ?? 1,
    critical: rule.critical === true,
    weight: rule.weight,
    ...(rule.question ? { question: rule.question } : {}),
    classes: rule.classes ?? [],
    origin: 'plugin',
    path: entry.path,
    sha256: entry.sha256.toLowerCase(),
  }));
}

/**
 * Load every configured plugin and register each with the engine — the one
 * boot helper the server, the demo and the CLI share, so the three doors
 * cannot disagree about which rules run. Throws as loadPlugins throws.
 */
export async function registerPlugins(
  engine: { registerRule(evalType: EvalType, rule: EvalRule, ruleId?: string): void },
  config: Pick<IrisConfig, 'eval'>,
  options: { home?: string; log?: (line: string) => void } = {},
): Promise<LoadedPlugin[]> {
  const plugins = await loadPlugins(config.eval.plugins, { home: options.home });
  for (const p of plugins) engine.registerRule(p.evalType, p.rule, p.id);
  registry = plugins;
  if (plugins.length > 0) options.log?.(`Loaded ${plugins.length} plugin rule(s): ${plugins.map((p) => `${p.rule.name} (${p.entry.path})`).join(', ')}`);
  return plugins;
}
