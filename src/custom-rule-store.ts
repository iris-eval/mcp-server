/*
 * custom-rule-store — file-based persistence for deployed custom rules.
 *
 * Per-tenant file partition: each tenant's rules live in their own
 * file. OSS single-tenant installs continue to use
 * ~/.iris/custom-rules.json (the LOCAL_TENANT path) — zero migration
 * for existing users. Cloud tenants get
 * ~/.iris/custom-rules-<tenantId>.json (or whatever path the
 * `pathFor` factory returns).
 *
 * Why per-file rather than top-level keys in one file or a tenant
 * column on each rule:
 *   - Zero migration: LOCAL_TENANT keeps the v0.4 file path/schema.
 *   - Smallest blast radius for a corrupt write: one tenant's data
 *     can't poison another's.
 *   - Mirrors the existing audit-log per-file convention.
 *
 * Audit log stays SHARED across tenants: every entry already carries
 * `tenantId` so readers can scope at query time.
 *
 * Several processes share one file. `install` gives every MCP client its
 * own server process, and they all point at the same home, so the file is
 * read by many and written by any of them. Each read first stats the file
 * and re-reads it when it changed, so a rule deployed through one process
 * is the next thing every other process sees. Each change is made under a
 * lock file, on what the file holds at that moment: until this, a process
 * wrote back the copy it loaded at start, and its next deploy deleted every
 * rule another process had added since. The write itself is a rename, so a
 * crashed write leaves the old file whole.
 */
import { mkdirSync, readFileSync, existsSync, appendFileSync, statSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { writeAtomic, ensureOwnerOnly, OWNER_ONLY_FILE_MODE } from './utils/write-atomic.js';
import { irisHome } from './utils/iris-home.js';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import isSafeRegex from 'safe-regex2';
import { regexBacktrackingBudgetExceeded } from './eval/rules/regex-budget.js';
import { compileToolSchema } from './eval/schema-validator.js';
import { compileActionPolicy } from './eval/action-policy.js';
import { normalizeRegexSource, ruleContentHash } from './eval/rules/custom.js';
import { CUSTOM_RULE_CONFIG_KEYS, readNumericConfig, describeKeys } from './eval/rules/config-keys.js';
import type {
  DeployedCustomRule,
  CustomRulesFile,
  AuditLogEntry,
  RuleSeverity,
} from './types/custom-rule.js';
import type { CustomRuleDefinition, EvalType } from './types/eval.js';
import { LOCAL_TENANT, type TenantId } from './types/tenant.js';

const SEVERITY_VALUES: RuleSeverity[] = ['low', 'medium', 'high', 'critical'];
const EVAL_TYPE_VALUES: EvalType[] = ['completeness', 'relevance', 'safety', 'cost', 'custom'];
/**
 * The custom rule types, once. The deploy_rule tool and the REST route
 * (`POST /api/v1/rules/custom`) build their enums from this list — until
 * 0.16.0 each carried its own copy and the route's stopped at eight, so
 * an `action_policy` the tool accepted was refused over HTTP (found by the
 * 0.15.0 stranger's gate phase). Two surfaces, one constant.
 */
/**
 * What a deployed rule's name may hold: letters, digits, dot, dash and
 * underscore. The dashboard has always required it; deploy_rule did not, so
 * a name could carry a sentence into every evaluation and list that showed
 * it. Two surfaces, one constant. A stored name from before is still loaded.
 */
export const RULE_NAME_PATTERN = /^[a-z0-9._-]+$/i;
export const RULE_NAME_MESSAGE = 'Use letters, digits, dot, dash, underscore';

export const RULE_TYPE_VALUES = [
  'regex_match',
  'regex_no_match',
  'min_length',
  'max_length',
  'contains_keywords',
  'excludes_keywords',
  'json_schema',
  'cost_threshold',
  'action_policy',
] as const;

// Per-type config requirements, enforced at DEPLOY time.
//
// `config` was previously `z.record(z.unknown())` — any object passed. That
// let a rule like {type:'min_length', config:{}} deploy successfully and then
// fail on every single evaluation forever, silently dragging down aggregate
// scores with no indication the RULE (not the agent) was broken. Validating
// here means the failure surfaces once, at deploy, with an actionable message
// — instead of quietly corrupting every eval that follows.
const MAX_RULE_PATTERN_LENGTH = 1000;

function requirePositiveNumber(
  config: Record<string, unknown>,
  type: keyof typeof CUSTOM_RULE_CONFIG_KEYS,
  ctx: z.RefinementCtx,
): void {
  const value = readNumericConfig(config, type);
  if (value == null || value <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['config', CUSTOM_RULE_CONFIG_KEYS[type][0]],
      message: `${type} rule requires ${describeKeys(type)} (positive number)`,
    });
  }
}

