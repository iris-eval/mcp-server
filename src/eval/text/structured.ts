/*
 * What an output SAYS, when it was written as JSON.
 *
 * Agents answer in structured form as often as in prose: a tool-call final
 * answer, a response schema, `{"answer": "...", "sources": [...]}`. The
 * text rules read the output as written, so a structured answer was read
 * in its escaped form. A line break was the two characters `\n`, a quote
 * was `\"`, and a field name was a word the answer had said. Measured on
 * the labelled corpus, writing every output as one string field of a JSON
 * object changed five verdicts and thirteen answers of the rules that
 * decide one: an injection the rule had found was missed, an empty answer
 * was no longer empty, and "not.\n\nThe" was read as the name of a file.
 *
 * This module reads a structured output as the text it carries. Two views:
 *
 *   VALUES: every string, number and boolean, in the order written, each
 *   its own paragraph. What the output says. The quality, relevance,
 *   placeholder, fabrication and grounding rules read this.
 *
 *   LABELLED: the same, each prefixed with the name of the field it sits
 *   in ("password: hunter2"). What the output says and what it calls it.
 *   The leak, blocklist and injection rules read this, because a field
 *   name is part of what was written: a secret is recognised by the name
 *   it is assigned to, and a smuggled directive hides in a key.
 *
 * Every view keeps, for each character it holds, where that character came
 * from in the output as sent. A rule reports offsets into the text it read,
 * and the engine maps them back, so a finding points at (and can redact)
 * the right characters of the stored output. That is the reason this is a
 * scanner and not JSON.parse: a parsed value does not know where it was.
 *
 * What counts as structured: an output that is, whole and trimmed, one
 * JSON object or one JSON array, and that JSON.parse accepts. A sentence
 * that contains JSON, a fenced code block and a bare JSON string are prose.
 * Past STRUCTURED_OUTPUT_MAX_CHARS the output is read as written.
 *
 * An output with no string, number or boolean in it at all (`[]`, `{}`,
 * `{"results": []}`) is read as written too: the structure is the only
 * thing it says, and an empty list from an agent asked for a list is the
 * answer "none". One that carries strings and every one of them blank
 * (`{"answer": ""}`) says nothing, and its readings are empty.
 *
 * Custom rules read the output exactly as it was sent. A deployment that
 * wrote a pattern against its own response format is matching that format.
 */

/** The longest output read as structured. Past it the output is read as written. */
export const STRUCTURED_OUTPUT_MAX_CHARS = 512_000;

/** Between two values in a view: a paragraph break, so no sentence or phrase runs from one field into the next. */
const VALUE_BREAK = '\n\n';

/** One reading of a structured output, and where each of its characters came from. */
export interface OutputView {
  /** The text the rules read. */
  text: string;
  /** For each character of `text`, the offset in the output as sent where its source begins. */
  from: Int32Array;
  /** For each character of `text`, the offset in the output as sent where its source ends. */
  to: Int32Array;
}

export interface StructuredOutput {
  values: OutputView;
  labelled: OutputView;
}

/** A string or a scalar, decoded, with the source offsets of each decoded character. */
interface Token {
  text: string;
  from: number[];
  to: number[];
  /** Where the token's content ends in the output as sent; a zero-width point for what is inserted after it. */
  end: number;
}

interface Leaf {
  key: Token | null;
  value: Token;
}

/** A JSON string starting at `open` (the opening quote), decoded. Returns the token and the index after the closing quote. */
function readString(raw: string, open: number): { token: Token; next: number } {
  const from: number[] = [];
  const to: number[] = [];
  let text = '';
  let i = open + 1;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c === 0x22) break; // "
    if (c === 0x5c) {
      // \
      const e = raw[i + 1];
      if (e === 'u') {
        text += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        from.push(i);
        to.push(i + 6);
        i += 6;
        continue;
      }
      text += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
      from.push(i);
      to.push(i + 2);
      i += 2;
      continue;
    }
    text += raw[i];
    from.push(i);
    to.push(i + 1);
    i += 1;
  }
  return { token: { text, from, to, end: i }, next: i + 1 };
}

/** A number, true, false or null starting at `start`. Returns the token (null for `null`) and the index after it. */
function readScalar(raw: string, start: number): { token: Token | null; next: number } {
  let i = start;
  while (i < raw.length && !/[\s,\]}]/.test(raw[i])) i += 1;
  const text = raw.slice(start, i);
  if (text === 'null') return { token: null, next: i };
  const from: number[] = [];
  const to: number[] = [];
  for (let k = start; k < i; k++) {
    from.push(k);
    to.push(k + 1);
  }
  return { token: { text, from, to, end: i }, next: i };
}

