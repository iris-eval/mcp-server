/*
 * The policy an agent's actions are held to.
 *
 * This is the machinery behind the `action_policy` custom rule type: a
 * deployment names the tools its agent may or may not call, and the argument
 * values those calls may or may not carry, and every tool call in the
 * trajectory is checked against it.
 *
 * THE ONE DECISION THAT SHAPES EVERYTHING ELSE: globs do NOT go through the
 * regex sandbox, and that reverses the obvious design. Three reasons, and the
 * third is decisive.
 *
 *   1. A glob is strictly weaker than a regular expression. Segment-wise
 *      two-pointer matching is O(pattern x value) with a single backtrack
 *      point and no state machine that can be made to explore, so the
 *      protection the sandbox sells is not needed here.
 *   2. Compiling globs to regexes would REINTRODUCE the problem the sandbox
 *      exists for, and the sandbox is a serialising singleton: fifty calls
 *      against ten rules is five hundred blocking worker round-trips on the
 *      hot path.
 *   3. Routing a policy through a budget makes the policy DEFEATABLE. Craft
 *      a value that stalls the match, collect `budgetExceeded`, and the rule
 *      skips — which means the policy does not gate. **A policy an attacker
 *      can switch off is worse than no policy.** A matcher that cannot be
 *      stalled has nothing to switch off.
 *
 * THE SECOND PRINCIPLE: every ambiguity resolves toward denial. Percent
 * decoding that changes a value produces two forms to check, and a deny rule
 * fires if EITHER matches while an allow rule is satisfied only if BOTH do.
 * Deny globs fold case; allow globs do not. A `..` that climbs out of its
 * root is reported even on a passing result rather than silently absorbed.
 */
import { normalise } from './text/normalise.js';

/** Longest glob accepted. A policy is written by a person; this is generous. */
export const MAX_GLOB_LENGTH = 512;
/** Longest value matched. Beyond it the value is reported as truncated, never silently cut. */
export const MAX_VALUE_LENGTH = 4_096;
/** Rules per list. */
export const MAX_POLICY_RULES = 100;
/** Argument bindings per rule. */
export const MAX_POLICY_ARGS = 32;
/** Path segments considered. A path deeper than this is pathological, not a path. */
export const MAX_PATH_SEGMENTS = 128;
/** Array elements a `-` pointer segment expands to. */
export const MAX_POINTER_FANOUT = 64;

/* ------------------------------------------------------------------ *
 * The matcher
 * ------------------------------------------------------------------ */

/**
 * One path segment against one glob segment: `*` any run of characters,
 * `?` exactly one. Neither crosses `/`, which is free here because a
 * segment contains none.
 *
 * The classic linear wildcard match: walk both, and on a mismatch fall back
 * to the LAST star and advance the value by one. There is a single backtrack
 * point rather than a stack, which is what makes the worst case a product
 * instead of an exponential.
 */
export function matchGlobSegment(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = v;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * A whole path against a whole glob. `**` as a segment matches any number of
 * segments, including none — so `/workspace/**` matches `/workspace` itself,
 * which is the denial-favouring reading of "everything under here".
 *
 * Same single-backtrack shape as the character matcher, one level up.
 */
export function matchGlob(pattern: string, value: string): boolean {
  const pat = pattern.split('/');
  const val = value.split('/');
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < val.length) {
    if (p < pat.length && pat[p] !== '**' && matchGlobSegment(pat[p], val[v])) {
      p += 1;
      v += 1;
    } else if (p < pat.length && pat[p] === '**') {
      star = p;
      p += 1;
      mark = v;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === '**') p += 1;
  return p === pat.length;
}

/* ------------------------------------------------------------------ *
 * Normalising a value before it is matched
 * ------------------------------------------------------------------ */

export interface NormalisedValue {
  /**
   * The forms to match against — always at least one, and two when percent
   * decoding changed the value. A deny rule fires on ANY; an allow rule is
   * satisfied only by ALL.
   */
  forms: readonly string[];
  /** A `..` climbed above the root, or survives as a literal leading segment. */
  escaping: boolean;
  /** Percent decoding produced a different string, so both forms are carried. */
  decodedDiffered: boolean;
  /** The value was longer than MAX_VALUE_LENGTH and only its head was matched. */
  truncated: boolean;
}

/**
 * Decode percent escapes ONCE.
 *
 * Iterated decoding is its own attack surface — it turns `%2525` into `%`
 * and invents a value nobody sent — so this decodes a single round and, when
 * the result differs, the caller matches BOTH forms. That is why the return
 * carries a list rather than a string.
 */
function decodeOnce(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not a decoding; the raw form stands.
    return value;
  }
}

