/*
 * Reading a judge's reply.
 *
 * A judge is asked for a single JSON object, with a number in it: a score,
 * a confidence. Where the provider and the model offer structured output,
 * the object is asked for as that (answer.ts, client.ts): the reply is the
 * object alone, and it is read whole (wholeObject), so nothing a model
 * writes, and nothing it quotes, stands beside the answer and is read as it.
 * A model that offers none is asked in text, and its object is read from the
 * reply's first opening brace to its last closing brace (replyObject), so a
 * model that writes a sentence before it, or a code fence around it, still
 * gives its answer on one call. Either way, a field of the object is read
 * only when the reply gives it as the template asks: a number from 0 to 1,
 * or a boolean.
 *
 * Until 0.22.0 a field was converted with Number(), which makes a number of
 * things that are not one: `null`, `false`, `""` and `[]` all convert to 0,
 * `true` converts to 1, and `[0.9]` converts to 0.9. Each became a verdict
 * from a reply that gave none.
 */

/**
 * The JSON object a reply holds, or null when it holds none: the text from
 * its first opening brace to its last closing brace, read as JSON. A reply
 * that is not text holds none.
 */
export function replyObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    // The text starts with an opening brace, so what parses is an object.
    return JSON.parse(raw.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The JSON object a reply asked for as structured output is, or null when it
 * is not one: the whole reply read as JSON, with nothing cut from around it.
 */
export function wholeObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The answer object of a reply: read whole where it was asked for as structured output, else from its first brace to its last. */
export function answerObject(raw: unknown, structured: boolean | undefined): Record<string, unknown> | null {
  return structured === true ? wholeObject(raw) : replyObject(raw);
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
