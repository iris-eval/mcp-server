/*
 * A tool value as the strings in it.
 *
 * A tool's output and a call's arguments arrive as a string or as a
 * structure, and which is the harness's choice, not the tool's. The same
 * README comes back as a string, as { path, content }, as { stdout }, as an
 * MCP result { content: [{ type: 'text', text }] }, or as the JSON text of
 * any of those; the same arguments arrive as an object or as the JSON text
 * a provider sends.
 *
 * A rule that reads words cannot read a structure as its JSON text. There a
 * line break inside a string is the two characters \n, so the word after it
 * reads with an n in front ("nbeacon"), a sentence that ends at the end of
 * a line does not end, a phrase broken across a line is not a phrase, and a
 * whole JSON text held in one string is one value. Each of those was
 * measured on no_injection_compliance: a README that the rule read rightly
 * as a string failed as { path, content }, and a message forwarded to the
 * address it named passed when the arguments were sent as JSON text.
 *
 * So: every string of the value, each read as written, in the order
 * stableStringify writes them (keys sorted, a key before its value). A
 * string that is itself the JSON text of an object or an array is read as
 * that structure.
 *
 * THE LINES OF ONE TEXT. An array whose key says it holds lines
 * ({ lines: [...] }, `stdout_lines`, `outputLines`) is a text the tool
 * split, and its strings are read as that text, one after another with a
 * line break between: a sentence the tool broke between two of them is one
 * sentence. Read each on its own, an instruction returned a line to a
 * string lost everything after its first line.
 *
 * Any other array is read a string at a time, and so are the text parts of
 * an MCP result and the fields of an object. Two pages a search returned,
 * the messages of a thread and the cells of a table row are each their own
 * text: read as one, a sentence planted at the end of the first page ran on
 * into the second, whose words were then the instruction's, and a list of
 * two commands was one command. What that costs: a text returned a line to
 * a string under a key that does not say so, or a line to a text part, is
 * read line by line.
 */

/** How many times a string that is itself JSON text is opened: a result inside a result inside a result. */
export const MAX_JSON_TEXT_DEPTH = 3;
/**
 * How deep a structure is read: deeper than a request can nest, since a
 * megabyte of JSON holds half a million levels at most. A structure that
 * refers to itself, which only a caller of the engine in code can build,
 * reaches it, and the reading then stops and says so. At 1,000, which it
 * was, a call whose arguments were wrapped in 1,001 arrays was not read,
 * and what it carried was not looked at.
 */
export const MAX_VALUE_DEPTH = 1_000_000;
/**
 * How many values of a structure are read. A megabyte of JSON holds at most
 * half a million; a structure that holds itself twice over, which again only
 * a caller in code can build, holds 2 to the power of its depth, and read to
 * the depth alone the reading of it never ended.
 */
export const MAX_VALUE_PARTS = 4_000_000;

/** Where the JSON string that opens at `at` ends (the offset past its closing mark), or -1 when it is no JSON string. */
function jsonStringEnd(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 34) return i + 1;
    if (c < 32) return -1;
    if (c !== 92) {
      i += 1;
      continue;
    }
    const escaped = text.charCodeAt(i + 1);
    // \" \\ \/ \b \f \n \r \t
    if (escaped === 34 || escaped === 92 || escaped === 47 || escaped === 98 || escaped === 102 || escaped === 110 || escaped === 114 || escaped === 116) {
      i += 2;
      continue;
    }
    // \u and four hexadecimal digits
    if (escaped !== 117) return -1;
    for (let k = i + 2; k < i + 6; k += 1) {
      const h = text.charCodeAt(k);
      if (!((h >= 48 && h <= 57) || (h >= 65 && h <= 70) || (h >= 97 && h <= 102))) return -1;
    }
    i += 6;
  }
  return -1;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** Where the JSON value that is not an object or an array ends when one stands at `at` (a string, a number, true, false, null), or -1. */
function jsonScalarEnd(text: string, at: number): number {
  const c = text.charCodeAt(at);
  if (c === 34) return jsonStringEnd(text, at);
  if (c === 116) return text.startsWith('true', at) ? at + 4 : -1;
  if (c === 102) return text.startsWith('false', at) ? at + 5 : -1;
  if (c === 110) return text.startsWith('null', at) ? at + 4 : -1;
  let i = c === 45 ? at + 1 : at;
  // A whole part: a zero alone, or digits that do not begin with one.
  if (text.charCodeAt(i) === 48) i += 1;
  else if (isDigit(text.charCodeAt(i))) while (isDigit(text.charCodeAt(i))) i += 1;
  else return -1;
  if (text.charCodeAt(i) === 46) {
    i += 1;
    if (!isDigit(text.charCodeAt(i))) return -1;
    while (isDigit(text.charCodeAt(i))) i += 1;
  }
  const e = text.charCodeAt(i);
  if (e === 101 || e === 69) {
    i += 1;
    const sign = text.charCodeAt(i);
    if (sign === 43 || sign === 45) i += 1;
    if (!isDigit(text.charCodeAt(i))) return -1;
    while (isDigit(text.charCodeAt(i))) i += 1;
  }
  return i;
}