function requireNonEmptyStringArray(
  config: Record<string, unknown>,
  key: string,
  ctx: z.RefinementCtx,
  hint: string,
): void {
  const value = config[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['config', key], message: hint });
  }
}

const DefinitionSchema = z
  .object({
    name: z.string().min(1).max(80),
    type: z.enum(RULE_TYPE_VALUES),
    config: z.record(z.string(), z.unknown()),
    weight: z.number().positive().optional(),
  })
  .superRefine((def, ctx) => {
    const config = def.config ?? {};
    switch (def.type) {
      case 'regex_match':
      case 'regex_no_match': {
        const pattern = config.pattern;
        if (typeof pattern !== 'string' || pattern.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'pattern'],
            message: `${def.type} rule requires config.pattern (non-empty string)`,
          });
          break;
        }
        if (pattern.length > MAX_RULE_PATTERN_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'pattern'],
            message: `Regex pattern too long (${pattern.length} > ${MAX_RULE_PATTERN_LENGTH})`,
          });
          break;
        }
        // Normalize EXACTLY the way the evaluator does — same helper — so
        // this layer validates and probes the identical pattern+flags pair
        // that will actually run. (It used to strip the inline flag group
        // but not merge its flags: a `(?i)` pattern was probed under
        // different flags than evaluation used.)
        const { pattern: stripped, flags: normalizedFlags } = normalizeRegexSource(
          pattern,
          typeof config.flags === 'string' ? config.flags : '',
        );
        // Syntax BEFORE safety: safe-regex2 returns false for anything it
        // cannot parse, so checking it first reports a plainly broken pattern
        // like `(` as "catastrophic backtracking" — an error that sends the
        // author looking for a performance problem they do not have.
        try {
          new RegExp(stripped, normalizedFlags);
        } catch (e) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'pattern'],
            message: `Invalid regex syntax: ${e instanceof Error ? e.message : 'unknown error'}`,
          });
          break;
        }
        if (!isSafeRegex(stripped)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'pattern'],
            message: 'Regex pattern rejected: potentially unsafe (catastrophic backtracking)',
          });
          break;
        }
        // safe-regex2 is a star-height heuristic — it catches EXPONENTIAL
        // blowup only. Polynomial patterns pass it: a*a*a*a*a*b is judged
        // safe and takes 156ms on 40 characters. Measure what the static
        // check cannot see.
        {
          const budgetIssue = regexBacktrackingBudgetExceeded(stripped, normalizedFlags);
          if (budgetIssue) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['config', 'pattern'],
              message: budgetIssue,
            });
          }
        }
        break;
      }
      /*
       * A json_schema rule may now carry a schema, and a schema Iris cannot
       * compile would otherwise skip silently for the life of the
       * deployment. Refuse it where the regex patterns are already refused —
       * at DEPLOY, when the author is still looking at it — rather than at
       * evaluation, where nobody is.
       */
      case 'json_schema': {
        const schema = (config as Record<string, unknown>).schema;
        if (schema === undefined || schema === null) break;
        const compiled = compileToolSchema(schema);
        if (!compiled.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'schema'],
            message: `config.schema was not compiled: ${compiled.reason}`,
          });
        }
        break;
      }
      /*
       * A policy that will not compile must be refused at DEPLOY. Every
       * other config error here is an annoyance; this one is a security
       * hole with a friendly face — a rule the author believes is guarding
       * their agent, skipping on every evaluation for the life of the
       * deployment because a JSON Pointer was written as a dotted path.
       */
      case 'action_policy': {
        const compiled = compileActionPolicy(config as Record<string, unknown>);
        if ('error' in compiled) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config'],
            message: `action_policy ${compiled.error}`,
          });
        }
        break;
      }
      case 'min_length':
        requirePositiveNumber(config, 'min_length', ctx);
        break;
      case 'max_length':
        requirePositiveNumber(config, 'max_length', ctx);
        break;
      case 'contains_keywords':
        requireNonEmptyStringArray(config, 'keywords', ctx,
          'contains_keywords rule requires config.keywords (non-empty string array)');
        break;
      case 'excludes_keywords':
        requireNonEmptyStringArray(config, 'keywords', ctx,
          'excludes_keywords rule requires config.keywords (non-empty string array)');
        break;
      case 'cost_threshold': {
        // 0 is a legitimate threshold ("must be free"), so only reject
        // missing / non-numeric / negative.
        const max = readNumericConfig(config, 'cost_threshold');
        if (max == null || max < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', CUSTOM_RULE_CONFIG_KEYS.cost_threshold[0]],
            message: `cost_threshold rule requires ${describeKeys('cost_threshold')} (non-negative number)`,
          });
        }
        break;
      }
      case 'json_schema':
        // No required config — validity is judged against the output itself.
        break;
    }
  });

const DeployedRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  evalType: z.enum(EVAL_TYPE_VALUES as [EvalType, ...EvalType[]]),
  severity: z.enum(SEVERITY_VALUES as [RuleSeverity, ...RuleSeverity[]]),
  definition: DefinitionSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceMomentId: z.string().optional(),
  version: z.number().int().positive(),
});

/**
 * Default file path for a tenant. LOCAL_TENANT keeps the v0.4 path
 * (zero migration); others get a per-tenant suffix.
 */
function defaultPathFor(tenantId: TenantId): string {
  if (tenantId === LOCAL_TENANT) {
    return join(irisHome(), 'custom-rules.json');
  }
  // Sanitize tenant id for filesystem safety. TenantId is branded but
  // could in principle contain odd chars on Cloud — limit to a known-safe
  // alphabet so we never write outside the .iris directory.
  const safe = String(tenantId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(irisHome(), `custom-rules-${safe}.json`);
}

function defaultAuditPath(): string {
  return join(irisHome(), 'audit.log');
}

export interface CustomRuleStore {
  list(tenantId: TenantId): DeployedCustomRule[];
  get(tenantId: TenantId, id: string): DeployedCustomRule | undefined;
  deploy(tenantId: TenantId, input: DeployRuleInput): DeployedCustomRule;
  delete(tenantId: TenantId, id: string, user?: string): boolean;
  setEnabled(
    tenantId: TenantId,
    id: string,
    enabled: boolean,
    user?: string,
  ): DeployedCustomRule | undefined;
  /** All ENABLED rules for a tenant in deploy order — what the engine should register. */
  enabledRules(tenantId: TenantId): DeployedCustomRule[];
  /** Entries in the store this version could not validate: kept on disk, never registered, never deleted by a deploy. */
  quarantined(tenantId: TenantId): unknown[];
  /** Path on disk for diagnostics. Different per tenant. */
  pathFor(tenantId: TenantId): string;
  auditPath: string;
  /**
   * A number that moves whenever this tenant's rules do: a change made
   * through this store, or one another process made to the file. Asking
   * re-reads the file when it changed, so a caller that kept something
   * derived from the rules (the engine's registrations) compares this to
   * what it last saw and rebuilds only then.
   */
  revision(tenantId: TenantId): number;
  /**
   * Deploys, deletes and toggles since this store was created (the
   * server's start), or null when there were none: those made through this
   * store, and those another process made to the same file, counted when
   * this one reads them. Read by the verdict surfaces so a verdict says the
   * rules under it moved.
   */
  changesSinceStart(tenantId: TenantId): RuleChangesSinceStart | null;
  /**
   * Start counting again from now. For setup that deploys through the
   * store before the server serves, such as the demo seeder: those
   * deploys are the starting rule set, not changes to it.
   */
  baselineChanges(): void;
}

/** What changed in the deployed rule set since the server started. */
export interface RuleChangesSinceStart {
  /** Deploys, deletes and enable/disable toggles, each counted once. */
  count: number;
  /** ISO time of the most recent change. */
  last_change_at: string;
  /** ISO time the server started counting. */
  since: string;
  /** Where each change is recorded, with who made it. */
  audit: 'iris://audit';
}

export interface DeployRuleInput {
  name: string;
  description?: string;
  evalType: EvalType;
  severity?: RuleSeverity;
  definition: CustomRuleDefinition;
  sourceMomentId?: string;
  user?: string;
  /** With replace: true, the ids of the same-named rules retired first — recorded on the rule.deploy audit row. */
  replaces?: string[];
}

function generateRuleId(): string {
  return `rule-${randomBytes(4).toString('hex')}`;
}

/**
 * The audit log could not be written, so the change it would have recorded
 * was refused. Named so a caller can tell it from a storage fault.
 */
export class AuditWriteError extends Error {
  constructor(auditPath: string, cause: unknown) {
    super(
      `The audit log (${auditPath}) could not be written, so the change was refused: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'A change to the rules or the stored evidence is made only when it can be recorded. Fix the file or its directory (permissions, free space) and try again.',
    );
    this.name = 'AuditWriteError';
  }
}

/**
 * Append one entry to the audit log at its default path. Exported for the
 * actions that are not rule changes but still need a record: delete_trace
 * wrote none, so an agent could remove the evidence against it without a
 * trace of the removal (2026-09-23 security review).
 *
 * Throws AuditWriteError when the entry cannot be written. Call it BEFORE
 * the change it records, so a change that cannot be recorded is not made.
 */
export function appendAuditEntry(entry: AuditLogEntry, auditPath: string = defaultAuditPath()): void {
  appendAudit(auditPath, entry);
}

/*
 * The append used to sit inside `try { } catch { }`: a read-only or full
 * disk let a rule be deployed, swapped or deleted with no record at all,
 * and the audit log is the only place that says who changed the rules a
 * verdict was produced under. A failed write now refuses the change.
 */
function appendAudit(auditPath: string, entry: AuditLogEntry): void {
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    // mode applies only when appendFileSync creates the file; an existing
    // audit.log keeps its mode, which is why ensureOwnerOnly() also runs at
    // store construction to repair files created before this change.
    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, {
      encoding: 'utf-8',
      mode: OWNER_ONLY_FILE_MODE,
    });
  } catch (err) {
    throw new AuditWriteError(auditPath, err);
  }
}

/** What a rule was, for an audit entry: the hash the ruleset fingerprint carries for it (eval/rules/custom.ts). */
const contentOf = (rule: Pick<DeployedCustomRule, 'definition' | 'severity'>): string => ruleContentHash(rule.definition, rule.severity);

interface LoadedRules {
  /** Rules that validated — these are the ones that fire. */
  rules: DeployedCustomRule[];
  /**
   * Entries that did NOT validate, preserved byte-for-byte. They never
   * fire, but persist() writes them back so a later deploy cannot delete
   * them. Without this the store silently destroys user data (below).
   */
  quarantined: unknown[];
  /**
   * False when the file exists but could not be read or JSON-parsed at
   * all. persist() refuses to write in that state rather than replacing
   * a file it never understood.
   */
  readable: boolean;
}

/*
 * Read leniently, one rule at a time.
 *
 * This used to validate the whole array with a single safeParse and return
 * [] if ANY element failed. The empty result was then cached, and the next
 * deploy/delete/toggle called persist(), which wrote {version:1, rules:[]}
 * over the file — permanently destroying every valid rule alongside the
 * bad one. The old comment ("do NOT overwrite the file") described an
 * intent the write path did not honour.
 *
 * It was reachable, not theoretical: DefinitionSchema's superRefine now
 * runs on READ as well as WRITE, and eval/rules/custom.ts notes that rules
 * predating that validation — e.g. {type:'min_length', config:{}} — are
 * already sitting in users' files.
 */
function loadRulesFromDisk(rulesPath: string): LoadedRules {
  if (!existsSync(rulesPath)) return { rules: [], quarantined: [], readable: true };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(rulesPath, 'utf-8'));
  } catch {
    return { rules: [], quarantined: [], readable: false };
  }

  const envelope = z.object({ rules: z.array(z.unknown()).optional() }).safeParse(parsedJson);
  if (!envelope.success) return { rules: [], quarantined: [], readable: false };

  const rules: DeployedCustomRule[] = [];
  const quarantined: unknown[] = [];
  for (const entry of envelope.data.rules ?? []) {
    const rule = DeployedRuleSchema.safeParse(entry);
    if (rule.success) rules.push(rule.data);
    else quarantined.push(entry);
  }
  return { rules, quarantined, readable: true };
}

/** What changes when the file is written, replaced or removed (security/live-key-ring.ts reads its files the same way). Missing is a state of its own. */
function fileFingerprint(path: string): string {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.mtimeNs}:${s.ctimeNs}:${s.size}:${s.ino}`;
  } catch {
    return 'missing';
  }
}

/** How many rules differ between two reads of the file: added, removed, switched on or off, or rewritten under the same id. */
function rulesChangedBetween(before: DeployedCustomRule[], after: DeployedCustomRule[]): number {
  const face = (r: DeployedCustomRule): string => `${r.enabled ? 1 : 0}:${r.evalType}:${contentOf(r)}`;
  const was = new Map(before.map((r) => [r.id, face(r)] as const));
  let n = 0;
  for (const r of after) {
    if (was.get(r.id) !== face(r)) n += 1;
    was.delete(r.id);
  }
  return n + was.size;
}

/*
 * One writer at a time, across processes. The lock is a file created with
 * the exclusive flag next to the rules file; whoever creates it holds it
 * and removes it when done. A change takes a few milliseconds, so a wait
 * is short, and a lock older than LOCK_STALE_MS belongs to a process that
 * died holding it and is taken over. The wait is synchronous because the
 * store is: its callers register the rule with the engine in the same tick.
 */
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock<T>(rulesPath: string, change: () => T): T {
  const lock = `${rulesPath}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', OWNER_ONLY_FILE_MODE);
      try {
        writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EPERM: Windows, while the holder is deleting the lock it just released.
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between the open and the stat
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The rules file ${rulesPath} is being changed by another Iris process and stayed locked for ${LOCK_WAIT_MS / 1000} seconds (${lock}). ` +
            'Nothing was changed. Try again; if no other Iris process is running, delete the lock file.',
        );
      }
      sleepSync(15);
    }
  }
  try {
    return change();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Taken over as stale by another process, or already gone.
    }
  }
}

