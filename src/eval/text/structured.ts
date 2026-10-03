/*
 * What an output SAYS, when it was written as JSON.
 *
 * Agents answer in structured form as often as in prose: a tool-call final
 * answer, a response schema, `{"answer": "...", "sources": [...]}`. The
 * text rules read the output as written, so a structured answer was read
 * in its escaped form. A line break was the two characters `\n`, a quote
 * was `\"`, and a phrase inside a string value sat between quotes, where
 * the injection rule reads it as a quotation. Measured on the labelled
 * corpus, writing every output as one string field of a JSON object
 * changed five verdicts and thirteen answers of the rules that decide one.
 *
 * This module reads a structured output as the text it carries. Two views:
 *
 *   VALUES: every string, number and boolean, in the order written, each
 *   its own paragraph. What the output says. The quality, relevance,
 *   placeholder, fabrication and grounding rules read this.
 *
 *   LABELLED: every field name, quoted as JSON writes it, followed by the
 *   value it holds (`"password": hunter2`), and a field name alone where
 *   its value is an object, a list, null or blank. What the output says
 *   and what it calls it. The leak, blocklist and injection rules read
 *   this: a secret is recognised by the name it is assigned to, a date of
 *   birth by its label, a smuggled directive by its key, and a key can
 *   itself be the leak (`{"dana@example.org": {...}}`). The name keeps its
 *   quotes so that a field called "system" is a field and not a forged
 *   `System:` line, and the patterns that read JSON keys inside prose read
 *   them here unchanged. A list's items carry its name once, before the
 *   first: so each character of the reading comes from later in the
 *   output than the one before it, and the reading is never more than a
 *   few characters per value longer than the output.
 *
 * Between two values is a paragraph mark on its own line (VALUE_BREAK), not
 * just a blank line: the folds the detectors apply turn a run of blank
 * lines into one line break, which a phone number or a phrase reads
 * across, and `[100, 250, 1000]` became a phone number. The mark survives
 * every fold. The sentence splitters end a sentence at it and count no
 * segment without a letter or a digit as a sentence; the quotation rule
 * ends a quotation at it, so quote marks in two fields cannot bracket the
 * one between them.
 *
 * Every view keeps, for each character it holds, where that character came
 * from in the output as sent. A rule reports offsets into the text it read,
 * and the engine maps them back, so a finding points at (and can redact)
 * the right characters of the stored output. That is the reason this is a
 * scanner and not JSON.parse: a parsed value does not know where it was.
 *
 * What counts as structured: an output that is one JSON object or one JSON
 * array with nothing around it but JSON whitespace (space, tab, line
 * breaks) and, at the very start, a byte-order mark, and that JSON.parse
 * accepts. A no-break space beside it, a sentence that contains JSON, a
 * fenced code block and a bare JSON string are read as written. Past STRUCTURED_OUTPUT_MAX_CHARS
 * the output is read as written.
 *
 * Emptiness: a blank string says nothing, so `{"answer": ""}` reads as
 * empty. An output with no string, number or boolean in it at all (`[]`,
 * `{"results": []}`, `{"answer": null}`) is read as written: the structure
 * is the only thing it says, and an empty list from an agent asked for a
 * list is the answer "none". A field beside an empty answer (a role, a
 * confidence) is read as something the output says; which field is the
 * answer is a schema this module does not have.
 *
 * Custom rules read the output exactly as it was sent. A deployment that
 * wrote a pattern against its own response format is matching that format.
 */

/** The longest output read as structured. Past it the output is read as written. */
export const STRUCTURED_OUTPUT_MAX_CHARS = 512_000;

/** The mark between two values in a view. Every fold keeps it; the sentence splitters and the quotation rule stop at it. */
export const VALUE_MARK = '¶';

/** Between two values in a view: the mark on a line of its own. */
const VALUE_BREAK = `\n\n${VALUE_MARK}\n\n`;

/**
 * Whether the mark at `i` is a value separator: alone on its line, as the
 * reading writes it and as every fold keeps it. A pilcrow inside a line of
 * prose ("under ¶ 4 of the agreement") is a character, not a separator.
 */
export function isValueBreakAt(text: string, i: number): boolean {
  if (text[i] !== VALUE_MARK) return false;
  let a = i - 1;
  while (a >= 0 && (text[a] === ' ' || text[a] === '\t')) a -= 1;
  let b = i + 1;
  while (b < text.length && (text[b] === ' ' || text[b] === '\t')) b += 1;
  return (a < 0 || text[a] === '\n') && (b >= text.length || text[b] === '\n' || text[b] === '\r');
}

/** A view's text without the breaks it inserted between values: what the values themselves say, for a rule that measures length. */
export function withoutValueBreaks(text: string): string {
  return text.split(VALUE_BREAK).join('\n');
}

