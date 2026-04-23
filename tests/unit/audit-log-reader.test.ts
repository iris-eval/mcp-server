import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAuditLog } from '../../src/audit-log-reader.js';

let tmpDir: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-audit-'));
  auditPath = join(tmpDir, 'audit.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const sample = (overrides: Record<string, unknown> = {}) => ({
  ts: '2026-04-22T20:00:00.000Z',
  action: 'rule.deploy',
  user: 'local',
  ruleId: 'rule-abc',
  ruleName: 'no_pricing',
  ...overrides,
});

function writeEntries(entries: Array<Record<string, unknown>>): void {
  writeFileSync(
    auditPath,
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf-8',
  );
}

describe('readAuditLog', () => {
  it('returns empty result when file does not exist', () => {
    const result = readAuditLog({ filePath: auditPath });
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('parses + sorts newest first', () => {
    writeEntries([
      sample({ ts: '2026-04-22T20:00:00.000Z', ruleId: 'r1' }),
      sample({ ts: '2026-04-22T22:00:00.000Z', ruleId: 'r2' }),
      sample({ ts: '2026-04-22T21:00:00.000Z', ruleId: 'r3' }),
    ]);
    const result = readAuditLog({ filePath: auditPath });
    expect(result.total).toBe(3);
    expect(result.entries.map((e) => e.ruleId)).toEqual(['r2', 'r3', 'r1']);
  });

  it('skips malformed lines without failing the whole query', () => {
    writeFileSync(
      auditPath,
      [
        JSON.stringify(sample({ ruleId: 'good' })),
        '{not json',
        '{"ts":"2026-04-22T20:00:00.000Z","action":"rule.unknown_action","user":"x","ruleId":"x"}', // invalid action
        JSON.stringify(sample({ ruleId: 'also-good', ts: '2026-04-22T22:00:00.000Z' })),
        '',
      ].join('\n'),
      'utf-8',
    );
    const result = readAuditLog({ filePath: auditPath });
    expect(result.total).toBe(2);
    expect(result.entries.map((e) => e.ruleId).sort()).toEqual(['also-good', 'good']);
  });

  it('filters by action', () => {
    writeEntries([
      sample({ action: 'rule.deploy', ruleId: 'a' }),
      sample({ action: 'rule.delete', ruleId: 'b' }),
      sample({ action: 'rule.deploy', ruleId: 'c' }),
    ]);
    const result = readAuditLog({
      filePath: auditPath,
      filter: { action: 'rule.delete' },
    });
    expect(result.total).toBe(1);
    expect(result.entries[0].ruleId).toBe('b');
  });

  it('filters by since', () => {
    writeEntries([
      sample({ ts: '2026-04-22T20:00:00.000Z', ruleId: 'old' }),
      sample({ ts: '2026-04-22T22:00:00.000Z', ruleId: 'new' }),
    ]);
    const result = readAuditLog({
      filePath: auditPath,
      filter: { since: '2026-04-22T21:00:00.000Z' },
    });
    expect(result.total).toBe(1);
    expect(result.entries[0].ruleId).toBe('new');
  });

  it('filters by search substring (ruleId or ruleName)', () => {
    writeEntries([
      sample({ ruleId: 'rule-pricing', ruleName: 'no_pricing' }),
      sample({ ruleId: 'rule-stub', ruleName: 'no_stub_extension' }),
    ]);
    expect(readAuditLog({ filePath: auditPath, filter: { search: 'pricing' } }).total).toBe(1);
    expect(readAuditLog({ filePath: auditPath, filter: { search: 'rule-stub' } }).total).toBe(1);
    expect(readAuditLog({ filePath: auditPath, filter: { search: 'nope' } }).total).toBe(0);
  });

  it('respects limit + offset for pagination', () => {
    writeEntries(
      Array.from({ length: 10 }, (_, i) =>
        sample({ ts: `2026-04-22T${10 + i}:00:00.000Z`, ruleId: `r${i}` }),
      ),
    );
    const page1 = readAuditLog({ filePath: auditPath, limit: 3, offset: 0 });
    const page2 = readAuditLog({ filePath: auditPath, limit: 3, offset: 3 });
    expect(page1.entries).toHaveLength(3);
    expect(page2.entries).toHaveLength(3);
    expect(page1.entries[0].ruleId).not.toBe(page2.entries[0].ruleId);
    expect(page1.total).toBe(10);
  });

  it('caps limit at 1000', () => {
    writeEntries([sample()]);
    const result = readAuditLog({ filePath: auditPath, limit: 99999 });
    expect(result.limit).toBe(1000);
  });
});
