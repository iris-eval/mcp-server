import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regexBacktrackingBudgetExceeded } from '../../../src/eval/rules/regex-budget.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

/*
 * safe-regex2 is a star-height heuristic: it catches EXPONENTIAL blowup and
 * nothing else. `a*a*a*a*a*b` is judged SAFE by it while taking 156ms on 40
 * characters and 237ms on 60 — polynomial, and more than enough to wedge a
 * single-threaded server on realistic agent output. Deployed rules are
 * re-registered at every startup, so such a pattern survives a restart.
 */

let tmpDir: string;
let rulesPath: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-budget-'));
  rulesPath = join(tmpDir, 'custom-rules.json');
  auditPath = join(tmpDir, 'audit.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('regexBacktrackingBudgetExceeded', () => {
  it('rejects the polynomial pattern safe-regex2 passes', () => {
    expect(regexBacktrackingBudgetExceeded('a*a*a*a*a*b')).toMatch(/superlinear backtracking/);
  });

  it('accepts ordinary patterns', () => {
    for (const source of [
      '\\$\\d+',
      '^[A-Z][a-z]+$',
      'password|secret|token',
      '\\b\\d{3}-\\d{2}-\\d{4}\\b',
      '[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\\.){1,8}[A-Z]{2,24}',
    ]) {
      expect(regexBacktrackingBudgetExceeded(source), `${source} was wrongly rejected`).toBeNull();
    }
  });

  it('returns null for a syntactically invalid pattern (reported elsewhere)', () => {
    // Syntax errors get their own, clearer message at the call site — this
    // probe must not relabel a broken pattern as a performance problem.
    expect(regexBacktrackingBudgetExceeded('(')).toBeNull();
  });

  it('is itself fast — it never runs a candidate against a large input', () => {
    const started = Date.now();
    regexBacktrackingBudgetExceeded('a*a*a*a*a*b');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('deploy rejects superlinear patterns end-to-end', () => {
  it('refuses to persist a rule carrying a polynomial pattern', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    expect(() =>
      store.deploy(LOCAL_TENANT, {
        name: 'redos-bypass',
        description: 'passes safe-regex2, hangs the server',
        evalType: 'custom',
        severity: 'medium',
        definition: {
          name: 'redos-bypass',
          type: 'regex_match',
          config: { pattern: 'a*a*a*a*a*b' },
        },
      } as Parameters<typeof store.deploy>[1]),
    ).toThrow(/superlinear backtracking/);

    expect(store.list(LOCAL_TENANT)).toEqual([]);
  });

  it('still accepts a normal pattern', () => {
    const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
    const rule = store.deploy(LOCAL_TENANT, {
      name: 'no-prices',
      description: 'sales agent must not quote prices',
      evalType: 'safety',
      severity: 'high',
      definition: { name: 'no-prices', type: 'regex_no_match', config: { pattern: '\\$\\d+' } },
    } as Parameters<typeof store.deploy>[1]);
    expect(rule.name).toBe('no-prices');
  });
});
