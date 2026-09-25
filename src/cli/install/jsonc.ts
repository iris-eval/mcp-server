/*
 * A minimal JSON-with-comments editor: set or remove one member of an object
 * in place, leaving every other byte of the file as it was.
 *
 * Why not JSON.parse + JSON.stringify: several clients' config files are
 * JSONC, not JSON. Zed's settings.json is created by Zed with a header of
 * `//` comments, VS Code's mcp.json and Gemini CLI's settings.json accept
 * them, and Continue reads its MCP files with a comment-tolerant parser. A
 * round trip through JSON.stringify deletes every comment and reorders
 * nothing but reformats everything, and a strict parse refuses the file
 * outright — which is what the installer used to do for Zed, on the file
 * shape Zed itself writes. This edits the text: the member Iris owns is
 * inserted, replaced or cut, and comments, key order, spacing and line
 * endings elsewhere are untouched.
 *
 * Scope is deliberately small: objects, arrays, strings, numbers and
 * literals; `//` and `/* *\/` comments; trailing commas. It never introduces a
 * comment or a trailing comma, so a strict-JSON file stays strict JSON.
 */

export interface Span {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface ObjectNode extends Span {
  kind: 'object';
  members: Member[];
}

export interface OtherNode extends Span {
  kind: 'array' | 'string' | 'number' | 'literal';
}

export type Node = ObjectNode | OtherNode;

export interface Member {
  key: string;
  keyStart: number;
  value: Node;
}

export class JsoncError extends Error {}

/** Parse JSONC text into a span tree. Throws JsoncError with an offset on malformed input. */
export function parseTree(text: string): Node {
  let i = 0;
  const fail = (what: string): never => {
    const line = text.slice(0, i).split('\n').length;
    throw new JsoncError(`${what} at line ${line}`);
  };

  const skip = (): void => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\ufeff') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        if (close === -1) fail('unterminated comment');
        i = close + 2;
      } else {
        return;
      }
    }
  };

  const string = (): OtherNode => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      if (text[i] === '\n') fail('newline in string');
      i++;
    }
    if (text[i] !== '"') fail('unterminated string');
    i++;
    return { kind: 'string', start, end: i };
  };

  const value = (): Node => {
    skip();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    const start = i;
    while (i < text.length && !/[\s,}\]/]/.test(text[i])) i++;
    const word = text.slice(start, i);
    if (word === 'true' || word === 'false' || word === 'null') return { kind: 'literal', start, end: i };
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(word)) return { kind: 'number', start, end: i };
    return fail(word ? `unexpected "${word.slice(0, 20)}"` : 'unexpected end of input');
  };

  const array = (): OtherNode => {
    const start = i;
    i++;
    for (;;) {
      skip();
      if (text[i] === ']') break;
      value();
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] !== ']') fail('expected "," or "]"');
    }
    i++;
    return { kind: 'array', start, end: i };
  };

  const object = (): ObjectNode => {
    const start = i;
    i++;
    const members: Member[] = [];
    for (;;) {
      skip();
      if (text[i] === '}') break;
      if (text[i] !== '"') fail('expected a quoted key');
      const keyNode = string();
      const key = JSON.parse(text.slice(keyNode.start, keyNode.end)) as string;
      skip();
      if (text[i] !== ':') fail('expected ":"');
      i++;
      members.push({ key, keyStart: keyNode.start, value: value() });
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] !== '}') fail('expected "," or "}"');
    }
    i++;
    return { kind: 'object', start, end: i, members };
  };

  const root = value();
  skip();
  if (i < text.length) fail('unexpected content after the top-level value');
  return root;
}

/** Strip comments and trailing commas so JSON.parse can read a node's text. */
export function toPlainJson(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else if (c === ',' && closesNext(text, i + 1)) {
      // A trailing comma: dropped. Found by scanning, not by a regex over
      // the output, so a string that contains ",}" is never touched.
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/^\ufeff/, '');
}

/**
 * The index of the next significant character at or after `from`: past
 * whitespace and comments. A scan, not a regular expression — a pattern of
 * alternated comment forms backtracks exponentially on a run of "//".
 */
function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else {
      return i;
    }
  }
}

/** Whether the next significant character at or after `from` closes an object or array. */
function closesNext(text: string, from: number): boolean {
  const c = text[skipTrivia(text, from)];
  return c === '}' || c === ']';
}

/** The value of a node, as JavaScript. */
export function valueOf(text: string, node: Node): unknown {
  return JSON.parse(toPlainJson(text.slice(node.start, node.end)));
}

export function memberOf(node: Node, key: string): Member | undefined {
  return node.kind === 'object' ? node.members.find((m) => m.key === key) : undefined;
}

/* ---------------- Formatting helpers ---------------- */

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