/** One reading of a structured output, and where each of its characters came from. */
export interface OutputView {
  /** The text the rules read. */
  text: string;
  /** For each character of `text`, the offset in the output as sent where its source begins. Never decreases. */
  from: Int32Array;
  /** For each character of `text`, the offset in the output as sent where its source ends. */
  to: Int32Array;
}

export interface StructuredOutput {
  values: OutputView;
  labelled: OutputView;
}

/**
 * A run of the output as sent, as the text it decodes to. `start` and `end`
 * are the raw offsets of the content; a token with no escapes maps one to
 * one, and only a token with escapes carries a per-character map.
 */
interface Token {
  text: string;
  start: number;
  end: number;
  map: { from: number[]; to: number[] } | null;
}

/** A JSON string whose opening quote is at `open`, decoded. Returns the token and the index after the closing quote. */
function readString(raw: string, open: number): { token: Token; next: number } {
  let i = open + 1;
  let close = i;
  let escaped = false;
  while (close < raw.length && raw.charCodeAt(close) !== 0x22) {
    if (raw.charCodeAt(close) === 0x5c) {
      escaped = true;
      close += 2;
    } else close += 1;
  }
  if (!escaped) return { token: { text: raw.slice(i, close), start: i, end: close, map: null }, next: close + 1 };
  const from: number[] = [];
  const to: number[] = [];
  let text = '';
  while (i < close) {
    if (raw.charCodeAt(i) === 0x5c) {
      const e = raw[i + 1];
      const width = e === 'u' ? 6 : 2;
      text += e === 'u' ? String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16)) : e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
      from.push(i);
      to.push(i + width);
      i += width;
    } else {
      text += raw[i];
      from.push(i);
      to.push(i + 1);
      i += 1;
    }
  }
  return { token: { text, start: open + 1, end: close, map: { from, to } }, next: close + 1 };
}

/** A number, true, false or null starting at `start`. Returns the token (null for `null`) and the index after it, always past `start`. */
function readScalar(raw: string, start: number): { token: Token | null; next: number } {
  let i = start;
  while (i < raw.length && !/[\s,\]}:]/.test(raw[i])) i += 1;
  // Never stand still: whatever the scanner was handed, it moves on.
  if (i === start) return { token: null, next: start + 1 };
  const text = raw.slice(start, i);
  if (text === 'null') return { token: null, next: i };
  return { token: { text, start, end: i, map: null }, next: i };
}

/** A field name as the output wrote it, and whether any value was read under it. */
interface KeyEntry {
  kind: 'key';
  key: Token;
  /** Set once a value is read under this occurrence of the name, which then carries it. */
  carried: boolean;
}

interface ValueEntry {
  kind: 'value';
  value: Token;
  /** The name this value is the first of, when it is: written before it in the labelled reading. */
  key: KeyEntry | null;
}

interface Frame {
  kind: 'object' | 'array';
  /** In an object: whether the next string is a key. */
  expectKey: boolean;
  /** The name this frame's next value belongs to: an object's latest key, or the key a list sits under until its first value takes it. */
  key: KeyEntry | null;
}

/**
 * Every field name and every value, in the order written. A value takes the
 * name it sits under when it is the first value to do so; a name no value
 * took is read on its own. The input is JSON that JSON.parse accepted.
 */
function entriesOf(raw: string): { entries: Array<KeyEntry | ValueEntry>; anyValue: boolean } {
  const entries: Array<KeyEntry | ValueEntry> = [];
  const stack: Frame[] = [];
  let anyValue = false;
  const take = (top: Frame | undefined): KeyEntry | null => {
    const key = top?.key ?? null;
    if (key === null || key.carried) return null;
    key.carried = true;
    return key;
  };
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    const top = stack[stack.length - 1];
    if (c === '{' || c === '[') {
      // A list under a name carries the name down until a value takes it.
      const carried = c === '[' && top !== undefined ? top.key : null;
      // A list whose item is a container gives its name to nothing later: written on its own, the name stays before what follows it.
      if (top?.kind === 'array') top.key = null;
      stack.push({ kind: c === '{' ? 'object' : 'array', expectKey: c === '{', key: carried });
      i += 1;
    } else if (c === '}' || c === ']') {
      stack.pop();
      i += 1;
    } else if (c === ',') {
      if (top?.kind === 'object') {
        top.expectKey = true;
        top.key = null;
      }
      i += 1;
    } else if (c === ':') {
      if (top !== undefined) top.expectKey = false;
      i += 1;
    } else if (c === '"') {
      const { token, next } = readString(raw, i);
      if (top?.kind === 'object' && top.expectKey) {
        const entry: KeyEntry = { kind: 'key', key: token, carried: false };
        entries.push(entry);
        top.key = entry;
      } else {
        anyValue = true;
        if (token.text.trim() !== '') entries.push({ kind: 'value', value: token, key: take(top) });
      }
      i = next;
    } else if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || (i === 0 && c === '\uFEFF')) {
      i += 1;
    } else {
      const { token, next } = readScalar(raw, i);
      if (token !== null) {
        anyValue = true;
        entries.push({ kind: 'value', value: token, key: take(top) });
      }
      i = next;
    }
  }
  return { entries, anyValue };
}

