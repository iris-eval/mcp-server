/*
 * The hardened validator.
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
import type { ValidateFunction } from 'ajv';
import {
  MAX_TOOL_INPUT_BYTES,
  MAX_TOOL_SCHEMA_BYTES,
  MAX_TOOL_SCHEMA_DEPTH,
  checkArguments,
  compileToolSchema,
  resetSchemaCache,
} from '../../../src/eval/schema-validator.js';
import { createCustomRule } from '../../../src/eval/rules/custom.js';
import { validToolArguments } from '../../../src/eval/rules/completeness.js';
import { MAX_JSON_TEXT_DEPTH } from '../../../src/utils/element-count.js';
import type { EvalContext } from '../../../src/types/eval.js';
import { cpuMs } from '../../helpers/cpu-time.js';

const root = resolve(__dirname, '..', '..', '..');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(root, rel), 'utf-8')) as Record<string, unknown>;

function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < depth; i++) node = { type: 'object', properties: { a: node } };
  return node;
}

/**
 * A schema that refers to itself through a ring of `calls` definitions: each
 * hands on to the next, and the last descends into `a` and back to the
 * first. Its validator makes `calls` calls for each level of a value. One
 * call a level is a tree's own schema; a schema written with wrappers has a
 * few.
 */
function ring(calls: number): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < calls - 1; i++) defs[`n${i}`] = { allOf: [{ $ref: `#/$defs/n${i + 1}` }] };
  defs[`n${calls - 1}`] = { type: ['object', 'number'], properties: { a: { $ref: '#/$defs/n0' } } };
  return { $defs: defs, $ref: '#/$defs/n0' };
}

/** `{"a":{"a":…1}}`, `levels` objects deep. */
function nested(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
}

/** The same as text, built without a function that calls itself. */
const nestedText = (levels: number, innermost = '1'): string => `${'{"a":'.repeat(levels)}${innermost}${'}'.repeat(levels)}`;

