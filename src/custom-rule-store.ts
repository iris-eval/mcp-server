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
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
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

const DefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(RULE_TYPE_VALUES),
  config: z.record(z.unknown()),
  weight: z.number().positive().optional(),
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

const FileSchema = z.object({
  version: z.literal(1),
  rules: z.array(DeployedRuleSchema),
});

/**
 * Default file path for a tenant. LOCAL_TENANT keeps the v0.4 path
 * (zero migration); others get a per-tenant suffix.
 */
function defaultPathFor(tenantId: TenantId): string {
  if (tenantId === LOCAL_TENANT) {
    return join(homedir(), '.iris', 'custom-rules.json');
  }
  // Sanitize tenant id for filesystem safety. TenantId is branded but
  // could in principle contain odd chars on Cloud — limit to a known-safe
  // alphabet so we never write outside the .iris directory.
  const safe = String(tenantId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(homedir(), '.iris', `custom-rules-${safe}.json`);
}

function defaultAuditPath(): string {
  return join(homedir(), '.iris', 'audit.log');
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

function writeAtomic(targetPath: string, contents: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, 'utf-8');
  renameSync(tmp, targetPath);
}

function loadRulesFromDisk(rulesPath: string): DeployedCustomRule[] {
  if (!existsSync(rulesPath)) return [];
  try {
    const raw = readFileSync(rulesPath, 'utf-8');
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.rules;
    // Malformed: leave rules empty; do NOT overwrite the file.
    return [];
  } catch {
    // Unreadable: leave rules empty.
    return [];
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

  // In-memory cache keyed by tenant. Lazy-loaded on first access per
  // tenant; subsequent calls hit the cache.
  const tenantRules = new Map<TenantId, DeployedCustomRule[]>();

  function load(tenantId: TenantId): DeployedCustomRule[] {
    let rules = tenantRules.get(tenantId);
    if (rules === undefined) {
      rules = loadRulesFromDisk(pathFor(tenantId));
      tenantRules.set(tenantId, rules);
    }
    return rules;
  }

  function persist(tenantId: TenantId): void {
    const rules = tenantRules.get(tenantId) ?? [];
    const file: CustomRulesFile = { version: 1, rules };
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