/**
 * Canonicalise one path, in the order the attacks require.
 *
 * Percent-decode, then `normalise()` for NFKC, confusables and zero-width
 * characters — which is what kills a fullwidth solidus masquerading as a
 * separator — then backslashes to slashes, then `.` and empty segments, then
 * `..` resolved lexically.
 *
 * A `..` that would climb above the root is KEPT as a literal segment and the
 * value is flagged as escaping. Absorbing it silently would turn
 * `../../etc/passwd` into `etc/passwd` and quietly move the value out from
 * under the glob that was written to catch it.
 */
function canonicalisePath(raw: string): { path: string; literal: string; escaping: boolean } {
  const folded = normalise(raw).text.replace(/\\/g, '/');
  const absolute = folded.startsWith('/');
  const segments = folded.split('/').slice(0, MAX_PATH_SEGMENTS);
  const out: string[] = [];
  /*
   * The same path with `..` left standing.
   *
   * A value can honestly be read two ways, and a policy must be checked
   * against both: `/workspace/../etc/passwd` READS /etc/passwd, and it also
   * CLAIMS to be under /workspace. An author who wrote `deny /workspace/**`
   * meant to catch the second reading; an author who wrote
   * `allow /workspace/**` must not be satisfied by the first. Carrying both
   * forms and keeping the union-for-deny, intersection-for-allow asymmetry
   * gets both right, and it is the same rule percent-decoding already
   * follows rather than a special case bolted on for traversal.
   */
  const literal: string[] = [];
  let escaping = false;
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    literal.push(segment);
    if (segment !== '..') {
      out.push(segment);
      continue;
    }
    const last = out[out.length - 1];
    if (out.length > 0 && last !== '..') {
      out.pop();
      escaping = true;
      continue;
    }
    // Nothing left to climb out of: the value reaches above its own root.
    out.push('..');
    escaping = true;
  }
  const joined = out.join('/');
  const literalJoined = literal.join('/');
  return {
    path: absolute ? `/${joined}` : joined,
    literal: absolute ? `/${literalJoined}` : literalJoined,
    escaping,
  };
}

/**
 * Canonicalise a GLOB the same way a value is canonicalised.
 *
 * Without this the two sides disagree on their own notation and the author
 * pays for it: `https://docs.vendor.test/**` would never match a URL,
 * because the value's empty segment between the scheme and the host is
 * collapsed while the pattern's is not. A pattern and the thing it matches
 * must be read by one set of rules. `**` survives, being an ordinary
 * segment.
 */
export function canonicaliseGlob(glob: string): string {
  return canonicalisePath(glob).path;
}

/** Every form of one argument value that a policy must be checked against. */
export function normaliseValue(raw: string): NormalisedValue {
  const truncated = raw.length > MAX_VALUE_LENGTH;
  const capped = truncated ? raw.slice(0, MAX_VALUE_LENGTH) : raw;
  const decoded = decodeOnce(capped);
  const decodedDiffered = decoded !== capped;
  const primary = canonicalisePath(decoded);
  const forms = [primary.path];
  const push = (form: string) => {
    if (!forms.includes(form)) forms.push(form);
  };
  push(primary.literal);
  let escaping = primary.escaping;
  if (decodedDiffered) {
    const secondary = canonicalisePath(capped);
    escaping = escaping || secondary.escaping;
    push(secondary.path);
    push(secondary.literal);
  }
  return { forms, escaping, decodedDiffered, truncated };
}

/* ------------------------------------------------------------------ *
 * Addressing an argument
 * ------------------------------------------------------------------ */

/**
 * A JSON Pointer (RFC 6901), not a dotted path, for two reasons. It has a
 * real escape mechanism for keys containing dots and slashes (`~1` and `~0`),
 * which a dotted path does not. And **ajv's `instancePath` IS a JSON
 * Pointer**, so this rule and `valid_tool_arguments` address an argument in
 * one language — a reader moving between two findings on the same call does
 * not have to translate.
 *
 * ONE EXTENSION, and it is a deliberate redefinition: a `-` segment means
 * ANY array element. RFC 6901 gives `-` the meaning "one past the last
 * element", which addresses nothing that exists and is useless to a policy.
 * A policy needs to say "no element of this array may be an internal host".
 */
export function isJsonPointer(value: string): boolean {
  return value === '' || value.startsWith('/');
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Every value a pointer addresses. Empty when it addresses nothing. */
export function resolvePointer(root: unknown, pointer: string): unknown[] {
  if (pointer === '') return root === undefined ? [] : [root];
  let current: unknown[] = [root];
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = unescapePointerToken(rawToken);
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        if (token === '-') {
          for (const element of node.slice(0, MAX_POINTER_FANOUT)) next.push(element);
          continue;
        }
        const index = Number(token);
        if (Number.isInteger(index) && index >= 0 && index < node.length) next.push(node[index]);
        continue;
      }
      if (typeof node === 'object' && token in (node as Record<string, unknown>)) {
        next.push((node as Record<string, unknown>)[token]);
      }
    }
    if (next.length === 0) return [];
    current = next;
  }
  return current;
}