/** A definition that is only itself: its validator never returns, on any value. */
const ONLY_ITSELF = { $defs: { a: { allOf: [{ $ref: '#/$defs/a' }] } }, $ref: '#/$defs/a' };

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

  it('a schema marked $async is refused: its validator answers with a promise, which read every value as valid and, rejected, ended the process', async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listen);
    try {
      const shape = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
      // Any value but false at the root makes ajv's validator answer with a promise.
      for (const marked of [true, 'yes', 1]) {
        const compiled = compileToolSchema({ $async: marked, ...shape });
        expect(compiled.ok, String(marked)).toBe(false);
        if (!compiled.ok) expect(compiled.reason).toBe('the inputSchema is marked $async, which makes its check answer later; Iris checks arguments at once, so it is not compiled');
        expect(checkArguments(compiled, { q: 1 })).toMatchObject({ state: 'unchecked' });
        expect(checkArguments(compiled, { q: 'x' })).toMatchObject({ state: 'unchecked' });
      }
      // false is a schema like any other; below the root, ajv refuses the keyword itself.
      expect(checkArguments(compileToolSchema({ $async: false, ...shape }), { q: 1 })).toEqual({ state: 'invalid', instancePath: '/q', keyword: 'type' });
      const below = compileToolSchema({ ...shape, properties: { q: { $async: true, type: 'string' } } });
      expect(below.ok).toBe(false);
      if (!below.ok) expect(below.reason).toBe('the inputSchema did not compile: async schema in sync schema');
      // A turn of the event loop: no promise was left rejected with nobody to catch it.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listen);
    }
  });

  it('valid_tool_arguments and a json_schema rule say a schema marked $async was not compiled, where every call and every output passed', () => {
    const schema = { $async: true, type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const valid = validToolArguments.evaluate({ output: 'done', toolCalls: [{ tool_name: 't', input: { q: 1 } }], tools: [{ name: 't', inputSchema: schema }] } as EvalContext);
    expect(valid).toMatchObject({ passed: false, skipped: true, skipClass: 'config_invalid' });
    expect(valid.message).toContain('t (the inputSchema is marked $async');
    const rule = createCustomRule({ name: 'j', type: 'json_schema', config: { schema } });
    const answer = rule.evaluate({ output: '{"q":1}' } as EvalContext);
    expect(answer.passed).toBe(false);
    expect(answer.message).toContain('the inputSchema is marked $async');
  });

  it('the changelog and the security record say a schema marked $async is refused, and why', () => {
    const flat = (rel: string): string => readFileSync(resolve(root, rel), 'utf-8').replace(/\r?\n\s*/g, ' ');
    expect(flat('CHANGELOG.md')).toContain(
      "- **A tool schema marked `$async` is refused: it passed every call it checked, and could stop the server.** ajv compiles a schema whose root carries `$async` (any value but `false`) into a validator that answers later, with a promise, and `valid_tool_arguments` and a custom `json_schema` rule read that answer as a pass whatever the value held; an invalid value could end the process. Such a schema is now refused with the reason, as any schema Iris will not compile is: a call is not checked against it, a `json_schema` rule that carries one is refused at deploy, and one deployed before is kept on disk and not run (`list_rules` lists it among the quarantined entries). Below the root, ajv refuses `$async` itself.",
    );
    expect(flat('SECURITY-EXPOSURE.md')).toContain(
      'A schema whose root carries `$async` (any value but `false`) is refused once compiled: its validator answers with a promise, which a check that answers at once would read as a pass, and whose rejection nothing would catch. ajv refuses `$async` below the root itself.',
    );
    expect(flat('docs/custom-rules.md')).toContain(
      'Schemas go through the same guard ladder a tools catalogue does: size, depth and node caps, local `$ref` only, star height and a backtracking probe on every `pattern`, and no `$async`, since a check here answers at once.',
    );
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

  it('a schema that refers to itself decides on a nested value, yes and no', () => {
    const own = compileToolSchema(ring(1));
    expect(own.ok).toBe(true);
    expect(checkArguments(own, nested(64)).state).toBe('valid');
    const bad = checkArguments(own, { a: { a: 'x' } });
    expect(bad.state).toBe('invalid');
    expect(bad.instancePath).toBe('/a/a');
    // A ring of a hundred definitions makes a hundred calls a level: four levels are four hundred calls.
    const long = compileToolSchema(ring(100));
    expect(long.ok).toBe(true);
    expect(checkArguments(long, nested(4)).state).toBe('valid');
  });

  it('a check that runs out of stack leaves the call unchecked and says why: it is not thrown out of the rule', () => {
    /*
     * Neither the size of the value nor the caps on the schema bound how
     * deep the validator calls itself. 512 levels under a ring of a hundred
     * are 51,200 calls, four times what an empty function reaches before
     * the stack ends.
     */
    const long = compileToolSchema(ring(100));
    const ran = checkArguments(long, nested(512));
    expect(ran.state).toBe('unchecked');
    expect(ran.reason).toContain('ran out of stack');
    expect(ran.instancePath).toBeUndefined();

    // Under a definition that is only itself the validator never returns, on any value.
    const loop = compileToolSchema(ONLY_ITSELF);
    expect(loop.ok).toBe(true);
    expect(checkArguments(loop, { a: 1 })).toEqual({ state: 'unchecked', reason: expect.stringContaining('ran out of stack') });

    // The validator is whole afterwards: the next value is decided.
    expect(checkArguments(long, nested(4)).state).toBe('valid');
    expect(checkArguments(long, { a: 'x' }).state).toBe('invalid');
  });

  it('only the stack running out is answered so: any other failure of a validator is still thrown', () => {
    const broken = { ok: true as const, validate: (() => { throw new TypeError('not the stack'); }) as unknown as ValidateFunction };
    expect(() => checkArguments(broken, {})).toThrow(TypeError);
  });

  it('valid_tool_arguments answers when a check runs out of stack: the call is not judged and the reason is given', () => {
    const tools = [{ name: 't', inputSchema: ring(100) }];
    const alone = validToolArguments.evaluate({ output: 'done', toolCalls: [{ tool_name: 't', input: nested(512) }], tools } as EvalContext);
    expect(alone.passed).toBe(false);
    expect(alone.skipped).toBe(true);
    expect(alone.configInvalid).toBeFalsy();
    expect(alone.skipReason).toContain('t (the check ran out of stack');

    // Beside a call it can check, the rule decides on that one and counts the other as unchecked.
    const beside = validToolArguments.evaluate({ output: 'done', toolCalls: [{ tool_name: 't', input: nested(512) }, { tool_name: 't', input: nested(2) }], tools } as EvalContext);
    expect(beside.skipped).toBeFalsy();
    expect(beside.passed).toBe(true);
    expect(beside.message).toContain('1 of 2 checked');
  });

  it('rejections are cached, which is what makes the regex probe affordable', () => {
    const hostile = { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } };
    const first = compileToolSchema(hostile);
    const second = compileToolSchema(hostile);
    // Same object identity means the second call never re-probed the pattern.
    expect(second).toBe(first);
  });

  it('a hostile catalogue costs bounded time even when every schema is refused', () => {
    const cpu = cpuMs(() => {
      for (let i = 0; i < 40; i++) {
        compileToolSchema({ type: 'object', properties: { s: { type: 'string', pattern: `^(a+)+${i}$` } } });
      }
    });
    // Forty distinct exponential patterns. Star height rejects each one
    // statically, so none reaches the probe — which is the difference
    // between forty seconds and a few hundred milliseconds, and the reason
    // that rung exists ahead of the expensive one.
    expect(cpu).toBeLessThan(5_000);
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
        return (
          cpuMs(() => {
            const compiled = compileToolSchema(s as Record<string, unknown>);
            if (compiled.ok) checkArguments(compiled, { a: 1, b: 'x' });
          }) < 1_000
        );
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

describe('the json_schema custom rule type honours a configured schema', () => {
  it('with no schema it keeps exactly the pre-0.11.0 behaviour, and says the shape was not checked', () => {
    const rule = createCustomRule({ name: 'j', type: 'json_schema', config: {} });
    const r = rule.evaluate({ output: '{"anything": [1,2,3]}' } as EvalContext);
    expect(r.passed).toBe(true);
    // A deployment that has relied on this for months keeps its meaning, and
    // the message stops the pass from reading as a shape guarantee.
    expect(r.message).toContain('not checked');
  });

  it('with a schema it decides on the shape, naming the pointer and the keyword', () => {
    const rule = createCustomRule({
      name: 'j',
      type: 'json_schema',
      config: { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    });
    expect(rule.evaluate({ output: '{"id":"a"}' } as EvalContext).passed).toBe(true);
    const bad = rule.evaluate({ output: '{"id":7}' } as EvalContext);
    expect(bad.passed).toBe(false);
    expect(bad.message).toContain('/id');
    expect(bad.message).toContain('type');
  });

  it('a schema Iris will not compile is a config error, not a silent pass', () => {
    resetSchemaCache();
    const rule = createCustomRule({
      name: 'j',
      type: 'json_schema',
      config: { schema: { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } } },
    });
    const r = rule.evaluate({ output: '{"s":"aaa"}' } as EvalContext);
    expect(r.passed).toBe(false);
    expect(r.configInvalid ?? r.skipped).toBeTruthy();
  });

  it('an unparseable output still fails on the parse clause before the schema is consulted', () => {
    const rule = createCustomRule({ name: 'j', type: 'json_schema', config: { schema: { type: 'object' } } });
    const r = rule.evaluate({ output: 'not json' } as EvalContext);
    expect(r.passed).toBe(false);
    expect(r.message).toContain('not valid JSON');
  });

  it('an output is read as JSON down to the depth a JSON text is read to: at it the shape is judged, past it the rule says it was not', () => {
    /*
     * The output is a string, which is no level to the doors that measure
     * how deep a request nests, and a schema that refers to itself is
     * checked by a validator that calls itself for each level of the value.
     */
    const rule = createCustomRule({ name: 'j', type: 'json_schema', config: { schema: ring(1) } });
    const at = rule.evaluate({ output: nestedText(MAX_JSON_TEXT_DEPTH) } as EvalContext);
    expect(at.passed).toBe(true);
    expect(at.skipped).toBeUndefined();
    const wrongAt = rule.evaluate({ output: nestedText(MAX_JSON_TEXT_DEPTH, '"x"') } as EvalContext);
    expect(wrongAt.passed).toBe(false);
    expect(wrongAt.skipped).toBeUndefined();
    expect(wrongAt.message).toContain('type');

    for (const levels of [MAX_JSON_TEXT_DEPTH + 1, 4_000, 20_000]) {
      const past = rule.evaluate({ output: nestedText(levels) } as EvalContext);
      expect(past.passed).toBe(false);
      expect(past.skipped).toBe(true);
      expect(past.skipReason).toBe(`the output could not be checked: it nests more than ${MAX_JSON_TEXT_DEPTH} levels deep`);
      expect(past.message).toBe('Output shape not judged');
    }
  });

  it('with no schema nothing walks the value, so an output nested however deep is valid JSON as it was', () => {
    const rule = createCustomRule({ name: 'j', type: 'json_schema', config: {} });
    const r = rule.evaluate({ output: nestedText(20_000) } as EvalContext);
    expect(r.passed).toBe(true);
    expect(r.message).toContain('not checked');
  });

  it('answers when its schema is a definition that is only itself, on any output: the shape is not judged and the reason is given', () => {
    resetSchemaCache();
    const rule = createCustomRule({ name: 'j', type: 'json_schema', config: { schema: ONLY_ITSELF } });
    const r = rule.evaluate({ output: '{"a":1}' } as EvalContext);
    expect(r.passed).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain('the output could not be checked: the check ran out of stack');
  });
});
