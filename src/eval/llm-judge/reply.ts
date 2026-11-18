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
 * The JSON object a reply IS, or null when the reply is anything else: the
 * whole text of the reply, or the whole of it inside a code fence. Prose
 * around an object, a list that holds one, and text that is not JSON are
 * each a reply that did not give the object.
 */
export function replyObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  // A model that fences its answer still gave the answer alone.
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
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
