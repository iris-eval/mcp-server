/*
 * Validating a tool call against the schema its tool declares — and the
 * guard ladder that makes doing so safe.
 *
 * THE PROBLEM THIS MODULE EXISTS TO SOLVE. `inputSchema` is supplied by the
 * caller: over `log_trace` (unauthenticated in stdio mode), over the HTTP
 * ingest route, and inline on `evaluate_output`. ajv does not interpret a
 * schema — it GENERATES JavaScript from it, compiles that with `new
 * Function`, and runs it on the main thread. So a tools catalogue is, in the
 * most literal sense, code someone else wrote arriving over a wire that
 * accepts traces. Five surfaces follow from that: catastrophic backtracking
 * through `pattern`, compile blowup through size or a recursive `$ref`, the
 * generated code itself, unbounded validation on a crafted instance, and a
 * remote `$ref` reaching the network.
 *
 * The ladder below answers each in order, and its shape follows the lesson
 * `rules/regex-sandbox.ts` already learned the hard way: STOP PREDICTING.
 * Rung 2 is a static, total, cheap walk that bounds everything after it, and
 * the only rung that actually EXECUTES an attacker's construct — the regex
 * probe — runs behind the existing worker-thread hard deadline. The compile
 * budget is honestly labelled as what it is: a fool-me-once guard that
 * cannot interrupt a slow compile on a single thread, which is why it is not
 * the boundary.
 *
 * WHEN A RUNG TRIPS, THE WHOLE TOOL'S SCHEMA IS REJECTED — never a partially
 * applied schema. A partial schema reporting a call valid is the false
 * all-clear this codebase is most hostile to, and it would be a false
 * all-clear about a security-relevant class.
 */
import { createHash } from 'node:crypto';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import isSafeRegex from 'safe-regex2';
import { MAX_PATTERN_LENGTH } from './rules/custom.js';
import { regexBacktrackingBudgetExceeded } from './rules/regex-budget.js';

/** Bytes of serialised schema. Bounds every walk and every compile after it. */
export const MAX_TOOL_SCHEMA_BYTES = 32_768;
/** Nesting depth. A deeper schema is a document, not an argument contract. */
export const MAX_TOOL_SCHEMA_DEPTH = 12;
/** Total nodes. Depth alone does not bound a wide schema. */
export const MAX_TOOL_SCHEMA_NODES = 2_000;
/** Compiled validators kept, keyed by schema hash. Negatives cached too — see below. */
export const TOOL_SCHEMA_CACHE_MAX = 256;
/**
 * A fool-me-once ceiling, not a boundary, and DELIBERATELY GENEROUS.
 *
 * It cannot interrupt a compile in progress — a synchronous call cannot be
 * interrupted from behind — so all it can do is cache the rejection and make
 * the second occurrence free. That is worth having, and it is worth almost
 * nothing compared with the cost of tripping on an honest schema.
 *
 * It started at 50ms and the guard-ladder test caught the consequence
 * immediately: under a loaded machine, an ordinary three-property object
 * schema exceeded it and was refused, which would take a real deployment's
 * real tool out of checking because CI happened to be busy. That is exactly
 * what regex-budget.ts records learning — "wall-clock includes OS
 * scheduling, and on a busy host a 1ms match can take 60ms of wall time" —
 * and its answer was the same: meter tightly where you can measure honestly,
 * and make the wall-clock number a hang-killer that scheduling noise can
 * never reach. Rung 2 is the boundary here; this is the hang-killer.
 */
export const SCHEMA_COMPILE_BUDGET_MS = 1_000;
/** Instances larger than this are left UNCHECKED rather than failed. */
export const MAX_TOOL_INPUT_BYTES = 65_536;
/** Patterns one schema may carry. Each survivor of the static checks costs a probe. */
export const MAX_PATTERNS_PER_SCHEMA = 24;
/** Wall time one schema's patterns may spend in the probe before the schema is refused. */
export const SCHEMA_PROBE_BUDGET_MS = 2_000;