/**
 * Whether a text is JSON, read by its grammar and not by parsing it.
 *
 * JSON.parse says a text is not JSON by throwing, and a throw costs about
 * 16 microseconds however short the text. Every string of a tool value
 * that begins and ends with a bracket was asked that way, three times over
 * for a call's arguments: a call given 94,000 strings "{a}" cost 6 s of
 * CPU, under a megabyte. This reads the text once, by its characters, and
 * JSON.parse is given only what it will accept.
 */
export function isJson(text: string): boolean {
  const n = text.length;
  /** The arrays (1) and objects (2) that are open. */
  const open: number[] = [];
  // What may stand next: 0 a value; 1 a value or the end of an empty array; 2 a comma or the end of the array; 3 a key or the end of an empty object; 4 a key; 5 a colon; 6 a comma or the end of the object; 7 nothing more.
  let next = 0;
  const afterValue = (): number => (open.length === 0 ? 7 : open[open.length - 1] === 1 ? 2 : 6);
  let i = 0;
  for (;;) {
    while (i < n) {
      const space = text.charCodeAt(i);
      if (space !== 32 && space !== 10 && space !== 13 && space !== 9) break;
      i += 1;
    }
    if (i >= n) return next === 7;
    const c = text.charCodeAt(i);
    if (next === 7) return false;
    if (next === 0 || next === 1) {
      if (next === 1 && c === 93) {
        open.pop();
        next = afterValue();
        i += 1;
      } else if (c === 123) {
        open.push(2);
        next = 3;
        i += 1;
      } else if (c === 91) {
        open.push(1);
        next = 1;
        i += 1;
      } else {
        i = jsonScalarEnd(text, i);
        if (i < 0) return false;
        next = afterValue();
      }
    } else if (next === 3 || next === 4) {
      if (next === 3 && c === 125) {
        open.pop();
        next = afterValue();
        i += 1;
      } else {
        if (c !== 34) return false;
        i = jsonStringEnd(text, i);
        if (i < 0) return false;
        next = 5;
      }
    } else if (next === 5) {
      if (c !== 58) return false;
      next = 0;
      i += 1;
    } else {
      // 2 or 6: after a value inside an array or an object
      const closes = next === 2 ? 93 : 125;
      if (c === 44) next = next === 2 ? 0 : 4;
      else if (c === closes) {
        open.pop();
        next = afterValue();
      } else return false;
      i += 1;
    }
  }
}