export function createCustomRuleStore(opts?: {
  /**
   * Returns the file path for a tenant's rules. Defaults to
   * `~/.iris/custom-rules.json` for LOCAL_TENANT (zero migration for OSS)
   * and `~/.iris/custom-rules-<sanitized-tenantId>.json` for others.
   * Cloud orchestrators can inject their own factory to e.g. write into
   * a per-tenant data dir.
   */
  pathFor?: (tenantId: TenantId) => string;
  auditPath?: string;
}): CustomRuleStore {
  const pathFor = opts?.pathFor ?? defaultPathFor;
  const auditPath = opts?.auditPath ?? defaultAuditPath();

  /*
   * What each tenant's file held when it was last read, with the file's
   * fingerprint at that read. Every access stats the file (no read) and
   * re-reads it when the fingerprint moved, so this is a copy of the file,
   * never a second source of truth beside it.
   */
  const tenantState = new Map<TenantId, LoadedRules & { fingerprint: string; revision: number }>();

  /*
   * Rule changes since this store was created. An agent that can deploy
   * or disable a rule can otherwise shape the rules it is then judged by
   * and receive a verdict that reads clean; the audit log records each
   * change, and this count lets every verdict point at it. In memory on
   * purpose: "since the server started" is the window a reader can check
   * against iris://audit, and it never alters a verdict. A change another
   * process made is counted when this one reads it, one per rule that
   * differs.
   */
  let startedAt = new Date().toISOString();
  const changes = new Map<TenantId, { count: number; last: string }>();
  function recordChange(tenantId: TenantId, at: string, n = 1): void {
    const prior = changes.get(tenantId);
    changes.set(tenantId, { count: (prior?.count ?? 0) + n, last: at });
  }

  function state(tenantId: TenantId, reread = false): LoadedRules & { fingerprint: string; revision: number } {
    const path = pathFor(tenantId);
    const held = tenantState.get(tenantId);
    if (held === undefined) {
      // Repair permissions on files created before the owner-only change
      // (and on the audit log, which appendFileSync only modes at creation).
      // Before the fingerprint: a chmod moves the file's change time.
      ensureOwnerOnly(path, auditPath);
    }
    // The fingerprint is taken before the read: a write that lands between
    // the two leaves a fingerprint older than the content, and the next
    // access reads again.
    const fingerprint = fileFingerprint(path);
    if (!reread && held !== undefined && held.fingerprint === fingerprint) return held;
    const loaded = { ...loadRulesFromDisk(path), fingerprint, revision: (held?.revision ?? 0) + 1 };
    if (held !== undefined) {
      const moved = rulesChangedBetween(held.rules, loaded.rules);
      if (moved > 0) recordChange(tenantId, new Date().toISOString(), moved);
    }
    tenantState.set(tenantId, loaded);
    return loaded;
  }

  /**
   * One change to a tenant's rules, made under the lock on what the file
   * holds now. The file is read again inside the lock whatever its
   * fingerprint says: two writes in one clock tick can leave a file whose
   * size, times and inode all match the one this store last read.
   */
  function changing<T>(tenantId: TenantId, change: () => T): T {
    return withFileLock(pathFor(tenantId), () => {
      state(tenantId, true);
      return change();
    });
  }

  function load(tenantId: TenantId): DeployedCustomRule[] {
    return state(tenantId).rules;
  }

  function persist(tenantId: TenantId): void {
    const loaded = state(tenantId);
    if (!loaded.readable) {
      /*
       * The file exists but never parsed. Overwriting it would replace
       * content we could not read — exactly the data loss this store used
       * to cause silently. Fail loudly so the caller surfaces a 500 and
       * the operator can fix or move the file.
       */
      throw new Error(
        `Refusing to write ${pathFor(tenantId)}: the existing file could not be parsed. ` +
          `Fix or move it, then retry — writing now would destroy its contents.`,
      );
    }
    // Quarantined entries ride along untouched so a deploy never deletes
    // rules this version could not validate.
    const file: CustomRulesFile = {
      version: 1,
      rules: [...loaded.rules, ...loaded.quarantined] as DeployedCustomRule[],
    };
    writeAtomic(pathFor(tenantId), JSON.stringify(file, null, 2));
    // This store's own write: what it holds IS the file, so the next access does not read it back.
    loaded.fingerprint = fileFingerprint(pathFor(tenantId));
    loaded.revision += 1;
  }

  return {
    auditPath,
    pathFor,
    revision(tenantId: TenantId): number {
      return state(tenantId).revision;
    },
    changesSinceStart(tenantId: TenantId): RuleChangesSinceStart | null {
      state(tenantId); // counts what another process changed since the last read
      const c = changes.get(tenantId);
      return c ? { count: c.count, last_change_at: c.last, since: startedAt, audit: 'iris://audit' } : null;
    },
    baselineChanges(): void {
      changes.clear();
      startedAt = new Date().toISOString();
    },
    list(tenantId: TenantId): DeployedCustomRule[] {
      return [...load(tenantId)];
    },
    quarantined(tenantId: TenantId): unknown[] {
      return state(tenantId).quarantined;
    },
    get(tenantId: TenantId, id: string): DeployedCustomRule | undefined {
      return load(tenantId).find((r) => r.id === id);
    },
    enabledRules(tenantId: TenantId): DeployedCustomRule[] {
      return load(tenantId).filter((r) => r.enabled);
    },
    deploy(tenantId: TenantId, input: DeployRuleInput): DeployedCustomRule {
      const now = new Date().toISOString();
      const id = generateRuleId();
      const rule: DeployedCustomRule = {
        id,
        name: input.name,
        description: input.description ?? '',
        evalType: input.evalType,
        severity: input.severity ?? 'medium',
        definition: input.definition,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        sourceMomentId: input.sourceMomentId,
        version: 1,
      };
      // Validate before persisting.
      const validated = DeployedRuleSchema.parse(rule);
      return changing(tenantId, () => {
        const rules = load(tenantId);
        // Recorded first, with what the rule IS: a deploy that cannot be recorded is not made.
        appendAudit(auditPath, {
          ts: now,
          tenantId,
          action: 'rule.deploy',
          user: input.user ?? 'local',
          ruleId: id,
          ruleName: rule.name,
          details: {
            severity: rule.severity,
            contentSha256: contentOf(validated),
            ...(input.sourceMomentId ? { sourceMomentId: input.sourceMomentId } : {}),
            ...(input.replaces?.length ? { replaces: input.replaces } : {}),
          },
        });
        rules.push(validated);
        try {
          persist(tenantId);
        } catch (err) {
          rules.pop();
          throw err;
        }
        recordChange(tenantId, now);
        return validated;
      });
    },
    delete(tenantId: TenantId, id: string, user = 'local'): boolean {
      return changing(tenantId, () => {
        const rules = load(tenantId);
        const idx = rules.findIndex((r) => r.id === id);
        if (idx === -1) return false;
        const removed = rules[idx];
        const at = new Date().toISOString();
        // Recorded first, with the hash of what is being removed, so the entry still says what the rule was once it is gone.
        appendAudit(auditPath, {
          ts: at,
          tenantId,
          action: 'rule.delete',
          user,
          ruleId: id,
          ruleName: removed.name,
          details: { severity: removed.severity, contentSha256: contentOf(removed) },
        });
        rules.splice(idx, 1);
        try {
          persist(tenantId);
        } catch (err) {
          rules.splice(idx, 0, removed);
          throw err;
        }
        recordChange(tenantId, at);
        return true;
      });
    },
    setEnabled(
      tenantId: TenantId,
      id: string,
      enabled: boolean,
      user = 'local',
    ): DeployedCustomRule | undefined {
      return changing(tenantId, () => {
        const rules = load(tenantId);
        const rule = rules.find((r) => r.id === id);
        if (!rule) return undefined;
        if (rule.enabled === enabled) return rule;
        const at = new Date().toISOString();
        appendAudit(auditPath, {
          ts: at,
          tenantId,
          action: 'rule.toggle',
          user,
          ruleId: id,
          ruleName: rule.name,
          details: { enabled, severity: rule.severity, contentSha256: contentOf(rule) },
        });
        const was = { enabled: rule.enabled, updatedAt: rule.updatedAt };
        rule.enabled = enabled;
        rule.updatedAt = at;
        try {
          persist(tenantId);
        } catch (err) {
          rule.enabled = was.enabled;
          rule.updatedAt = was.updatedAt;
          throw err;
        }
        recordChange(tenantId, at);
        return rule;
      });
    },
  };
}