export type SchemaRejection = { ok: false; reason: string };
export type SchemaAcceptance = { ok: true; validate: ValidateFunction };
export type CompiledSchema = SchemaAcceptance | SchemaRejection;

/**
 * One ajv instance, ours, never the SDK's.
 *
 * The SDK keeps its own for protocol messages, and a deployment `$id` could
 * collide with the protocol schemas registered there. Every option below is
 * a decision:
 *
 * - `allErrors: false` — ajv's own documentation names `allErrors` as a
 *   denial-of-service vector on untrusted schemas. One error per call across
 *   a twenty-call trajectory is still twenty rows, and "every wrong field at
 *   once" is not worth a documented amplification.
 * - `validateFormats: false` — `format` is an annotation, not a constraint.
 *   Enforcing it manufactures false findings whenever an emitter's notion of
 *   `date-time` differs from ajv's, and `format: "uri"` routes through
 *   `fast-uri`, the package carrying the two open high-severity advisories
 *   in SECURITY-EXPOSURE.md. Declining removes that exposure question from
 *   this path entirely, and `ajv-formats` is not a dependency.
 * - `coerceTypes`, `useDefaults`, `removeAdditional` all false — a validator
 *   that rewrote the instance would change what `callKey` and the repeat
 *   detector hash. A validator must never mutate the thing it validates.
 * - `$data: false` — `$data` lets a schema read the instance it is checking.
 * - `validateSchema: true` — ajv refuses a malformed schema before compiling
 *   it, which is a free rung.
 * - `loadSchema` is never configured, so a remote reference cannot be
 *   fetched even if rung 3 were somehow bypassed.
 */
function makeAjv(): Ajv {
  return new Ajv({
    strictSchema: false,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
    allErrors: false,
    validateFormats: false,
    validateSchema: true,
    $data: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    ownProperties: true,
    unicodeRegExp: true,
    code: { source: false, esm: false, optimize: 1 },
    loopRequired: 20,
    loopEnum: 20,
  });
}

let ajv: Ajv | null = null;
function instance(): Ajv {
  ajv ??= makeAjv();
  return ajv;
}

/*
 * The cache holds REJECTIONS as well as acceptances, and that is what makes
 * the regex probe affordable. Without it a hostile two-hundred-tool
 * catalogue resent a thousand times pays two hundred sandbox round trips
 * every time; with it, once. It is process-global and tenant-agnostic, which
 * is safe by construction rather than by trust: the key is a hash of the
 * content and the value is a pure function of it, so there is no channel
 * between tenants.
 */
const cache = new Map<string, CompiledSchema>();

