/*
 * The config file's schema — strict at every level (arc 8, R-6).
 *
 * Until 0.15.0 `loadConfig` deep-merged whatever `config.json` held. A key
 * that Iris never read — a typo (`critcalRules`), a key from another tool,
 * a key from a version that no longer exists — merged in silently and did
 * nothing, so an operator who wrote `eval.critcalRules: ["no_pii"]` had no
 * deploy gate and a file that said they did. The same class of failure the
 * criticality check closes for rule NAMES, here for the keys themselves.
 *
 * Every object below is `strictObject`: an unknown key is refused at
 * startup with a sentence naming its full path, the closest key Iris does
 * read when there is one, and the keys it reads at that level when there
 * is not. A value of the wrong type is named the same way. Only the FILE
 * is validated here — the environment and CLI layers already parse each
 * variable with its own named check (parsePortEnv, parseBooleanEnv,
 * parseArgs strict).
 *
 * `composer: "legacy"` passes this schema on purpose: criticality.ts refuses
 * it with the sentence that says what changed and where the numbers are,
 * and that sentence must keep speaking.
 */
import { z } from 'zod';
import type { IrisConfig } from '../types/config.js';

const port = z.number().int().min(1).max(65535);
const nonNegativeInt = z.number().int().min(0);
const nonNegative = z.number().min(0);
const unit = z.number().min(0).max(1);
const name = z.string().min(1);

const ruleThresholds = z.strictObject({
  min_output_length: nonNegativeInt.optional(),
  min_sentences: nonNegativeInt.optional(),
  keyword_overlap: unit.optional(),
  topic_consistency: unit.optional(),
  cost_threshold: nonNegative.optional(),
  max_token_ratio: nonNegative.optional(),
  max_tool_repeats: nonNegativeInt.optional(),
  max_target_rereads: nonNegativeInt.optional(),
  max_steps: nonNegativeInt.optional(),
});

/** What `config.json` may contain: every key `IrisConfig` reads, each optional, nothing else. */
export const configFileSchema = z.strictObject({
  storage: z
    .strictObject({
      type: z.literal('sqlite').optional(),
      path: name.optional(),
      redact: z.enum(['none', 'critical_spans']).optional(),
    })
    .optional(),
  server: z.strictObject({ name: name.optional(), version: name.optional() }).optional(),
  transport: z
    .strictObject({ type: z.enum(['stdio', 'http']).optional(), port: port.optional(), host: name.optional() })
    .optional(),
  dashboard: z.strictObject({ enabled: z.boolean().optional(), port: port.optional(), host: name.optional() }).optional(),
  eval: z
    .strictObject({
      defaultThreshold: unit.optional(),
      ruleThresholds: ruleThresholds.optional(),
      criticalRules: z.array(name).optional(),
      nonCriticalRules: z.array(name).optional(),
      composer: z.enum(['risk', 'legacy']).optional(),
      falsePassCost: nonNegative.optional(),
      onCriticalSkipped: z.enum(['unknown', 'fail', 'pass']).optional(),
      requiredEvidence: z.array(name).optional(),
      defaultsGate: z.boolean().optional(),
      validateToolArguments: z.boolean().optional(),
      plugins: z.array(z.strictObject({ path: name, sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'the sha256 of the file as 64 hex characters') })).optional(),
      prior: unit.optional(),
      priorMode: z.enum(['per-output', 'per-class']).optional(),
    })
    .optional(),
  otel: z.strictObject({ evaluateOnIngest: z.boolean().optional() }).optional(),
  logging: z.strictObject({ level: z.enum(['debug', 'info', 'warn', 'error']).optional() }).optional(),
  retention: z.strictObject({ days: nonNegativeInt.optional(), sweepIntervalHours: nonNegative.optional() }).optional(),
  security: z
    .strictObject({
      apiKey: name.optional(),
      apiKeyFile: name.optional(),
      apiKeys: z
        .array(
          z.strictObject({
            id: name,
            keyFile: name.optional(),
            keyHash: name.optional(),
            expiresAt: name.optional(),
          }),
        )
        .optional(),
      allowUnauthenticated: z.boolean().optional(),
      allowedOrigins: z.array(name).optional(),
      rateLimit: z
        .strictObject({
          api: z.number().int().min(1).optional(),
          mcp: z.number().int().min(1).optional(),
          mcpKeyBy: z.enum(['ip', 'apiKey']).optional(),
        })
        .optional(),
      requestSizeLimit: name.optional(),
    })
    .optional(),
});