/**
 * An addressed value as a string.
 *
 * A number, boolean or null becomes its literal text — an author writing
 * `"/port": "8080"` means the port, and refusing to look at it because it
 * arrived as a number would be a policy that silently stops applying. An
 * object or array addresses no single value, so it yields null and the
 * binding does not match: a glob describes a scalar.
 */
export function valueAsString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return null;
}

/* ------------------------------------------------------------------ *
 * The policy itself
 * ------------------------------------------------------------------ */

export interface PolicyBindingSpec {
  pointer: string;
  /** As the author wrote it. Evidence and messages quote this. */
  glob: string;
  /** Canonicalised the same way a value is, which is what actually matches. */
  match: string;
}

export interface PolicyRule {
  tool: string;
  args: readonly PolicyBindingSpec[];
}

export type PolicyMode = 'allow_list' | 'deny_list' | 'both';

export interface ActionPolicy {
  deny: readonly PolicyRule[];
  allow: readonly PolicyRule[];
  mode: PolicyMode;
  /** True when the mode came from what was written rather than from `mode`. */
  modeInferred: boolean;
}

/** Every way a policy config is rejected, each with the words the author needs. */
export const POLICY_CONFIG_ERRORS = {
  no_lists:
    'config must carry `allow`, `deny`, or both. A policy that constrains nothing is a mistake rather than permission, so it is refused instead of passing every call',
  not_an_array: (key: string) => `config.${key} must be an array of rules`,
  empty_array: (key: string) => `config.${key} is an empty array — remove the key or give it a rule`,
  too_many: (key: string) => `config.${key} has more than ${MAX_POLICY_RULES} rules`,
  entry_not_object: (key: string, at: number) => `config.${key}[${at}] must be an object like { "tool": "<glob>", "args": { "<json pointer>": "<glob>" } }`,
  tool_missing: (key: string, at: number) => `config.${key}[${at}].tool must be a non-empty glob matching a tool name`,
  glob_too_long: (where: string) => `${where} is longer than ${MAX_GLOB_LENGTH} characters`,
  args_not_object: (key: string, at: number) => `config.${key}[${at}].args must be an object keyed by JSON Pointer`,
  too_many_args: (key: string, at: number) => `config.${key}[${at}].args has more than ${MAX_POLICY_ARGS} bindings`,
  bad_pointer: (key: string, at: number, pointer: string) =>
    `config.${key}[${at}].args key ${JSON.stringify(pointer)} is not a JSON Pointer — it must be "" or start with "/" (use ~1 for a literal "/" and ~0 for a literal "~"; a "-" segment means any array element)`,
  arg_glob_not_string: (key: string, at: number, pointer: string) => `config.${key}[${at}].args[${JSON.stringify(pointer)}] must be a glob string`,
  mode_unknown: (value: string) => `config.mode ${JSON.stringify(value)} is not "allow_list", "deny_list" or "both"`,
  mode_contradicts: (mode: string, missing: string) => `config.mode is ${JSON.stringify(mode)} but config.${missing} is absent`,
} as const;

function parseList(config: Record<string, unknown>, key: 'allow' | 'deny'): { rules: PolicyRule[] } | { error: string } {
  const raw = config[key];
  if (raw === undefined) return { rules: [] };
  if (!Array.isArray(raw)) return { error: POLICY_CONFIG_ERRORS.not_an_array(key) };
  if (raw.length === 0) return { error: POLICY_CONFIG_ERRORS.empty_array(key) };
  if (raw.length > MAX_POLICY_RULES) return { error: POLICY_CONFIG_ERRORS.too_many(key) };
  const rules: PolicyRule[] = [];
  for (const [at, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: POLICY_CONFIG_ERRORS.entry_not_object(key, at) };
    }
    const record = entry as Record<string, unknown>;
    const tool = record.tool;
    if (typeof tool !== 'string' || tool.length === 0) return { error: POLICY_CONFIG_ERRORS.tool_missing(key, at) };
    if (tool.length > MAX_GLOB_LENGTH) return { error: POLICY_CONFIG_ERRORS.glob_too_long(`config.${key}[${at}].tool`) };
    const args: PolicyBindingSpec[] = [];
    if (record.args !== undefined) {
      if (typeof record.args !== 'object' || record.args === null || Array.isArray(record.args)) {
        return { error: POLICY_CONFIG_ERRORS.args_not_object(key, at) };
      }
      const entries = Object.entries(record.args as Record<string, unknown>);
      if (entries.length > MAX_POLICY_ARGS) return { error: POLICY_CONFIG_ERRORS.too_many_args(key, at) };
      for (const [pointer, glob] of entries) {
        if (!isJsonPointer(pointer)) return { error: POLICY_CONFIG_ERRORS.bad_pointer(key, at, pointer) };
        if (typeof glob !== 'string' || glob.length === 0) return { error: POLICY_CONFIG_ERRORS.arg_glob_not_string(key, at, pointer) };
        if (glob.length > MAX_GLOB_LENGTH) return { error: POLICY_CONFIG_ERRORS.glob_too_long(`config.${key}[${at}].args[${JSON.stringify(pointer)}]`) };
        args.push({ pointer, glob, match: canonicaliseGlob(glob) });
      }
    }
    rules.push({ tool, args });
  }
  return { rules };
}