function remember(key: string, value: CompiledSchema): CompiledSchema {
  if (cache.size >= TOOL_SCHEMA_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/** Test seam: the cache is process-global, so a test that fills it must clear it. */
export function resetSchemaCache(): void {
  cache.clear();
  ajv = null;
}

interface Walked {
  depth: number;
  nodes: number;
  patterns: string[];
  refs: string[];
  forbidden: string[];
}

/** Rung 2 and 3 in one pass: bound the shape, and collect what rung 5 must lint. */
function walk(node: unknown, depth: number, acc: Walked): void {
  if (depth > acc.depth) acc.depth = depth;
  if (acc.depth > MAX_TOOL_SCHEMA_DEPTH || acc.nodes > MAX_TOOL_SCHEMA_NODES) return;
  if (Array.isArray(node)) {
    for (const child of node) {
      acc.nodes += 1;
      walk(child, depth + 1, acc);
    }
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    acc.nodes += 1;
    if (key === 'pattern' && typeof value === 'string') acc.patterns.push(value);
    if (key === 'patternProperties' && value !== null && typeof value === 'object') {
      acc.patterns.push(...Object.keys(value as Record<string, unknown>));
    }
    if (key === '$ref' && typeof value === 'string') acc.refs.push(value);
    /*
     * Rejected outright. $id can collide with another schema in the shared
     * ajv; the dynamic and recursive keywords produce validation whose depth
     * cannot be bounded from the schema alone; $vocabulary changes what the
     * dialect means underneath the guards above.
     */
    if (key === '$id' || key === '$dynamicRef' || key === '$dynamicAnchor' || key === '$recursiveRef' || key === '$recursiveAnchor' || key === '$vocabulary') {
      acc.forbidden.push(key);
    }
    walk(value, depth + 1, acc);
  }
}

/**
 * Compile one tool's `inputSchema`, or say precisely why it will not be used.
 *
 * The rejection reason is written for the operator who has to fix it: it
 * names the rung and the offending construct, because "invalid schema" sends
 * someone reading a two-hundred-line document with no idea what to look for.
 */
export function compileToolSchema(schema: unknown): CompiledSchema {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, reason: 'the inputSchema is not a JSON Schema object' };
  }

  let serialised: string;
  try {
    serialised = JSON.stringify(schema);
  } catch {
    return { ok: false, reason: 'the inputSchema is not serialisable (a cycle, or a value JSON cannot carry)' };
  }
  const key = createHash('sha256').update(serialised).digest('hex');
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Rung 2: static, total, cheap. This is the real boundary against blowup.
  if (serialised.length > MAX_TOOL_SCHEMA_BYTES) {
    return remember(key, { ok: false, reason: `the inputSchema is ${serialised.length} bytes; the limit is ${MAX_TOOL_SCHEMA_BYTES}` });
  }
  const acc: Walked = { depth: 0, nodes: 1, patterns: [], refs: [], forbidden: [] };
  walk(schema, 1, acc);
  if (acc.depth > MAX_TOOL_SCHEMA_DEPTH) {
    return remember(key, { ok: false, reason: `the inputSchema nests ${acc.depth} deep; the limit is ${MAX_TOOL_SCHEMA_DEPTH}` });
  }
  if (acc.nodes > MAX_TOOL_SCHEMA_NODES) {
    return remember(key, { ok: false, reason: `the inputSchema has more than ${MAX_TOOL_SCHEMA_NODES} nodes` });
  }
  if (acc.forbidden.length > 0) {
    return remember(key, { ok: false, reason: `the inputSchema uses ${[...new Set(acc.forbidden)].join(', ')}, which Iris does not compile (a recursive or dynamic schema cannot be validated under a bounded depth)` });
  }

  // Rung 3: a remote reference is impossible by construction, not by option.
  for (const ref of acc.refs) {
    if (!ref.startsWith('#')) {
      return remember(key, { ok: false, reason: `the inputSchema references "${ref}"; only local #-references are compiled, so nothing is ever fetched` });
    }
  }

  // Rung 5: every pattern, in the order that reports the right diagnosis
  // and in the order that costs the least.
  if (acc.patterns.length > MAX_PATTERNS_PER_SCHEMA) {
    return remember(key, { ok: false, reason: `the inputSchema carries ${acc.patterns.length} regex patterns; the limit is ${MAX_PATTERNS_PER_SCHEMA}` });
  }
  let probeSpentMs = 0;
  for (const pattern of acc.patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return remember(key, { ok: false, reason: `a pattern in the inputSchema is ${pattern.length} characters; the limit is ${MAX_PATTERN_LENGTH}` });
    }
    // Syntax first: safe-regex2 returns false for anything it cannot parse,
    // so checking it first would report a plain typo as catastrophic
    // backtracking. The same ordering custom.ts already documents.
    try {
      new RegExp(pattern, 'u');
    } catch {
      return remember(key, { ok: false, reason: `a pattern in the inputSchema does not compile: ${truncatePattern(pattern)}` });
    }
    /*
     * Star height, statically and instantly. This rung was missing from the
     * first draft of this module and the guard-ladder test found it the way
     * these things are supposed to be found: an exponential pattern hidden
     * in a patternProperties KEY sailed straight through, because the probe
     * below has to GUESS an igniting payload and its alphabet heuristic did
     * not guess one. safe-regex2 catches the whole exponential family
     * without running anything, which is both the correctness fix and the
     * reason a hostile catalogue no longer costs a second per pattern.
     */
    if (!isSafeRegex(pattern)) {
      return remember(key, { ok: false, reason: `a pattern in the inputSchema is exponential by star height: ${truncatePattern(pattern)}` });
    }
    /*
     * The only rung that RUNS an attacker's construct, behind the
     * worker-thread hard deadline that exists for exactly this. It catches
     * the polynomial family star height misses. It is a courtesy rather than
     * a boundary — igniting a pattern means guessing its fuel, which is not
     * possible in general — and on THIS path there is no boundary behind it,
     * because ajv inlines a pattern into generated code and runs it on the
     * main thread. So the honest protection is the bounds around it: the
     * instance is capped, the pattern count is capped, this loop has a wall
     * budget, and a refusal is cached so a resent catalogue costs nothing.
     */
    const probeStarted = Date.now();
    const verdict = regexBacktrackingBudgetExceeded(pattern, 'u');
    probeSpentMs += Date.now() - probeStarted;
    if (verdict !== null) {
      return remember(key, { ok: false, reason: `a pattern in the inputSchema showed superlinear backtracking: ${truncatePattern(pattern)}` });
    }
    if (probeSpentMs > SCHEMA_PROBE_BUDGET_MS) {
      return remember(key, { ok: false, reason: `checking this inputSchema's patterns exceeded ${SCHEMA_PROBE_BUDGET_MS}ms` });
    }
  }

  const started = Date.now();
  let validate: ValidateFunction;
  try {
    validate = instance().compile(schema as Record<string, unknown>);
  } catch (err) {
    return remember(key, { ok: false, reason: `the inputSchema did not compile: ${err instanceof Error ? err.message : String(err)}` });
  }
  const took = Date.now() - started;
  if (took > SCHEMA_COMPILE_BUDGET_MS) {
    /*
     * Fool me once. The compile already happened, so this cannot prevent the
     * first stall; caching the rejection prevents every one after it. The
     * ceiling is generous on purpose — see the constant — because a tight
     * one refuses honest schemas on a loaded host, and a checker that
     * randomly stops checking is worse than one that occasionally pays a
     * second.
     */
    return remember(key, { ok: false, reason: `the inputSchema took ${took}ms to compile; the ceiling is ${SCHEMA_COMPILE_BUDGET_MS}ms` });
  }
  return remember(key, { ok: true, validate });
}

