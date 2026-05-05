/*
 * Tenant isolation tests for CustomRuleStore.
 *
 * In OSS the store sees only LOCAL_TENANT — these tests prove the
 * per-tenant partition keeps Cloud SKU data isolated when multiple
 * tenant ids are used. Sets up a single store with a per-tenant file
 * factory; deploys distinct rules under tenant-A and tenant-B; asserts:
 *   - list/enabledRules return only the caller's tenant's rules
 *   - delete only removes the caller's tenant's rule
 *   - on-disk files are separate and don't see each other's data
 *   - audit log entries carry the resolved tenant id (no hardcoded 'local')
 *
 * Regression catcher: any future change that re-introduces shared
 * in-memory state across tenants will break these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { LOCAL_TENANT, asTenantId, type TenantId } from '../../src/types/tenant.js';

let tmpDir: string;
let auditPath: string;
const TENANT_A = asTenantId('tenant-a');
const TENANT_B = asTenantId('tenant-b');

function pathForTenant(tenantId: TenantId): string {
  if (tenantId === LOCAL_TENANT) return join(tmpDir, 'custom-rules.json');
  return join(tmpDir, `custom-rules-${tenantId}.json`);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-tenant-'));
  auditPath = join(tmpDir, 'audit.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CustomRuleStore — tenant isolation', () => {
  it('list() only returns the caller-tenant rules', () => {
    const store = createCustomRuleStore({ pathFor: pathForTenant, auditPath });
    store.deploy(TENANT_A, {
      name: 'a-rule',
      evalType: 'safety',
      definition: { name: 'a-rule', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    store.deploy(TENANT_B, {
      name: 'b-rule',
      evalType: 'safety',
      definition: { name: 'b-rule', type: 'regex_no_match', config: { pattern: 'y' } },
    });

    expect(store.list(TENANT_A).map((r) => r.name)).toEqual(['a-rule']);
    expect(store.list(TENANT_B).map((r) => r.name)).toEqual(['b-rule']);
    expect(store.list(LOCAL_TENANT)).toEqual([]);
  });

  it('on-disk files are separate per tenant (no cross-pollination)', () => {
    const store = createCustomRuleStore({ pathFor: pathForTenant, auditPath });
    store.deploy(TENANT_A, {
      name: 'a-rule',
      evalType: 'safety',
      definition: { name: 'a-rule', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    store.deploy(TENANT_B, {
      name: 'b-rule',
      evalType: 'safety',
      definition: { name: 'b-rule', type: 'regex_no_match', config: { pattern: 'y' } },
    });

    const aFile = JSON.parse(readFileSync(pathForTenant(TENANT_A), 'utf-8'));
    const bFile = JSON.parse(readFileSync(pathForTenant(TENANT_B), 'utf-8'));
    expect(aFile.rules).toHaveLength(1);
    expect(aFile.rules[0].name).toBe('a-rule');
    expect(bFile.rules).toHaveLength(1);
    expect(bFile.rules[0].name).toBe('b-rule');
    expect(existsSync(pathForTenant(LOCAL_TENANT))).toBe(false);
  });

  it("delete cannot remove another tenant's rule", () => {
    const store = createCustomRuleStore({ pathFor: pathForTenant, auditPath });
    const ruleA = store.deploy(TENANT_A, {
      name: 'a-only',
      evalType: 'safety',
      definition: { name: 'a-only', type: 'regex_no_match', config: { pattern: 'x' } },
    });

    // Tenant-B can't see or delete tenant-A's rule.
    expect(store.get(TENANT_B, ruleA.id)).toBeUndefined();
    expect(store.delete(TENANT_B, ruleA.id)).toBe(false);
    // Tenant-A still has the rule intact.
    expect(store.get(TENANT_A, ruleA.id)?.name).toBe('a-only');
  });

  it("setEnabled cannot toggle another tenant's rule", () => {
    const store = createCustomRuleStore({ pathFor: pathForTenant, auditPath });
    const ruleA = store.deploy(TENANT_A, {
      name: 'a-toggle',
      evalType: 'safety',
      definition: { name: 'a-toggle', type: 'regex_no_match', config: { pattern: 'x' } },
    });

    expect(store.setEnabled(TENANT_B, ruleA.id, false)).toBeUndefined();
    expect(store.enabledRules(TENANT_A).map((r) => r.name)).toEqual(['a-toggle']);
  });

  it('enabledRules respects tenant scope', () => {
    const store = createCustomRuleStore({ pathFor: pathForTenant, auditPath });
    const ruleA = store.deploy(TENANT_A, {
      name: 'a',
      evalType: 'safety',
      definition: { name: 'a', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    store.deploy(TENANT_B, {
      name: 'b',
      evalType: 'safety',
      definition: { name: 'b', type: 'regex_no_match', config: { pattern: 'y' } },
    });
    store.setEnabled(TENANT_A, ruleA.id, false);

    expect(store.enabledRules(TENANT_A)).toEqual([]);
    expect(store.enabledRules(TENANT_B).map((r) => r.name)).toEqual(['b']);
  });

  it('audit log entries carry the resolved tenant id (not hardcoded "local")', () => {
    const store = createCustomRuleStore({ pathFor: pathForTenant, auditPath });
    store.deploy(TENANT_A, {
      name: 'audit-a',
      evalType: 'safety',
      definition: { name: 'audit-a', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    store.deploy(TENANT_B, {
      name: 'audit-b',
      evalType: 'safety',
      definition: { name: 'audit-b', type: 'regex_no_match', config: { pattern: 'y' } },
    });

    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    const entryA = JSON.parse(lines[0]);
    const entryB = JSON.parse(lines[1]);
    expect(entryA.tenantId).toBe('tenant-a');
    expect(entryA.ruleName).toBe('audit-a');
    expect(entryB.tenantId).toBe('tenant-b');
    expect(entryB.ruleName).toBe('audit-b');
  });

  it('LOCAL_TENANT continues to use the v0.4 file path (zero migration)', () => {
    // Spot-check the default `defaultPathFor` semantics by NOT passing
    // a `pathFor` factory — uses the production default which lives in
    // ~/.iris/. Verify it resolves to a path with `/.iris/custom-rules.json`
    // for LOCAL_TENANT and `/.iris/custom-rules-<id>.json` otherwise.
    const store = createCustomRuleStore({ auditPath });
    expect(store.pathFor(LOCAL_TENANT)).toMatch(/[\\/]\.iris[\\/]custom-rules\.json$/);
    expect(store.pathFor(TENANT_A)).toMatch(/[\\/]\.iris[\\/]custom-rules-tenant-a\.json$/);
  });

  it('sanitizes tenant ids to prevent directory traversal', () => {
    const store = createCustomRuleStore({ auditPath });
    // The TenantId brand doesn't enforce a charset; the store does.
    const evil = asTenantId('../../etc/passwd');
    const path = store.pathFor(evil);
    // Path must NOT escape ~/.iris/ — the slashes/dots get sanitized to underscores.
    expect(path).toMatch(/[\\/]\.iris[\\/]custom-rules-[a-zA-Z0-9._]+\.json$/);
    expect(path).not.toContain('etc/passwd');
    expect(path).not.toMatch(/\.\.[\\/]/);
  });
});
