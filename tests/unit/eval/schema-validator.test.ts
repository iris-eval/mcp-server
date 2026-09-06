/*
 * The hardened validator (arc 4, A4-4).
 *
 * A tools catalogue is code someone else wrote, arriving over a wire that
 * accepts traces: ajv generates JavaScript from a schema, compiles it with
 * `new Function`, and runs it on the main thread. So every rung of the guard
 * ladder is exercised here against a REAL payload rather than described —
 * the lesson `regex-sandbox.ts` records is that a guard which was reasoned
 * about and never fired is not a guard.
 *
 * The four assertions that matter most, in order:
 *   1. a catastrophic pattern is refused BEFORE it is compiled;
 *   2. a rejected schema leaves the rule UNCHECKED, never silently valid;
 *   3. the validator does not mutate the instance it validates;
 *   4. the declared ajv range is the SDK's, so one copy resolves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_TOOL_INPUT_BYTES,
  MAX_TOOL_SCHEMA_BYTES,
  MAX_TOOL_SCHEMA_DEPTH,
  checkArguments,
  compileToolSchema,
  resetSchemaCache,
} from '../../../src/eval/schema-validator.js';

const root = resolve(__dirname, '..', '..', '..');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(root, rel), 'utf-8')) as Record<string, unknown>;

function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < depth; i++) node = { type: 'object', properties: { a: node } };
  return node;
}

describe('the schema guard ladder', () => {
  beforeEach(() => {
    resetSchemaCache();
  });

  it('an ordinary tool schema compiles and decides', () => {
    const compiled = compileToolSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    expect(compiled.ok).toBe(true);
    expect(checkArguments(compiled, { path: 'a.ts' }).state).toBe('valid');
    const bad = checkArguments(compiled, { path: 7 });
    expect(bad.state).toBe('invalid');
    expect(bad.instancePath).toBe('/path');
    expect(bad.keyword).toBe('type');
  });

  it('a catastrophic pattern is refused before ajv ever inlines it', () => {
    const compiled = compileToolSchema({ type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.reason).toMatch(/star height|backtrack/i);
  });

  it('a catastrophic pattern hidden in patternProperties is refused too', () => {
    const compiled = compileToolSchema({ type: 'object', patternProperties: { '^(x+x+)+y$': { type: 'string' } } });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.reason).toMatch(/star height|backtrack/i);
  });

  it('a remote reference is impossible by construction, and says so', () => {
    const compiled = compileToolSchema({ $ref: 'https://example.com/schema.json' });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.reason).toContain('nothing is ever fetched');
  });

  it('a local reference within the caps is allowed', () => {
    const compiled = compileToolSchema({
      type: 'object',
      properties: { a: { $ref: '#/$defs/leaf' } },
      $defs: { leaf: { type: 'string' } },
    });
    expect(compiled.ok).toBe(true);
  });

  it('the dynamic and recursive keywords are refused, because their depth cannot be bounded', () => {
    for (const key of ['$id', '$dynamicRef', '$recursiveRef', '$vocabulary']) {
      const compiled = compileToolSchema({ type: 'object', [key]: 'x' });
      expect(compiled.ok, key).toBe(false);
    }
  });

  it('a schema past the depth or byte cap is refused', () => {
    const deep = compileToolSchema(nest(MAX_TOOL_SCHEMA_DEPTH + 4));
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.reason).toMatch(/nests|nodes/);

    const fat = compileToolSchema({ type: 'object', description: 'x'.repeat(MAX_TOOL_SCHEMA_BYTES + 1) });
    expect(fat.ok).toBe(false);
    if (!fat.ok) expect(fat.reason).toContain('bytes');
  });

  it('a rejected schema leaves the call UNCHECKED, never silently valid', () => {
    const compiled = compileToolSchema({ $ref: 'https://example.com/x.json' });
    const check = checkArguments(compiled, { anything: true });
    expect(check.state).toBe('unchecked');
    expect(check.reason).toBeTruthy();
  });

  it('the validator never mutates the instance it validates', () => {
    // coerceTypes, useDefaults and removeAdditional are all off: a validator
    // that rewrote the input would change what the repeat detector hashes.
    const compiled = compileToolSchema({
      type: 'object',
      properties: { n: { type: 'number', default: 42 }, s: { type: 'string' } },
      additionalProperties: false,
    });
    const input: Record<string, unknown> = { s: '7' };
    checkArguments(compiled, input);
    expect(input).toEqual({ s: '7' });
  });

  it('format is an annotation here, not a constraint — nothing reaches a format library', () => {
    const compiled = compileToolSchema({ type: 'object', properties: { u: { type: 'string', format: 'uri' } } });
    expect(compiled.ok).toBe(true);
    expect(checkArguments(compiled, { u: 'not a uri at all' }).state).toBe('valid');
  });

  it('an over-size instance is left unchecked rather than failed', () => {
    const compiled = compileToolSchema({ type: 'object', properties: { blob: { type: 'string' } } });
    const check = checkArguments(compiled, { blob: 'x'.repeat(MAX_TOOL_INPUT_BYTES + 10) });
    expect(check.state).toBe('unchecked');
  });

  it('rejections are cached, which is what makes the regex probe affordable', () => {
    const hostile = { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } };
    const first = compileToolSchema(hostile);
    const second = compileToolSchema(hostile);
    // Same object identity means the second call never re-probed the pattern.
    expect(second).toBe(first);
  });

  it('a hostile catalogue costs bounded wall time even when every schema is refused', () => {
    const started = Date.now();
    for (let i = 0; i < 40; i++) {
      compileToolSchema({ type: 'object', properties: { s: { type: 'string', pattern: `^(a+)+${i}$` } } });
    }
    // Forty distinct exponential patterns. Star height rejects each one
    // statically, so none reaches the probe — which is the difference
    // between forty seconds and a few hundred milliseconds, and the reason
    // that rung exists ahead of the expensive one.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('every schema that passes the static caps compiles and validates inside the budget', () => {
    // The static walk is the real boundary against blowup, so the property
    // worth checking is that nothing which survives it is slow.
    const leaf = fc.constantFrom<Record<string, unknown>>({ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'string', enum: ['a', 'b', 'c'] });
    const schema = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small' },
        leaf,
        fc.record({ type: fc.constant('array'), items: tie('node') }),
        fc
          .dictionary(fc.string({ minLength: 1, maxLength: 6 }), tie('node'), { maxKeys: 4 })
          .map((properties) => ({ type: 'object', properties })),
      ),
    })).node;

    fc.assert(
      fc.property(schema, (s) => {
        const started = Date.now();
        const compiled = compileToolSchema(s as Record<string, unknown>);
        if (compiled.ok) checkArguments(compiled, { a: 1, b: 'x' });
        return Date.now() - started < 1_000;
      }),
      { numRuns: 60 },
    );
  });
});

describe('the ajv dependency does not fork', () => {
  it('the declared range is the SDK\'s own, so npm dedupes to one copy', () => {
    const ours = readJson('package.json') as { dependencies: Record<string, string> };
    const sdk = readJson('node_modules/@modelcontextprotocol/sdk/package.json') as { dependencies: Record<string, string> };
    /*
     * Byte-identical on purpose. A narrower or newer range risks two copies
     * in the tree, and two ajv copies means two code-generation surfaces and
     * a doubled advisory footprint for a package that compiles caller input.
     */
    expect(ours.dependencies.ajv).toBe(sdk.dependencies.ajv);
  });

  it('ajv-formats is not a dependency, because formats are not validated', () => {
    const ours = readJson('package.json') as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(ours.dependencies['ajv-formats']).toBeUndefined();
    expect(ours.devDependencies['ajv-formats']).toBeUndefined();
  });
});
