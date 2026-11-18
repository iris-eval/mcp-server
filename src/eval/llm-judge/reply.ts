/*
 * Reading a value out of a judge's reply.
 *
 * A judge is asked for JSON with a number in it: a score, a confidence. What
 * comes back is whatever the model wrote, and what is being judged can try
 * to steer it. So a field is read as a number only when the reply gives a
 * number there. Converted with Number(), a reply that gave none was read as
 * having given one: `null`, `false`, `""` and `[]` all convert to 0, `true`
 * converts to 1, and `[0.9]` converts to 0.9. Each of those became a verdict.
 */

/** The number a reply gives for a field that must be one from 0 to 1, or null when it gives none: not a JSON number, not finite, or outside the range. */
export function unitNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** A value of a reply as an error message shows it: its JSON text, cut short. `undefined` where the reply has no such field. */
export function shownValue(value: unknown): string {
  if (value === undefined) return 'no value';
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = typeof value;
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
