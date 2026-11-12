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
 */

/** How many times a string that is itself JSON text is opened: a result inside a result inside a result. */
export const MAX_JSON_TEXT_DEPTH = 3;
/**
 * How deep a structure is read. A value parsed from a request is nowhere
 * near it; a structure that refers to itself, which only a caller of the
 * engine in code can build, reaches it, and the reading then stops and says
 * so.
 */
export const MAX_VALUE_DEPTH = 1_000;

/** The structure a string holds when it is the JSON text of an object or an array, and undefined when it is not. */
export function jsonStructure(text: string): object | undefined {
  let from = 0;
  while (from < text.length && text.charCodeAt(from) <= 32) from += 1;
  const first = text[from];
  if (first !== '{' && first !== '[') return undefined;
  let to = text.length - 1;
  while (to > from && text.charCodeAt(to) <= 32) to -= 1;
  if (text[to] !== (first === '{' ? '}' : ']')) return undefined;
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

type Pending = { value: unknown; level: number; opened: number } | { key: string };

/**
 * Every string of a tool value, in the order stableStringify writes them:
 * `visit(text, isKey)` for each key and each string value. Numbers, true,
 * false and null are not text. `visit` may return false to stop.
 *
 * Returns whether the value was read whole: false when `visit` stopped it
 * or a part of it lay deeper than MAX_VALUE_DEPTH.
 *
 * It keeps its own list of what is still to be read where a function that
 * calls itself would use the stack, so a value nested thousands deep is
 * read like any other.
 */
export function eachString(value: unknown, visit: (text: string, isKey: boolean) => boolean | void): boolean {
  const pending: Pending[] = [{ value, level: 0, opened: 0 }];
  let whole = true;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if ('key' in item) {
      if (visit(item.key, true) === false) return false;
      continue;
    }
    const { level, opened } = item;
    let current = item.value;
    if (typeof current === 'string') {
      const inner = opened < MAX_JSON_TEXT_DEPTH ? jsonStructure(current) : undefined;
      if (inner === undefined) {
        if (visit(current, false) === false) return false;
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
      for (let i = current.length - 1; i >= 0; i -= 1) pending.push({ value: current[i], level: level + 1, opened: item.opened });
      continue;
    }
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      pending.push({ value: record[keys[i]], level: level + 1, opened: item.opened });
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

/**
 * A tool value as one text, with where each of its strings begins.
 *
 * A string that is not JSON text is the text itself and `starts` is null.
 * A structure is its strings joined by BETWEEN_STRINGS, and `starts` holds
 * the offset of each, so a reader can keep what it reads inside the string
 * it began in. Reading stops once the text is longer than `limit`: `cut`
 * says the value held more, and `whole` is false when a part of it lay
 * deeper than is read.
 */
export function textOf(value: unknown, limit: number): { text: string; starts: number[] | null; cut: boolean; whole: boolean } {
  // A string longer than is read is not opened: what would be read of it is the start of a JSON text, which is no structure.
  const structure = typeof value !== 'string' ? value : value.length > limit ? undefined : jsonStructure(value);
  if (typeof value === 'string' && structure === undefined) return { text: value, starts: null, cut: value.length > limit, whole: true };
  const parts: string[] = [];
  const starts: number[] = [];
  let length = 0;
  let cut = false;
  const walked = eachString(structure, (text) => {
    if (length > limit) {
      cut = true;
      return false;
    }
    if (parts.length > 0) length += BETWEEN_STRINGS.length;
    starts.push(length);
    parts.push(text);
    length += text.length;
    return true;
  });
  const text = parts.join(BETWEEN_STRINGS);
  // The last string read may itself run past the limit: the value held more than is read then, as surely as when a string was left unvisited.
  return { text, starts, cut: cut || text.length > limit, whole: walked || cut };
}
