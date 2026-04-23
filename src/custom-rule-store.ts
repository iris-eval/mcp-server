/*
 * custom-rule-store — file-based persistence for deployed custom rules.
 *
 * Lives at ~/.iris/custom-rules.json with the schema in
 * src/types/custom-rule.ts. Audit log lives at ~/.iris/audit.log
 * (append-only JSONL). Both files are created on first write.
 *
 * The v0.4 cut is single-user local. Concurrent writes from multiple
 * iris-mcp instances are not protected — that's a v0.5 concern when
 * multi-tenancy lands. For now we use atomic write-via-rename so a
 * crashed write doesn't leave a half-file.
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

function defaultRulesPath(): string {
  return join(homedir(), '.iris', 'custom-rules.json');
}

function defaultAuditPath(): string {
  return join(homedir(), '.iris', 'audit.log');
}

export interface CustomRuleStore {
  list(): DeployedCustomRule[];
  get(id: string): DeployedCustomRule | undefined;
  deploy(input: DeployRuleInput): DeployedCustomRule;
  delete(id: string, user?: string): boolean;
  setEnabled(id: string, enabled: boolean, user?: string): DeployedCustomRule | undefined;
  /** All ENABLED rules in deploy order — what the engine should register. */
  enabledRules(): DeployedCustomRule[];
  /** Path on disk for diagnostics. */
  filePath: string;
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

export function createCustomRuleStore(opts?: {
  rulesPath?: string;
  auditPath?: string;
}): CustomRuleStore {
  const rulesPath = opts?.rulesPath ?? defaultRulesPath();
  const auditPath = opts?.auditPath ?? defaultAuditPath();

  // In-memory copy that mirrors the file. Writes update both.
  let rules: DeployedCustomRule[] = [];

  // Initial load
  if (existsSync(rulesPath)) {
    try {
      const raw = readFileSync(rulesPath, 'utf-8');
      const parsed = FileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        rules = parsed.data.rules;
      }
      // Malformed: leave rules empty; do NOT overwrite the file.
    } catch {
      // Unreadable: leave rules empty.
    }
  }

  function persist(): void {
    const file: CustomRulesFile = { version: 1, rules };
    writeAtomic(rulesPath, JSON.stringify(file, null, 2));
  }

  return {
    filePath: rulesPath,
    auditPath,
    list(): DeployedCustomRule[] {
      return [...rules];
    },
    get(id: string): DeployedCustomRule | undefined {
      return rules.find((r) => r.id === id);
    },
    enabledRules(): DeployedCustomRule[] {
      return rules.filter((r) => r.enabled);
    },
    deploy(input: DeployRuleInput): DeployedCustomRule {
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
      rules.push(validated);
      persist();
      /* Tenant scoping: OSS single-tenant emits 'local'. Cloud replaces
       * the entire custom-rule-store with a DB-backed service that reads
       * the tenant from the authenticated session; that service will
       * compute tenantId per-call. Hard-coded here for OSS. */
      appendAudit(auditPath, {
        ts: now,
        tenantId: 'local',
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
    delete(id: string, user = 'local'): boolean {
      const idx = rules.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      const removed = rules[idx];
      rules.splice(idx, 1);
      persist();
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        tenantId: 'local',
        action: 'rule.delete',
        user,
        ruleId: id,
        ruleName: removed.name,
      });
      return true;
    },
    setEnabled(id: string, enabled: boolean, user = 'local'): DeployedCustomRule | undefined {
      const rule = rules.find((r) => r.id === id);
      if (!rule) return undefined;
      if (rule.enabled === enabled) return rule;
      rule.enabled = enabled;
      rule.updatedAt = new Date().toISOString();
      persist();
      appendAudit(auditPath, {
        ts: rule.updatedAt,
        tenantId: 'local',
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