interface Frame {
  kind: 'object' | 'array';
  /** In an object: whether the next string is a key. */
  expectKey: boolean;
  /** The field this frame's values belong to: an object's latest key, or the key an array sits under. */
  key: Token | null;
}

/**
 * Every value in the order written, each with the name of the field it sits
 * in, and whether the output carries any value at all (a blank string is a
 * value that says nothing; null and an empty container are not values). The
 * input is JSON that JSON.parse accepted.
 */
function leavesOf(raw: string): { leaves: Leaf[]; anyValue: boolean } {
  const leaves: Leaf[] = [];
  let anyValue = false;
  const stack: Frame[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    const top = stack[stack.length - 1];
    if (c === '{' || c === '[') {
      // A container under a key carries the key down; one inside an array carries the array's.
      stack.push({ kind: c === '{' ? 'object' : 'array', expectKey: c === '{', key: c === '[' && top !== undefined ? top.key : null });
      i += 1;
    } else if (c === '}' || c === ']') {
      stack.pop();
      i += 1;
    } else if (c === ',') {
      if (top?.kind === 'object') top.expectKey = true;
      i += 1;
    } else if (c === ':') {
      if (top !== undefined) top.expectKey = false;
      i += 1;
    } else if (c === '"') {
      const { token, next } = readString(raw, i);
      if (top?.kind === 'object' && top.expectKey) top.key = token;
      else {
        anyValue = true;
        if (token.text.trim() !== '') leaves.push({ key: top?.key ?? null, value: token });
      }
      i = next;
    } else if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i += 1;
    } else {
      const { token, next } = readScalar(raw, i);
      if (token !== null) {
        anyValue = true;
        leaves.push({ key: top?.key ?? null, value: token });
      }
      i = next;
    }
  }
  return { leaves, anyValue };
}

/** Join tokens into one view. Inserted characters (breaks, ": ") map to a zero-width point after what precedes them. */
function viewOf(parts: Array<Token | { inserted: string; at: number }>): OutputView {
  let length = 0;
  for (const p of parts) length += 'inserted' in p ? p.inserted.length : p.text.length;
  const from = new Int32Array(length);
  const to = new Int32Array(length);
  let text = '';
  let n = 0;
  for (const p of parts) {
    if ('inserted' in p) {
      for (let k = 0; k < p.inserted.length; k++, n++) {
        from[n] = p.at;
        to[n] = p.at;
      }
      text += p.inserted;
    } else {
      for (let k = 0; k < p.text.length; k++, n++) {
        from[n] = p.from[k];
        to[n] = p.to[k];
      }
      text += p.text;
    }
  }
  return { text, from, to };
}

/**
 * The two readings of a structured output, or null when the output is not
 * one (see the header for what counts). Linear in the output's length.
 */
export function readStructured(output: string): StructuredOutput | null {
  if (output.length > STRUCTURED_OUTPUT_MAX_CHARS) return null;
  const trimmed = output.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }
  const { leaves, anyValue } = leavesOf(output);
  if (!anyValue) return null;
  const values: Array<Token | { inserted: string; at: number }> = [];
  const labelled: Array<Token | { inserted: string; at: number }> = [];
  leaves.forEach((leaf, n) => {
    if (n > 0) {
      const after = leaves[n - 1].value.end;
      values.push({ inserted: VALUE_BREAK, at: after });
      labelled.push({ inserted: VALUE_BREAK, at: after });
    }
    values.push(leaf.value);
    if (leaf.key !== null && leaf.key.text.trim() !== '') {
      labelled.push(leaf.key, { inserted: ': ', at: leaf.key.end });
    }
    labelled.push(leaf.value);
  });
  return { values: viewOf(values), labelled: viewOf(labelled) };
}

/** A span of a view's text, as a span of the output as sent. */
export function spanInOutput(view: OutputView, start: number, end: number): { start: number; end: number } {
  const n = view.text.length;
  if (n === 0) return { start: 0, end: 0 };
  let s = Math.min(Math.max(start, 0), n - 1);
  let e = Math.min(Math.max(end, s), n);
  // Characters the reading inserted (a paragraph break, ": ") are points; the span is what came from the output.
  while (s < e && view.from[s] === view.to[s]) s += 1;
  while (e > s && view.from[e - 1] === view.to[e - 1]) e -= 1;
  if (e === s) return { start: view.from[Math.min(s, n - 1)], end: view.from[Math.min(s, n - 1)] };
  return { start: view.from[s], end: view.to[e - 1] };
}
