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
 * The v0.4 cut is single-user local. Concurrent writes from multiple
 * iris-mcp instances against the same tenant file are not protected.
 * For now we use atomic write-via-rename so a crashed write doesn't
 * leave a half-file.
 */
import { mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { writeAtomic } from './utils/write-atomic.js';
import { irisHome } from './utils/iris-home.js';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import isSafeRegex from 'safe-regex2';
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
const RULE_TYPE_VALUES = [
  'regex_match',
  'regex_no_match',
  'min_length',
  'max_length',
  'contains_keywords',
  'excludes_keywords',
  'json_schema',
  'cost_threshold',
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
        // Strip a leading inline flag group the way the evaluator does, so a
        // pattern that WILL run is not rejected here for syntax it tolerates.
        const stripped = pattern.replace(/^\(\?[imsugy]+\)/, '');
        // Syntax BEFORE safety: safe-regex2 returns false for anything it
        // cannot parse, so checking it first reports a plainly broken pattern
        // like `(` as "catastrophic backtracking" — an error that sends the
        // author looking for a performance problem they do not have.
        try {
          new RegExp(stripped, typeof config.flags === 'string' ? config.flags : '');
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
  /** Path on disk for diagnostics. Different per tenant. */
  pathFor(tenantId: TenantId): string;
  auditPath: string;
}

export interface DeployRuleInput {
  name: string;
  description?: string;
  evalType: EvalType;
  severity?: RuleSeverity;
  definition: CustomRuleDefinition;
  sourceMomentId?: string;
  user?: string;
}

function generateRuleId(): string {
  return `rule-${randomBytes(4).toString('hex')}`;
}

function appendAudit(auditPath: string, entry: AuditLogEntry): void {
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Audit best-effort. If filesystem is read-only or full, the deploy
    // still succeeds; the operator just loses the audit trail.
  }
}

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

  // In-memory cache keyed by tenant. Lazy-loaded on first access per
  // tenant; subsequent calls hit the cache.
  const tenantState = new Map<TenantId, LoadedRules>();

  function state(tenantId: TenantId): LoadedRules {
    let loaded = tenantState.get(tenantId);
    if (loaded === undefined) {
      loaded = loadRulesFromDisk(pathFor(tenantId));
      tenantState.set(tenantId, loaded);
    }
    return loaded;
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
  }

  return {
    auditPath,
    pathFor,
    list(tenantId: TenantId): DeployedCustomRule[] {
      return [...load(tenantId)];
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
      const rules = load(tenantId);
      rules.push(validated);
      persist(tenantId);
      appendAudit(auditPath, {
        ts: now,
        tenantId,
        action: 'rule.deploy',
        user: input.user ?? 'local',
        ruleId: id,
        ruleName: rule.name,
        details: input.sourceMomentId
          ? { sourceMomentId: input.sourceMomentId, severity: rule.severity }
          : { severity: rule.severity },
      });
      return validated;
    },
    delete(tenantId: TenantId, id: string, user = 'local'): boolean {
      const rules = load(tenantId);
      const idx = rules.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      const removed = rules[idx];
      rules.splice(idx, 1);
      persist(tenantId);
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        tenantId,
        action: 'rule.delete',
        user,
        ruleId: id,
        ruleName: removed.name,
      });
      return true;
    },
    setEnabled(
      tenantId: TenantId,
      id: string,
      enabled: boolean,
      user = 'local',
    ): DeployedCustomRule | undefined {
      const rules = load(tenantId);
      const rule = rules.find((r) => r.id === id);
      if (!rule) return undefined;
      if (rule.enabled === enabled) return rule;
      rule.enabled = enabled;
      rule.updatedAt = new Date().toISOString();
      persist(tenantId);
      appendAudit(auditPath, {
        ts: rule.updatedAt,
        tenantId,
        action: 'rule.toggle',
        user,
        ruleId: id,
        ruleName: rule.name,
        details: { enabled },
      });
      return rule;
    },
  };
}