/** The structure a string holds when it is the JSON text of an object or an array, and undefined when it is not. */
export function jsonStructure(text: string): object | undefined {
  let from = 0;
  while (from < text.length && text.charCodeAt(from) <= 32) from += 1;
  const first = text[from];
  if (first !== '{' && first !== '[') return undefined;
  let to = text.length - 1;
  while (to > from && text.charCodeAt(to) <= 32) to -= 1;
  if (text[to] !== (first === '{' ? '}' : ']')) return undefined;
  if (!isJson(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A tool value as a structure: the value itself, or what it holds when it is the JSON text of an object or an array. */
export function structureOf(value: unknown): unknown {
  return typeof value === 'string' ? (jsonStructure(value) ?? value) : value;
}

type Pending = { value: unknown; level: number; opened: number; under?: string; continues?: boolean } | { key: string };

/**
 * Whether a key says its array holds the lines of one text: `lines`, or a
 * name whose last word is that (`stdout_lines`, `output-lines`,
 * `stdoutLines`). `guidelines` and `headlines` are words of their own.
 */
export function saysLines(key: string | undefined): boolean {
  if (key === undefined || key.length < 5 || key.slice(-5).toLowerCase() !== 'lines') return false;
  if (key.length === 5) return true;
  const before = key.charCodeAt(key.length - 6);
  const capital = before >= 65 && before <= 90;
  // A new word begins after anything that is no letter and no digit, or with a capital after a small letter or a digit.
  if (!capital && !(before >= 97 && before <= 122) && !(before >= 48 && before <= 57)) return true;
  return key.charCodeAt(key.length - 5) === 76 && !capital;
}

/**
 * Every string of a tool value, in the order stableStringify writes them:
 * `visit(text, isKey, continues)` for each key and each string value.
 * Numbers, true, false and null are not text. `visit` may return false to
 * stop. `continues` says the string is the next line of the text the
 * string before it belongs to (THE LINES OF ONE TEXT, above).
 *
 * Returns whether the value was read whole: false when `visit` stopped it,
 * a part of it lay deeper than MAX_VALUE_DEPTH, or it held more than
 * MAX_VALUE_PARTS values.
 *
 * It keeps its own list of what is still to be read where a function that
 * calls itself would use the stack, so a value nested thousands deep is
 * read like any other.
 */
export function eachString(value: unknown, visit: (text: string, isKey: boolean, continues: boolean) => boolean | void): boolean {
  const pending: Pending[] = [{ value, level: 0, opened: 0 }];
  let whole = true;
  let read = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    read += 1;
    if (read > MAX_VALUE_PARTS) return false;
    if ('key' in item) {
      if (visit(item.key, true, false) === false) return false;
      continue;
    }
    const { level, opened } = item;
    let current = item.value;
    if (typeof current === 'string') {
      const inner = opened < MAX_JSON_TEXT_DEPTH ? jsonStructure(current) : undefined;
      if (inner === undefined) {
        if (visit(current, false, item.continues === true) === false) return false;
        continue;
      }
      current = inner;
      item.opened = opened + 1;
    }
    if (current === null || typeof current !== 'object') continue;
    if (level >= MAX_VALUE_DEPTH) {
      whole = false;
      continue;
    }
    // Pushed last first, so that they are read first to last.
    if (Array.isArray(current)) {
      const depth = item.opened;
      // The strings of an array are the lines of one text where its key says so, and nowhere else. A line is text whatever it holds: a line that is by itself JSON text ("[]", a line of a JSON Lines file) is not opened, as it is not in the same text returned as one string.
      if (saysLines(item.under)) {
        for (let i = current.length - 1; i >= 0; i -= 1) {
          const line = typeof current[i] === 'string';
          pending.push({ value: current[i], level: level + 1, opened: line ? MAX_JSON_TEXT_DEPTH : depth, continues: line && i > 0 && typeof current[i - 1] === 'string' });
        }
        continue;
      }
      for (let i = current.length - 1; i >= 0; i -= 1) pending.push({ value: current[i], level: level + 1, opened: depth });
      continue;
    }
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      pending.push({ value: record[keys[i]], level: level + 1, opened: item.opened, under: keys[i] });
      pending.push({ key: keys[i] });
    }
  }
  return whole;
}

/**
 * What stands between two strings of a structure read as one text: a
 * closing bracket and a line break. No word, sentence or phrase reads
 * across it, and it is chosen so that a string reads at its two ends as it
 * would read alone (text/directives.ts): a closing bracket is what may
 * follow the end of a sentence or a closing quotation mark, as the end of
 * the text may, and it begins no list item or table row after a line break
 * that ends the string; a line break before the next string is what the
 * start of a text is to a mark that opens there.
 *
 * Not a blank line: a run of line breaks sends the whole text down the
 * fold's slow path (text/normalise.ts), and a megabyte of JSON text cost a
 * quarter of a second read that way. And nothing that begins with a space:
 * a string that ended in one ran into it and read a character shorter than
 * the same text alone.
 */
export const BETWEEN_STRINGS = ')\n';

/** What stands between two lines of one text when the first does not end in a line break of its own. */
export const BETWEEN_LINES = '\n';

/**
 * A line of a text and the line before it, as they stand in the text: with
 * a line break between, unless the line before brought its own. A line that
 * ends in a carriage return is a line of a text with Windows line ends,
 * split at the line feed: the line feed is what is put back.
 */
export function lineBreakAfter(before: string): string {
  return before.charCodeAt(before.length - 1) === 10 ? '' : BETWEEN_LINES;
}

/**
 * A tool value as one text, with where each of its texts begins.
 *
 * A string that is not JSON text is the text itself and `starts` is null.
 * A structure is its strings joined by BETWEEN_STRINGS, the lines of one
 * text by a line break (eachString says which those are), and `starts`
 * holds the offset of each text, so a reader can keep what it reads inside
 * the text it began in. Reading stops once the text is longer than `limit`:
 * `cut` says the value held more, and `whole` is false when a part of it
 * lay deeper than is read or it held more values than are read.
 */
export function textOf(value: unknown, limit: number): { text: string; starts: number[] | null; cut: boolean; whole: boolean } {
  // A string longer than is read is not opened: what would be read of it is the start of a JSON text, which is no structure.
  const structure = typeof value !== 'string' ? value : value.length > limit ? undefined : jsonStructure(value);
  if (typeof value === 'string' && structure === undefined) return { text: value, starts: null, cut: value.length > limit, whole: true };
  const parts: string[] = [];
  const starts: number[] = [];
  let length = 0;
  let cut = false;
  let before = '';
  const walked = eachString(structure, (text, _isKey, continues) => {
    if (length > limit) {
      cut = true;
      return false;
    }
    if (continues) {
      // The next line of the text before it: no new text begins.
      const between = lineBreakAfter(before);
      parts.push(between);
      length += between.length;
    } else {
      if (parts.length > 0) {
        parts.push(BETWEEN_STRINGS);
        length += BETWEEN_STRINGS.length;
      }
      starts.push(length);
    }
    parts.push(text);
    length += text.length;
    before = text;
    return true;
  });
  const text = parts.join('');
  // The last string read may itself run past the limit: the value held more than is read then, as surely as when a string was left unvisited.
  return { text, starts, cut: cut || text.length > limit, whole: walked || cut };
}
