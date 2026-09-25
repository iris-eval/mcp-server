/*
 * The JSONC editor behind `iris-eval install`: one member in, one member
 * out, and every other byte of a client's config left alone — comments
 * included, because Zed writes its settings file with a comment header and a
 * strict parser refused exactly that file.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detectStyle, parseTree, removeMember, setMember, toPlainJson, type ObjectNode } from '../../../src/cli/install/jsonc.js';

const root = (text: string): ObjectNode => {
  const node = parseTree(text);
  if (node.kind !== 'object') throw new Error('not an object');
  return node;
};
const plain = (text: string): unknown => JSON.parse(toPlainJson(text));

const ZED_DEFAULT = `// Zed settings
//
// For information on how to configure Zed, see the Zed
// documentation: https://zed.dev/docs/configuring-zed
{
  "ui_font_size": 16, // big enough
  "buffer_font_size": 15,
  /* theme block */
  "theme": {
    "mode": "system",
    "light": "One Light",
    "dark": "One Dark",
  },
}
`;

describe('parseTree / toPlainJson', () => {
  it('reads JSONC: line and block comments, trailing commas, a BOM', () => {
    expect(plain(ZED_DEFAULT)).toEqual({ ui_font_size: 16, buffer_font_size: 15, theme: { mode: 'system', light: 'One Light', dark: 'One Dark' } });
    expect(plain('\ufeff{"a": [1, 2,],}')).toEqual({ a: [1, 2] });
  });

  it('leaves comment markers and ",}" inside strings alone', () => {
    const text = '{"url": "https://x.dev//y", "s": "a,}", "t": "/* no */"}';
    expect(plain(text)).toEqual({ url: 'https://x.dev//y', s: 'a,}', t: '/* no */' });
    expect(root(text).members.map((m) => m.key)).toEqual(['url', 's', 't']);
  });

  it('refuses malformed input with a line number', () => {
    expect(() => parseTree('{\n  "a": 1\n  "b": 2\n}')).toThrow(/line 3/);
    expect(() => parseTree('{ "a": tru }')).toThrow(/unexpected/);
    expect(() => parseTree('{ "a": 1 } extra')).toThrow(/after the top-level value/);
    expect(() => parseTree('{ /* open')).toThrow(/unterminated comment/);
  });
});

describe('setMember', () => {
  it('adds a member to a commented file and keeps every comment and value', () => {
    const tree = root(ZED_DEFAULT);
    const out = setMember(ZED_DEFAULT, tree, 'context_servers', { 'iris-eval': { command: 'npx', args: ['-y', 'x'], env: {} } }, detectStyle(ZED_DEFAULT));
    for (const line of ['// Zed settings', '// big enough', '/* theme block */', '"dark": "One Dark",']) expect(out).toContain(line);
    expect(plain(out)).toEqual({ ...(plain(ZED_DEFAULT) as object), context_servers: { 'iris-eval': { command: 'npx', args: ['-y', 'x'], env: {} } } });
    // The existing trailing comma is reused, not doubled.
    expect(out).not.toMatch(/,\s*,/);
  });

  it('replaces an existing value in place, keeping its position', () => {
    const text = '{\n  "a": 1,\n  "b": {"old": true},\n  "c": 3\n}\n';
    const out = setMember(text, root(text), 'b', { new: 1 }, detectStyle(text));
    expect(Object.keys(plain(out) as object)).toEqual(['a', 'b', 'c']);
    expect(plain(out)).toEqual({ a: 1, b: { new: 1 }, c: 3 });
    expect(out).toBe('{\n  "a": 1,\n  "b": {\n    "new": 1\n  },\n  "c": 3\n}\n');
  });

  it('fills an empty object and follows tabs and CRLF', () => {
    const text = '{\r\n\t"servers": {}\r\n}\r\n';
    const servers = root(text).members[0].value as ObjectNode;
    const out = setMember(text, servers, 'x', { a: 1 }, detectStyle(text));
    expect(out).toBe('{\r\n\t"servers": {\r\n\t\t"x": {\r\n\t\t\t"a": 1\r\n\t\t}\r\n\t}\r\n}\r\n');
  });

  it('finds a trailing comma behind thousands of comment markers in linear time', () => {
    const text = `{"a": 1 ${'//'.repeat(20000)}\n ${'/**/'.repeat(20000)} ,}`;
    const started = performance.now();
    const out = setMember(text, root(text), 'b', 2, detectStyle(text));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(plain(out)).toEqual({ a: 1, b: 2 });
  });

  it('adds to a one-line object on the same line', () => {
    const text = '{"a": 1}';
    expect(setMember(text, root(text), 'b', 2, detectStyle(text))).toBe('{"a": 1, "b": 2}');
  });
});

describe('removeMember', () => {
  it('cuts a member on its own lines and never leaves a trailing comma the file did not have', () => {
    const text = '{\n  "a": 1,\n  "b": {\n    "x": [1, 2]\n  }\n}\n';
    const out = removeMember(text, root(text), 'b');
    expect(out).toBe('{\n  "a": 1\n}\n');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it('cuts first, middle and inline members', () => {
    const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';
    expect(JSON.parse(removeMember(text, root(text), 'a'))).toEqual({ b: 2, c: 3 });
    expect(JSON.parse(removeMember(text, root(text), 'b'))).toEqual({ a: 1, c: 3 });
    const inline = '{"a": 1, "b": 2, "c": 3}';
    expect(removeMember(inline, root(inline), 'a')).toBe('{"b": 2, "c": 3}');
    expect(removeMember(inline, root(inline), 'c')).toBe('{"a": 1, "b": 2}');
  });

  it('empties a single-member object and keeps comments elsewhere', () => {
    const text = '// head\n{\n  "only": 1\n}\n';
    expect(removeMember(text, root(text), 'only')).toBe('// head\n{}\n');
    expect(removeMember(text, root(text), 'absent')).toBe(text);
  });
});

/*
 * The invariant, over generated files: after setMember the parsed value is
 * the original plus the member; after removeMember it is the original minus
 * it; and a strict-JSON input stays strict JSON either way.
 */
const key = fc.string({ minLength: 1, maxLength: 8 }).filter((k) => k !== '__proto__');
const leaf = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.string({ maxLength: 12 }));
const value = fc.letrec((tie) => ({
  v: fc.oneof({ depthSize: 'small' }, leaf, fc.array(tie('v'), { maxLength: 3 }), fc.dictionary(key, tie('v'), { maxKeys: 3 })),
})).v;
const object = fc.dictionary(key, value, { maxKeys: 5 });
const layout = fc.constantFrom<[number | string, string]>([2, '\n'], [4, '\n'], ['\t', '\n'], [2, '\r\n'], [0, '\n']);

describe('setMember / removeMember — generated files', () => {
  it('set adds exactly the member; remove takes exactly it away; strict JSON stays strict', () => {
    fc.assert(
      fc.property(object, key, value, layout, (obj, k, v, [indent, eol]) => {
        const text = JSON.stringify(obj, null, indent).split('\n').join(eol) + eol;
        const set = setMember(text, root(text), k, v, detectStyle(text));
        const expected = { ...obj, [k]: v };
        expect(JSON.parse(set)).toEqual(JSON.parse(JSON.stringify(expected)));
        const removed = removeMember(set, root(set), k);
        const rest = { ...expected };
        delete rest[k];
        expect(JSON.parse(removed)).toEqual(JSON.parse(JSON.stringify(rest)));
      }),
      { numRuns: 400 },
    );
  });
});
