/*
 * audit-log-reader — read + parse ~/.iris/audit.log (JSONL append-only).
 *
 * The file is written by custom-rule-store.ts (rule.deploy / rule.delete /
 * rule.toggle / rule.update). This reader hydrates entries for the
 * dashboard's GET /api/v1/audit endpoint.
 *
 * Performance: the audit log can grow over time. We read the whole file,
 * parse line-by-line, and return only the latest N entries (newest first).
 * For audit volumes < 10k entries this is comfortably sub-50ms; v0.5 will
 * tail-read or paginate via byte offsets if it ever matters.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { AuditLogEntry } from './types/custom-rule.js';

const AUDIT_ACTIONS = ['rule.deploy', 'rule.delete', 'rule.toggle', 'rule.update'] as const;

const EntrySchema = z.object({
  ts: z.string(),
  action: z.enum(AUDIT_ACTIONS),
  user: z.string(),
  ruleId: z.string(),
  ruleName: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export interface AuditQueryFilter {
  action?: typeof AUDIT_ACTIONS[number];
  /** ISO timestamp; only entries at or after. */
  since?: string;
  /** Optional substring match against ruleId or ruleName. */
  search?: string;
}

export interface AuditQueryResult {
  entries: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
  /** Absolute path to the audit log file (for diagnostics). */
  path: string;
}

function defaultAuditPath(): string {
  return join(homedir(), '.iris', 'audit.log');
}

export function readAuditLog(opts?: {
  filePath?: string;
  filter?: AuditQueryFilter;
  limit?: number;
  offset?: number;
}): AuditQueryResult {
  const filePath = opts?.filePath ?? defaultAuditPath();
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
  const offset = Math.max(opts?.offset ?? 0, 0);

  if (!existsSync(filePath)) {
    return { entries: [], total: 0, limit, offset, path: filePath };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { entries: [], total: 0, limit, offset, path: filePath };
  }

  // Parse line-by-line, drop malformed rows silently. The audit log is
  // append-only so a partially-flushed last line is the only realistic
  // source of malformation and we shouldn't fail the whole query for it.
  const all: AuditLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = EntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) all.push(parsed.data);
    } catch {
      // Skip malformed line
    }
  }

  // Filter
  const filter = opts?.filter ?? {};
  const filtered = all.filter((entry) => {
    if (filter.action && entry.action !== filter.action) return false;
    if (filter.since && entry.ts < filter.since) return false;
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      const matchId = entry.ruleId.toLowerCase().includes(needle);
      const matchName = entry.ruleName?.toLowerCase().includes(needle) ?? false;
      if (!matchId && !matchName) return false;
    }
    return true;
  });

  // Sort newest first by ts
  filtered.sort((a, b) => b.ts.localeCompare(a.ts));

  const total = filtered.length;
  const entries = filtered.slice(offset, offset + limit);

  return { entries, total, limit, offset, path: filePath };
}
