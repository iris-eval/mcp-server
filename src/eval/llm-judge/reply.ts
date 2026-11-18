/*
 * Reading a judge's reply.
 *
 * A judge is asked for a single JSON object, with no prose before or after
 * it, and with a number in it: a score, a confidence. What comes back is
 * whatever the model wrote, and what is being judged can try to steer it.
 * So a reply is read only when it is what was asked for: the object alone,
 * and a number only where the reply gives a number.
 *
 * Until 0.22.0 both were read more freely than that, and each freedom
 * became a verdict. The object was cut out from the first brace of the
 * reply to the last, wherever they stood: a reply in prose that quoted one
 * object, from the text it was judging, was read as the judge's own answer.
 * And a field was converted with Number(), which makes a number of things
 * that are not one: `null`, `false`, `""` and `[]` all convert to 0, `true`
 * converts to 1, and `[0.9]` converts to 0.9.
 */

/**
 * A text with the white space at its two ends taken off: what `trim()`
 * takes, and four characters that have no width, which it does not (the
 * zero-width space, non-joiner and joiner, and the word joiner). A reply
 * that starts with one of those is still the reply, and an error could not
 * show what was wrong with it. No other character is taken.
 * One pass from each end, so the work does not grow with what a model
 * wrote in between.
 */
function bare(text: string): string {
  const edge = /[\s\u200b-\u200d\u2060]/;
  let start = 0;
  let end = text.length;
  while (start < end && edge.test(text[start])) start++;
  while (end > start && edge.test(text[end - 1])) end--;
  return text.slice(start, end);
}

/** The two characters a code fence is made of. */
const isFenceMark = (char: string | undefined): boolean => char === '`' || char === '~';

/**
 * A reply with its code fence taken off, when it has one: three or more
 * backticks, or three or more tildes.
 *
 * After the opening marks one word at most may stand: the language the
 * fence names, whatever characters it is written in, with or without a
 * space before it. Then the reply, on that line or on the next. More than
 * one word there is prose before the object, on a fence's own line as
 * anywhere else.
 *
 * A fence that is opened and not closed, or closed and not opened, is taken
 * off too: what is left is still the whole of what the model said.
 */
function withoutFence(text: string): string {
  let open = 0;
  if (isFenceMark(text[0])) while (text[open] === text[0]) open++;
  const rest = open >= 3 ? text.slice(open).replace(/^[ \t]*[^\s`{]*/, '') : text;
  const last = rest[rest.length - 1];
  let close = rest.length;
  if (isFenceMark(last)) while (close > 0 && rest[close - 1] === last) close--;
  return rest.length - close >= 3 ? rest.slice(0, close) : rest;
}

/**
 * The JSON object a reply IS, or null when the reply is anything else: the
 * whole text of the reply, or the whole of it inside a code fence. Prose
 * around an object, a list that holds one, and text that is not JSON are
 * each a reply that did not give the object.
 */
export function replyObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  // A model that fences its answer still gave the answer alone.
  const text = bare(withoutFence(bare(raw)));
  let parsed: unknown;
  try {
    // The whole text, so prose on either side of an object is text that does not parse.
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // A list, a number and a string are JSON and are not the object. So is `null`, which is returned as what it is.
  return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown> | null) : null;
}

/** The number a reply gives for a field that must be one from 0 to 1, or null when it gives none: not a JSON number, or one outside the range (which a number too large to hold is). */
export function unitNumber(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : null;
}

/** A value of a reply as an error message shows it: its JSON text, cut short. `no value` where the reply has no such field. */
export function shownValue(value: unknown): string {
  if (value === undefined) return 'no value';
  // JSON has no text for a number too large to hold, and would write it as null.
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = typeof value;
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** The start of a reply as an error message shows it. */
export function shownReply(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, 200) : `a reply of type ${typeof raw}`;
}
