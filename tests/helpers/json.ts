/*
 * Narrowing a JSON body a test received.
 *
 * `Response.json()` answers `unknown`, which is the truth: the server under
 * test decides the shape. These check the shape before a test reads it, so
 * a changed response fails on the line that names what arrived instead of
 * as `undefined` three assertions later.
 */

/** A JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a JSON object; throws naming what it was instead. */
export function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected a JSON object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`);
  return value;
}