function truncatePattern(pattern: string): string {
  return pattern.length <= 60 ? pattern : `${pattern.slice(0, 59)}…`;
}

export interface ArgumentCheck {
  /** 'valid' | 'invalid' | 'unchecked' — never a silent pass. */
  state: 'valid' | 'invalid' | 'unchecked';
  /** For 'invalid': the JSON Pointer into the instance, and the keyword that rejected it. */
  instancePath?: string;
  keyword?: string;
  /** For 'unchecked': why. */
  reason?: string;
}

/**
 * Check one call's arguments against a compiled schema.
 *
 * NEVER returns ajv's own `message`. A message can carry schema-supplied
 * text — `errorMessage`, enum values, a title — which is attacker-influenced
 * and would be echoed into a stored evidence row and onto a dashboard. The
 * instance path and the keyword say where and what without quoting anyone.
 */
export function checkArguments(compiled: CompiledSchema, input: unknown): ArgumentCheck {
  if (!compiled.ok) return { state: 'unchecked', reason: compiled.reason };

  let size: number;
  try {
    size = input === undefined ? 0 : JSON.stringify(input)?.length ?? 0;
  } catch {
    return { state: 'unchecked', reason: 'the call arguments are not serialisable' };
  }
  if (size > MAX_TOOL_INPUT_BYTES) {
    return { state: 'unchecked', reason: `the call arguments are ${size} bytes; the limit for checking is ${MAX_TOOL_INPUT_BYTES}` };
  }

  const ok = compiled.validate(input ?? {});
  if (ok) return { state: 'valid' };
  const first: ErrorObject | undefined = compiled.validate.errors?.[0];
  return {
    state: 'invalid',
    instancePath: first?.instancePath === '' ? '(root)' : (first?.instancePath ?? '(root)'),
    keyword: first?.keyword ?? 'schema',
  };
}
