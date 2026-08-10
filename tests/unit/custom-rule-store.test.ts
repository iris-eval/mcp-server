import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

let tmpDir: string;
let rulesPath: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-rule-'));
  rulesPath = join(tmpDir, 'custom-rules.json');
  auditPath = join(tmpDir, 'audit.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createCustomRuleStore (single-tenant / OSS)', () => {
  // Regression: `config` was `z.record(z.unknown())`, so a rule missing the
  // field its type needs deployed cleanly and then failed EVERY evaluation
  // forever, silently deflating aggregate scores. Reject at deploy, naming
  // the offending field, so the mistake surfaces once instead of corrupting
  // every eval that follows.
  describe('deploy-time config validation', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['min_length', {}, /min_length rule requires/],
      ['max_length', {}, /max_length rule requires/],
      ['contains_keywords', {}, /contains_keywords rule requires/],
      ['excludes_keywords', { keywords: [] }, /excludes_keywords rule requires/],
      ['cost_threshold', {}, /cost_threshold rule requires/],
      ['cost_threshold', { max_cost: -1 }, /cost_threshold rule requires/],
      ['regex_match', {}, /requires config.pattern/],
      ['regex_match', { pattern: '(' }, /Invalid regex syntax/],
      ['regex_match', { pattern: '(a+)+$' }, /catastrophic backtracking/],
    ];

    for (const [type, config, expected] of cases) {
      it(`rejects ${type} with config ${JSON.stringify(config)}`, () => {
        const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
        expect(() =>
          store.deploy(LOCAL_TENANT, {
            name: `bad-${type}`,
            description: 'invalid config',
            evalType: 'custom',
            severity: 'medium',
            definition: { name: `bad-${type}`, type, config },
          } as Parameters<typeof store.deploy>[1]),
        ).toThrow(expected);
      });
    }

    it('accepts the config spellings our docs shipped (min, max_usd)', () => {
      const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
      expect(() =>
        store.deploy(LOCAL_TENANT, {
          name: 'documented-min',
          description: 'uses the key docs/api-reference.md taught',
          evalType: 'custom',
          severity: 'medium',
          definition: { name: 'documented-min', type: 'min_length', config: { min: 20 } },
        } as Parameters<typeof store.deploy>[1]),
      ).not.toThrow();

      expect(() =>
        store.deploy(LOCAL_TENANT, {
          name: 'documented-cost',
          description: 'uses the key deploy_rule described',
          evalType: 'custom',
          severity: 'medium',
          definition: { name: 'documented-cost', type: 'cost_threshold', config: { max_usd: 0.5 } },
        } as Parameters<typeof store.deploy>[1]),
      ).not.toThrow();
    });

    it('accepts cost_threshold max_cost of 0 (must-be-free is a real threshold)', () => {
      const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
      expect(() =>
        store.deploy(LOCAL_TENANT, {
          name: 'free-only',
          description: 'zero is valid',
          evalType: 'cost',
          severity: 'low',
          definition: { name: 'free-only', type: 'cost_threshold', config: { max_cost: 0 } },
        } as Parameters<typeof store.deploy>[1]),
      ).not.toThrow();
    });
  });

  it('starts with no rules when file does not exist', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    expect(store.list(LOCAL_TENANT)).toEqual([]);
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('deploy persists a rule + writes audit entry', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const rule = store.deploy(LOCAL_TENANT, {
      name: 'no_pricing',
      description: 'Sales agent must not quote prices',
      evalType: 'safety',
      severity: 'high',
      definition: {
        name: 'no_pricing',
        type: 'regex_no_match',
        config: { pattern: '\\$\\d+' },
      },
      sourceMomentId: 'trace-abc',
    });

    expect(rule.id).toMatch(/^rule-[a-f0-9]+$/);
    expect(rule.version).toBe(1);
    expect(rule.enabled).toBe(true);
    expect(rule.severity).toBe('high');
    expect(rule.sourceMomentId).toBe('trace-abc');

    expect(existsSync(rulesPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(rulesPath, 'utf-8'));
    expect(persisted.version).toBe(1);
    expect(persisted.rules).toHaveLength(1);
    expect(persisted.rules[0].name).toBe('no_pricing');

    expect(existsSync(auditPath)).toBe(true);
    const audit = readFileSync(auditPath, 'utf-8');
    expect(audit).toContain('"action":"rule.deploy"');
    expect(audit).toContain('"ruleId":"' + rule.id + '"');
    expect(audit).toContain('"sourceMomentId":"trace-abc"');
    expect(audit).toContain('"tenantId":"local"');
  });

  it('list returns all deployed rules in deploy order', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    store.deploy(LOCAL_TENANT, {
      name: 'rule_a',
      evalType: 'safety',
      definition: { name: 'rule_a', type: 'regex_no_match', config: { pattern: 'foo' } },
    });
    store.deploy(LOCAL_TENANT, {
      name: 'rule_b',
      evalType: 'completeness',
      definition: { name: 'rule_b', type: 'min_length', config: { min_length: 100 } },
    });
    expect(store.list(LOCAL_TENANT)).toHaveLength(2);
    expect(store.list(LOCAL_TENANT).map((r) => r.name)).toEqual(['rule_a', 'rule_b']);
  });

  it('rules persist across store re-creation', () => {
    const first = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    first.deploy(LOCAL_TENANT, {
      name: 'persistent',
      evalType: 'safety',
      definition: { name: 'persistent', type: 'regex_no_match', config: { pattern: 'x' } },
    });

    const second = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    expect(second.list(LOCAL_TENANT)).toHaveLength(1);
    expect(second.list(LOCAL_TENANT)[0].name).toBe('persistent');
  });

  it('delete removes the rule + writes audit entry', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const rule = store.deploy(LOCAL_TENANT, {
      name: 'doomed',
      evalType: 'safety',
      definition: { name: 'doomed', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    expect(store.delete(LOCAL_TENANT, rule.id)).toBe(true);
    expect(store.list(LOCAL_TENANT)).toEqual([]);
    expect(store.delete(LOCAL_TENANT, rule.id)).toBe(false); // already gone
    expect(readFileSync(auditPath, 'utf-8')).toContain('"action":"rule.delete"');
  });

  it('setEnabled toggles enabled state and audits', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const rule = store.deploy(LOCAL_TENANT, {
      name: 'toggle_me',
      evalType: 'safety',
      definition: { name: 'toggle_me', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    const updated = store.setEnabled(LOCAL_TENANT, rule.id, false);
    expect(updated?.enabled).toBe(false);
    expect(store.enabledRules(LOCAL_TENANT)).toEqual([]);
    expect(readFileSync(auditPath, 'utf-8')).toContain('"action":"rule.toggle"');
  });

  it('enabledRules returns only enabled rules', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const a = store.deploy(LOCAL_TENANT, {
      name: 'a',
      evalType: 'safety',
      definition: { name: 'a', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    store.deploy(LOCAL_TENANT, {
      name: 'b',
      evalType: 'safety',
      definition: { name: 'b', type: 'regex_no_match', config: { pattern: 'y' } },
    });
    store.setEnabled(LOCAL_TENANT, a.id, false);
    const enabled = store.enabledRules(LOCAL_TENANT);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe('b');
  });

  it('tolerates malformed file without overwriting it', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(rulesPath, 'not valid json{{{');
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    expect(store.list(LOCAL_TENANT)).toEqual([]);
    // File untouched — operator can fix manually
    expect(readFileSync(rulesPath, 'utf-8')).toBe('not valid json{{{');
  });

  it('rejects rule with invalid name characters', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    // The store itself doesn't validate name characters — that's the API
    // route's job. The store accepts any string up to its zod max length.
    // This test documents that boundary — see rules.ts route for the
    // user-input validation layer.
    const rule = store.deploy(LOCAL_TENANT, {
      name: 'short',
      evalType: 'safety',
      definition: { name: 'short', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    expect(rule.name).toBe('short');
  });
});

/*
 * Regression: a single unparseable rule used to wipe the whole file.
 *
 * loadRulesFromDisk validated the entire array with one safeParse and
 * returned [] if ANY element failed. That empty result was cached, and the
 * next deploy called persist(), which wrote {version:1, rules:[]} over the
 * file — destroying every valid rule alongside the bad one, with no error
 * anywhere. The old comment claimed "do NOT overwrite the file"; the write
 * path did not honour it.
 *
 * Reachable in the field: DefinitionSchema's superRefine runs on READ as
 * well as WRITE, and eval/rules/custom.ts documents that rules predating
 * that validation (e.g. {type:'min_length', config:{}}) already exist in
 * users' files.
 */
describe('lenient load — one bad rule must not destroy the file', () => {
  const validRule = {
    id: 'rule-keepme',
    name: 'keep-me',
    description: 'a perfectly good rule',
    evalType: 'custom',
    severity: 'medium',
    definition: { name: 'keep-me', type: 'min_length', config: { min_length: 10 } },
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
  // Exactly the legacy shape custom.ts says is already on disk.
  const legacyRule = {
    id: 'rule-legacy',
    name: 'legacy-no-config',
    description: 'deployed before config validation existed',
    evalType: 'custom',
    severity: 'medium',
    definition: { name: 'legacy-no-config', type: 'min_length', config: {} },
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };

  it('keeps the valid rules and quarantines only the invalid one', () => {
    writeFileSync(rulesPath, JSON.stringify({ version: 1, rules: [validRule, legacyRule] }));
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const listed = store.list(LOCAL_TENANT);
    expect(listed.map((r) => r.id)).toEqual(['rule-keepme']);
  });

  it('a later deploy does NOT delete the valid rule or the quarantined one', () => {
    writeFileSync(rulesPath, JSON.stringify({ version: 1, rules: [validRule, legacyRule] }));
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    store.deploy(LOCAL_TENANT, {
      name: 'brand-new',
      description: 'deployed after the bad rule was already on disk',
      evalType: 'custom',
      severity: 'medium',
      definition: { name: 'brand-new', type: 'min_length', config: { min_length: 5 } },
    } as Parameters<typeof store.deploy>[1]);

    const onDisk = JSON.parse(readFileSync(rulesPath, 'utf-8'));
    const ids = onDisk.rules.map((r: { id: string }) => r.id);
    expect(ids).toContain('rule-keepme'); // survived — this is the data-loss guard
    expect(ids).toContain('rule-legacy'); // preserved verbatim, never activated
    expect(onDisk.rules).toHaveLength(3);
  });

  it('refuses to write over a file it could not parse at all', () => {
    writeFileSync(rulesPath, '{ this is not json');
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    expect(store.list(LOCAL_TENANT)).toEqual([]);
    expect(() =>
      store.deploy(LOCAL_TENANT, {
        name: 'should-not-land',
        description: 'writing here would destroy unreadable content',
        evalType: 'custom',
        severity: 'medium',
        definition: { name: 'should-not-land', type: 'min_length', config: { min_length: 5 } },
      } as Parameters<typeof store.deploy>[1]),
    ).toThrow(/could not be parsed/);
    // The unreadable file is still exactly as the user left it.
    expect(readFileSync(rulesPath, 'utf-8')).toBe('{ this is not json');
  });
});
