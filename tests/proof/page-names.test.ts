/**
 * The truthbase names rules in camelCase (evalRules.names); the proof runner keys results by
 * registry name (snake_case). The /proof page compares them, and on 2026-09-04 that comparison
 * called all 13 measured rules "not yet in the table". This pins the two spellings to each other
 * and pins the proof's version stamp to the package version the truthbase carries.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const claims = JSON.parse(readFileSync(join(__dirname, '..', '..', '.claims.json'), 'utf-8')) as {
  version: { mcpServer: string };
  evalRules: { names: string[] };
  proof?: { version?: string; rules: Array<{ name: string }> };
};
const toSnake = (s: string): string => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('proof page name and version pins', () => {
  it('every measured rule name maps onto a truthbase rule name and back', () => {
    expect(claims.proof, 'the truthbase carries a proof field').toBeDefined();
    const measured = claims.proof!.rules.map((r) => r.name);
    const names = claims.evalRules.names;
    for (const m of measured) expect(names, `proof rule ${m}`).toContain(toCamel(m));
    for (const n of names) expect(measured, `truthbase rule ${n}`).toContain(toSnake(n));
  });

  it('the proof results carry the version the truthbase carries', () => {
    expect(claims.proof!.version).toBe(claims.version.mcpServer);
  });
});
