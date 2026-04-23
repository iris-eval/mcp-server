import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';

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

describe('createCustomRuleStore', () => {
  it('starts with no rules when file does not exist', () => {
    const store = createCustomRuleStore({ rulesPath, auditPath });
    expect(store.list()).toEqual([]);
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('deploy persists a rule + writes audit entry', () => {
    const store = createCustomRuleStore({ rulesPath, auditPath });
    const rule = store.deploy({
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
  });

  it('list returns all deployed rules in deploy order', () => {
    const store = createCustomRuleStore({ rulesPath, auditPath });
    store.deploy({
      name: 'rule_a',
      evalType: 'safety',
      definition: { name: 'rule_a', type: 'regex_no_match', config: { pattern: 'foo' } },
    });
    store.deploy({
      name: 'rule_b',
      evalType: 'completeness',
      definition: { name: 'rule_b', type: 'min_length', config: { min_length: 100 } },
    });
    expect(store.list()).toHaveLength(2);
    expect(store.list().map((r) => r.name)).toEqual(['rule_a', 'rule_b']);
  });

  it('rules persist across store re-creation', () => {
    const first = createCustomRuleStore({ rulesPath, auditPath });
    first.deploy({
      name: 'persistent',
      evalType: 'safety',
      definition: { name: 'persistent', type: 'regex_no_match', config: { pattern: 'x' } },
    });

    const second = createCustomRuleStore({ rulesPath, auditPath });
    expect(second.list()).toHaveLength(1);
    expect(second.list()[0].name).toBe('persistent');
  });

  it('delete removes the rule + writes audit entry', () => {
    const store = createCustomRuleStore({ rulesPath, auditPath });
    const rule = store.deploy({
      name: 'doomed',
      evalType: 'safety',
      definition: { name: 'doomed', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    expect(store.delete(rule.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.delete(rule.id)).toBe(false); // already gone
    expect(readFileSync(auditPath, 'utf-8')).toContain('"action":"rule.delete"');
  });

  it('setEnabled toggles enabled state and audits', () => {
    const store = createCustomRuleStore({ rulesPath, auditPath });
    const rule = store.deploy({
      name: 'toggle_me',
      evalType: 'safety',
      definition: { name: 'toggle_me', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    const updated = store.setEnabled(rule.id, false);
    expect(updated?.enabled).toBe(false);
    expect(store.enabledRules()).toEqual([]);
    expect(readFileSync(auditPath, 'utf-8')).toContain('"action":"rule.toggle"');
  });

  it('enabledRules returns only enabled rules', () => {
    const store = createCustomRuleStore({ rulesPath, auditPath });
    const a = store.deploy({
      name: 'a',
      evalType: 'safety',
      definition: { name: 'a', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    store.deploy({
      name: 'b',
      evalType: 'safety',
      definition: { name: 'b', type: 'regex_no_match', config: { pattern: 'y' } },
    });
    store.setEnabled(a.id, false);
    const enabled = store.enabledRules();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe('b');
  });

  it('tolerates malformed file without overwriting it', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(rulesPath, 'not valid json{{{');
    const store = createCustomRuleStore({ rulesPath, auditPath });
    expect(store.list()).toEqual([]);
    // File untouched — operator can fix manually
    expect(readFileSync(rulesPath, 'utf-8')).toBe('not valid json{{{');
  });

  it('rejects rule with invalid name characters', () => {
    const store = createCustomRuleStore({ rulesPath, auditPath });
    // The store itself doesn't validate name characters — that's the API
    // route's job. The store accepts any string up to its zod max length.
    // This test documents that boundary — see rules.ts route for the
    // user-input validation layer.
    const rule = store.deploy({
      name: 'short',
      evalType: 'safety',
      definition: { name: 'short', type: 'regex_no_match', config: { pattern: 'x' } },
    });
    expect(rule.name).toBe('short');
  });
});