/** Keys `loadConfig` writes itself after the merge; a file that carries one is refused by name. */
export const RESERVED_CONFIG_KEYS: ReadonlySet<string> = new Set(['eval.configuredThresholdKeys', 'eval.priorConfigured']);

/** The keys the schema reads at `path` (an array of segments), or [] when the path is not an object. */
export function knownKeysAt(path: ReadonlyArray<PropertyKey>): string[] {
  let node: unknown = configFileSchema;
  for (const segment of path) {
    if (typeof segment === 'number' || (typeof segment === 'string' && /^\d+$/.test(segment))) {
      // An index into an array (security.apiKeys.0.…): descend into the element schema.
      const element = elementOf(node);
      if (!element) return [];
      node = element;
      continue;
    }
    const shape = shapeOf(node);
    if (!shape || typeof segment !== 'string' || !(segment in shape)) return [];
    node = shape[segment];
  }
  const shape = shapeOf(node);
  return shape ? Object.keys(shape) : [];
}

type Def = { innerType?: unknown; element?: unknown; type?: string };

/** Unwrap `.optional()` — zod 4 keeps the inner schema on `def.innerType`. */
function unwrap(node: unknown): unknown {
  let current = node;
  for (let i = 0; i < 4; i++) {
    const def = (current as { def?: Def } | null)?.def;
    if (def?.type === 'optional' && def.innerType) current = def.innerType;
    else break;
  }
  return current;
}

function shapeOf(node: unknown): Record<string, unknown> | null {
  const shape = (unwrap(node) as { shape?: Record<string, unknown> } | null)?.shape;
  return shape && typeof shape === 'object' ? shape : null;
}

function elementOf(node: unknown): unknown {
  const def = (unwrap(node) as { def?: Def } | null)?.def;
  return def?.type === 'array' ? (def.element ?? null) : null;
}

/** Levenshtein distance, for the did-you-mean on a misspelled key. */
export function editDistance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return prev[b.length];
}

/** The closest key Iris reads at this level, when one is close enough to be the intent. */
export function closestKey(key: string, known: readonly string[]): string | null {
  let best: { key: string; distance: number } | null = null;
  for (const candidate of known) {
    const distance =
      candidate.toLowerCase() === key.toLowerCase() ? 0 : editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (best === null || distance < best.distance) best = { key: candidate, distance };
  }
  if (!best) return null;
  // Two edits on a short key is a typo; on a long one, three still is.
  const budget = key.length >= 10 ? 3 : 2;
  return best.distance <= budget ? best.key : null;
}

const dotted = (path: ReadonlyArray<PropertyKey>, key?: string): string =>
  [...path, ...(key === undefined ? [] : [key])].map(String).join('.');

function describe(issue: z.core.$ZodIssue): string[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const full = dotted(issue.path, key);
      if (RESERVED_CONFIG_KEYS.has(full)) return `"${full}" is reserved — Iris sets it at startup; remove it from the file`;
      const known = knownKeysAt(issue.path);
      const guess = closestKey(key, known);
      if (guess) return `unknown key "${full}" — did you mean "${dotted(issue.path, guess)}"?`;
      const where = issue.path.length === 0 ? 'at the top level' : `under "${dotted(issue.path)}"`;
      return `unknown key "${full}" — the keys Iris reads ${where}: ${known.join(', ')}`;
    });
  }
  const message = issue.message.replace(/^Invalid input: /, '');
  return [`"${dotted(issue.path)}": ${message}`];
}

/**
 * The parsed file, or one Error that names every problem — the full key
 * path of each, the closest key Iris reads for a typo, the type it wanted
 * for a wrong value.
 */
export function validateConfigFile(raw: unknown, path: string): Partial<IrisConfig> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Invalid config file ${path}: the top level must be a JSON object with the keys Iris reads (${knownKeysAt([]).join(', ')}).`,
    );
  }
  const result = configFileSchema.safeParse(raw);
  if (result.success) return result.data as Partial<IrisConfig>;
  const lines = result.error.issues.flatMap(describe);
  throw new Error(
    `Invalid config file ${path} — Iris refuses to start on a key it does not read, so a typo cannot silently do nothing:\n  - ${lines.join('\n  - ')}`,
  );
}