/** Read a policy out of a custom rule's config, or say exactly what is wrong with it. */
export function compileActionPolicy(config: Record<string, unknown>): { policy: ActionPolicy } | { error: string } {
  const deny = parseList(config, 'deny');
  if ('error' in deny) return deny;
  const allow = parseList(config, 'allow');
  if ('error' in allow) return allow;
  if (deny.rules.length === 0 && allow.rules.length === 0) return { error: POLICY_CONFIG_ERRORS.no_lists };

  const inferred: PolicyMode = deny.rules.length > 0 && allow.rules.length > 0 ? 'both' : allow.rules.length > 0 ? 'allow_list' : 'deny_list';
  const declared = config.mode;
  if (declared === undefined) {
    return { policy: { deny: deny.rules, allow: allow.rules, mode: inferred, modeInferred: true } };
  }
  if (declared !== 'allow_list' && declared !== 'deny_list' && declared !== 'both') {
    return { error: POLICY_CONFIG_ERRORS.mode_unknown(String(declared)) };
  }
  if ((declared === 'allow_list' || declared === 'both') && allow.rules.length === 0) {
    return { error: POLICY_CONFIG_ERRORS.mode_contradicts(declared, 'allow') };
  }
  if ((declared === 'deny_list' || declared === 'both') && deny.rules.length === 0) {
    return { error: POLICY_CONFIG_ERRORS.mode_contradicts(declared, 'deny') };
  }
  return { policy: { deny: deny.rules, allow: allow.rules, mode: declared, modeInferred: false } };
}

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

export interface PolicyBinding {
  pointer: string;
  glob: string;
  matched: boolean;
  /** The pointer addressed nothing on this call. */
  absent: boolean;
  escaping: boolean;
  truncated: boolean;
}

export interface PolicyMatch {
  rule: PolicyRule;
  index: number;
  matched: boolean;
  bindings: PolicyBinding[];
}

/**
 * One binding against one call's arguments.
 *
 * A pointer that addresses several values (through a `-` segment) matches
 * when EVERY addressed value matches for an allow rule, and when ANY does for
 * a deny rule — the same denial-favouring asymmetry as the decoded forms.
 */
function checkBinding(input: unknown, binding: PolicyBindingSpec, favourDenial: boolean): PolicyBinding {
  const addressed = resolvePointer(input, binding.pointer);
  const strings = addressed.map(valueAsString).filter((s): s is string => s !== null);
  if (strings.length === 0) {
    return { pointer: binding.pointer, glob: binding.glob, matched: false, absent: true, escaping: false, truncated: false };
  }
  const glob = favourDenial ? binding.match.toLowerCase() : binding.match;
  let escaping = false;
  let truncated = false;
  const perValue = strings.map((raw) => {
    const value = normaliseValue(raw);
    escaping = escaping || value.escaping;
    truncated = truncated || value.truncated;
    // Deny folds case; allow does not. Case is the cheapest evasion of a deny
    // rule, and a case-driven miss in an allow rule fails safe.
    const forms = favourDenial ? value.forms.map((f) => f.toLowerCase()) : value.forms;
    return favourDenial ? forms.some((f) => matchGlob(glob, f)) : forms.every((f) => matchGlob(glob, f));
  });
  const matched = favourDenial ? perValue.some(Boolean) : perValue.every(Boolean);
  return { pointer: binding.pointer, glob: binding.glob, matched, absent: false, escaping, truncated };
}

/**
 * Does one rule match one call?
 *
 * The tool glob must match the tool name, and EVERY argument binding must
 * match. A binding whose pointer addresses nothing does not match — a deny
 * rule on `{"/path": "/etc/**"}` should not fire on a call that carries no
 * path at all, and an allow rule should not be satisfied by an absent value.
 */
export function matchPolicyRule(rule: PolicyRule, index: number, toolName: string, input: unknown, favourDenial: boolean): PolicyMatch {
  const tool = favourDenial ? matchGlob(rule.tool.toLowerCase(), toolName.toLowerCase()) : matchGlob(rule.tool, toolName);
  const bindings = tool ? rule.args.map((binding) => checkBinding(input, binding, favourDenial)) : [];
  return { rule, index, matched: tool && bindings.every((b) => b.matched), bindings };
}