/** A piece of a reading: text from the output (a token, or a token's quotes) or text the reading inserts at a point. */
type Piece = { token: Token; quoted: boolean } | { inserted: string; at: number };

function viewOf(pieces: readonly Piece[]): OutputView {
  let length = 0;
  for (const p of pieces) length += 'inserted' in p ? p.inserted.length : p.token.text.length + (p.quoted ? 2 : 0);
  const from = new Int32Array(length);
  const to = new Int32Array(length);
  const parts: string[] = [];
  let n = 0;
  const put = (a: number, b: number): void => {
    from[n] = a;
    to[n] = b;
    n += 1;
  };
  for (const p of pieces) {
    if ('inserted' in p) {
      for (let k = 0; k < p.inserted.length; k++) put(p.at, p.at);
      parts.push(p.inserted);
      continue;
    }
    const t = p.token;
    if (p.quoted) put(t.start - 1, t.start);
    if (t.map === null) for (let k = 0; k < t.text.length; k++) put(t.start + k, t.start + k + 1);
    else for (let k = 0; k < t.text.length; k++) put(t.map.from[k], t.map.to[k]);
    if (p.quoted) put(t.end, t.end + 1);
    parts.push(p.quoted ? `"${t.text}"` : t.text);
  }
  return { text: parts.join(''), from, to };
}

/** The output with JSON whitespace (and only that) taken off both ends, and where what is left starts. */
function jsonTrimmed(output: string): { body: string; offset: number } {
  let a = output.startsWith('\uFEFF') ? 1 : 0;
  let b = output.length;
  const ws = (c: string | undefined): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  while (a < b && ws(output[a])) a += 1;
  while (b > a && ws(output[b - 1])) b -= 1;
  return { body: output.slice(a, b), offset: a };
}

/**
 * The two readings of a structured output, or null when the output is not
 * one (see the header for what counts). Linear in the output's length.
 */
export function readStructured(output: string): StructuredOutput | null {
  if (output.length > STRUCTURED_OUTPUT_MAX_CHARS) return null;
  const { body } = jsonTrimmed(output);
  const first = body[0];
  const last = body[body.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return null;
  try {
    JSON.parse(body);
  } catch {
    return null;
  }
  // The scanner reads the output as sent: around the body there is only JSON whitespace, which it skips.
  const { entries, anyValue } = entriesOf(output);
  if (!anyValue) return null;
  const values: Piece[] = [];
  const labelled: Piece[] = [];
  let lastValueEnd = -1;
  let lastLabelledEnd = -1;
  for (const entry of entries) {
    if (entry.kind === 'key') {
      // Written only when no value took it: a name alone, where its value is an object, a list, null or blank.
      if (entry.carried) continue;
      if (lastLabelledEnd >= 0) labelled.push({ inserted: VALUE_BREAK, at: lastLabelledEnd });
      labelled.push({ token: entry.key, quoted: true }, { inserted: ':', at: entry.key.end + 1 });
      lastLabelledEnd = entry.key.end + 1;
      continue;
    }
    if (lastValueEnd >= 0) values.push({ inserted: VALUE_BREAK, at: lastValueEnd });
    values.push({ token: entry.value, quoted: false });
    lastValueEnd = entry.value.end;
    if (lastLabelledEnd >= 0) labelled.push({ inserted: VALUE_BREAK, at: lastLabelledEnd });
    if (entry.key !== null) labelled.push({ token: entry.key.key, quoted: true }, { inserted: ': ', at: entry.key.key.end + 1 });
    labelled.push({ token: entry.value, quoted: false });
    lastLabelledEnd = entry.value.end;
  }
  return { values: viewOf(values), labelled: viewOf(labelled) };
}

/** A span of a view's text, as a span of the output as sent. */
export function spanInOutput(view: OutputView, start: number, end: number): { start: number; end: number } {
  const n = view.text.length;
  if (n === 0) return { start: 0, end: 0 };
  let s = Math.min(Math.max(start, 0), n - 1);
  let e = Math.min(Math.max(end, s), n);
  // Characters the reading inserted (a value break, ": ") are points; the span is what came from the output.
  while (s < e && view.from[s] === view.to[s]) s += 1;
  while (e > s && view.from[e - 1] === view.to[e - 1]) e -= 1;
  if (e === s) return { start: view.from[Math.min(s, n - 1)], end: view.from[Math.min(s, n - 1)] };
  return { start: view.from[s], end: view.to[e - 1] };
}