/** The whitespace before `at` on its line, when nothing else precedes it there. */
function ownLineIndent(text: string, at: number): string | null {
  const before = text.slice(lineStart(text, at), at);
  return /^[ \t]*$/.test(before) ? before : null;
}

export interface Style {
  /** One level of indentation, e.g. "  " or "\t". */
  unit: string;
  eol: '\n' | '\r\n';
}

export function detectStyle(text: string): Style {
  // The shallowest indented key line is one level deep.
  const indents = [...text.matchAll(/\n([ \t]+)"/g)].map((m) => m[1]);
  const spaces = indents.filter((d) => !d.includes('\t')).map((d) => d.length);
  const unit = indents.some((d) => d.startsWith('\t')) ? '\t' : spaces.length > 0 ? ' '.repeat(spaces.reduce((min, n) => Math.min(min, n), 8)) : '  ';
  return { unit, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** A JSON value rendered at a given indentation, continuation lines prefixed. */
function render(value: unknown, indent: string, style: Style): string {
  return JSON.stringify(value, null, style.unit).split('\n').join(style.eol + indent);
}

/** The indentation of the object's own line (for its closing brace). */
function objectIndent(text: string, obj: ObjectNode): string {
  const start = lineStart(text, obj.start);
  return text.slice(start).match(/^[ \t]*/)![0];
}

/* ---------------- Edits ---------------- */

/** Set `key` on `obj` to `value`: replace the member's value if present, else append a member. */
export function setMember(text: string, obj: ObjectNode, key: string, value: unknown, style: Style): string {
  const existing = obj.members.find((m) => m.key === key);
  if (existing) {
    const indent = ownLineIndent(text, existing.keyStart) ?? objectIndent(text, obj) + style.unit;
    return text.slice(0, existing.value.start) + render(value, indent, style) + text.slice(existing.value.end);
  }

  const outer = objectIndent(text, obj);
  if (obj.members.length === 0) {
    const indent = outer + style.unit;
    const body = `${style.eol}${indent}${JSON.stringify(key)}: ${render(value, indent, style)}${style.eol}${outer}`;
    return text.slice(0, obj.start + 1) + body + text.slice(obj.end - 1);
  }

  const last = obj.members[obj.members.length - 1];
  const first = obj.members[0];
  const onOwnLine = ownLineIndent(text, first.keyStart);
  const indent = onOwnLine ?? outer + style.unit;
  // A trailing comma already after the last member (JSONC) is kept and reused.
  let after = last.value.end;
  const next = skipTrivia(text, after);
  const hasTrailingComma = text[next] === ',';
  if (hasTrailingComma) after = next + 1;
  const sep = onOwnLine !== null ? `${style.eol}${indent}` : ' ';
  const member = `${JSON.stringify(key)}: ${render(value, indent, style)}`;
  // A file that ends its members with a trailing comma gets one after the
  // new member too, so removing it later restores the file byte for byte.
  return text.slice(0, after) + (hasTrailingComma ? '' : ',') + sep + member + (hasTrailingComma ? ',' : '') + text.slice(after);
}

/** Remove `key` from `obj`. Returns the text unchanged when the key is absent. */
export function removeMember(text: string, obj: ObjectNode, key: string): string {
  const index = obj.members.findIndex((m) => m.key === key);
  if (index === -1) return text;
  const member = obj.members[index];

  if (obj.members.length === 1) {
    return text.slice(0, obj.start + 1) + text.slice(obj.end - 1);
  }

  // Where the member's own trailing comma (if any) ends.
  const commaMatch = text.slice(member.value.end).match(/^[ \t]*,/);
  const afterComma = commaMatch ? member.value.end + commaMatch[0].length : member.value.end;
  const isLast = index === obj.members.length - 1;
  const indent = ownLineIndent(text, member.keyStart);
  const restOfLine = text.slice(afterComma).match(/^[ \t]*(\r?\n)/);

  let start: number;
  let end: number;
  if (indent !== null && restOfLine) {
    // The member sits on its own line(s): cut whole lines.
    start = lineStart(text, member.keyStart);
    end = afterComma + restOfLine[0].length;
  } else if (!isLast) {
    start = member.keyStart;
    end = obj.members[index + 1].keyStart;
  } else {
    // Inline and last: cut from the previous member's comma through this value.
    const prev = obj.members[index - 1];
    start = prev.value.end;
    end = member.value.end;
    return text.slice(0, start) + text.slice(end);
  }

  let next = text.slice(0, start) + text.slice(end);
  // Removing the last member must not leave the previous member with a
  // trailing comma the original did not have (strict-JSON files stay strict).
  if (isLast && !commaMatch) {
    const prev = obj.members[index - 1];
    const between = next.slice(prev.value.end, start);
    const m = between.match(/^([ \t]*),/);
    if (m) next = next.slice(0, prev.value.end) + m[1] + next.slice(prev.value.end + m[0].length);
  }
  return next;
}
