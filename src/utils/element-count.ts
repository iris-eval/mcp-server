/*
 * The size of a parsed input in elements: every array element and every
 * own object key, counted the way the MCP SDK counts a tool call's
 * arguments (toolInputElementCount in @modelcontextprotocol/sdk's
 * server/mcp.js), so one setting (security.maxInputElements) means the
 * same number on every door.
 *
 * Validation cost grows with the element count, not the byte count: an
 * input that fails validation is reported element by element. So an input
 * is counted before any schema reads it, and refused when it holds more
 * than the limit. The count stops at limit + 1 and walks iteratively, so
 * counting an oversized or deeply nested input costs little and cannot
 * overflow the stack.
 */

/** Array elements plus own object keys in `value`; stops once the count passes `max`. Bytes (a Buffer or any typed array) are not elements and count 0. */
export function countElements(value: unknown, max: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || ArrayBuffer.isView(node)) continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > max) return count;
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++count > max) return count;
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  return count;
}

/**
 * How deep `value` nests: a string, a number, a boolean or null is 0 levels,
 * and an array or an object is one level more than the deepest thing it
 * holds, so `{}` is 1 and `{"a":{"a":1}}` is 2. Bytes (a Buffer or any
 * typed array) are not a level, as they are not elements.
 *
 * Several rules write an input out with a function that calls itself once
 * for each level, and past a few thousand levels the stack runs out: the
 * rule gives no answer and takes no part in the verdict (#1040). So an
 * input is measured before any rule reads it, and refused when it nests
 * deeper than the limit (security.maxInputDepth). The walk keeps a list of
 * its own, so an input nested deeper than the stack holds is measured like
 * any other, and it stops at the first thing it finds past `max`: what it
 * returns is then `max + 1`.
 */
export function nestingDepth(value: unknown, max: number): number {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return 0;
  let deepest = 0;
  // The arrays and objects still to read, and beside each the level it stands at.
  const stack: object[] = [value];
  const levels: number[] = [1];
  while (stack.length > 0) {
    const node = stack.pop() as object;
    const level = levels.pop() as number;
    if (level > deepest) {
      deepest = level;
      if (deepest > max) return deepest;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        if (child !== null && typeof child === 'object' && !ArrayBuffer.isView(child)) {
          stack.push(child);
          levels.push(level + 1);
        }
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object' && !ArrayBuffer.isView(child)) {
          stack.push(child);
          levels.push(level + 1);
        }
      }
    }
  }
  return deepest;
}

/**
 * The deepest input any rule is asked to read, by whatever road it came.
 * The engine measures every evaluation's input before the first rule and
 * refuses one nested deeper (src/eval/engine.ts). The doors stand in front
 * of every request; this stands in front of what no door does: a trace
 * stored before the limit existed, a file the command line reads, an
 * embedder's own call. It is a constant and not a setting, and it is the
 * most security.maxInputDepth can be set to: so nothing a door lets in is
 * refused here, and nothing let in here is deep enough for a rule to give
 * no answer on it.
 */
export const MAX_EVALUATED_DEPTH = 512;

/**
 * Whether what a rule is about to be handed nests deeper than any rule is
 * asked to read. One measure for every caller of a rule: the engine takes it
 * before the first rule of an evaluation, and the dashboard's rule preview,
 * which hands a rule a stored trace without an evaluation, takes it for
 * each trace.
 */
export function nestsDeeperThanEvaluated(context: unknown): boolean {
  return nestingDepth(context, MAX_EVALUATED_DEPTH) > MAX_EVALUATED_DEPTH;
}

/**
 * How deep a JSON text may nest and still be read as the value it encodes,
 * where a string that holds JSON is read so (jsonTextDepth, below). It is
 * the default of security.maxInputDepth, and a constant: the places that
 * read such a string are inside the evaluator, which has no settings.
 */
export const MAX_JSON_TEXT_DEPTH = 256;

/**
 * How deep a JSON text nests, read off the text without parsing it: the
 * most arrays and objects that stand open at one place outside its strings.
 * The value a JSON text parses to nests no deeper than this, and exactly
 * this deep unless an object writes one key twice: only the last value of
 * such a key is kept, so the text can nest deeper than the value does. It
 * stops at the first bracket past `max`, and returns `max + 1`.
 *
 * A string is no level to a door, and several places read a string that
 * holds JSON as the value it encodes (a span's arguments, an object output
 * written as text): the value is then as deep as the text nests, after the
 * door has measured it. Those places ask this first, and read a text nested
 * deeper than the limit as the text it is.
 */
export function jsonTextDepth(text: string, max: number): number {
  let open = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      // The character after a backslash belongs to the string, a quotation mark among them.
      if (c === 0x5c) i += 1;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      open += 1;
      if (open > deepest) {
        deepest = open;
        if (deepest > max) return deepest;
      }
    } else if (c === 0x7d || c === 0x5d) {
      open -= 1;
    }
  }
  return deepest;
}

/**
 * What a door says of an input nested deeper than the limit, after naming it (`The request body nests`): the limit, the setting, and what to do.
 * The limit can be raised only as far as MAX_EVALUATED_DEPTH, so a door that already stands there does not say to raise it.
 */
export function tooDeepMessage(itNests: string, limit: number): string {
  return (
    `${itNests} more than ${limit} levels deep, the limit (security.maxInputDepth, or IRIS_MAX_INPUT_DEPTH). ` +
    'Nothing was read or stored. Send the nested value flatter or as text' +
    (limit < MAX_EVALUATED_DEPTH ? ', or raise the limit.' : `: the limit is at its highest, and no evaluation reads an input nested deeper than ${MAX_EVALUATED_DEPTH} levels.`)
  );
}

/** The answer to a body nested deeper than the limit: that sentence, and the limit. */
export function tooDeepBody(limit: number): { error: string; limit: number } {
  return { error: tooDeepMessage('The request body nests', limit), limit };
}

/**
 * An evaluation was handed an input nested deeper than the engine reads, by
 * a road no door stands on: a trace stored before the limit existed, a file
 * read by the command line, an embedder's own call. The engine measures
 * every context before a rule reads it and refuses with this, so that no
 * rule is left to give no answer on it. `status` is what the dashboard
 * answers with.
 *
 * The limit it names is MAX_EVALUATED_DEPTH, which no setting moves: the
 * message does not send its reader to security.maxInputDepth, whose most
 * is that same number.
 */
export class InputTooDeepError extends Error {
  readonly status = 422;
  constructor(readonly limit: number) {
    super(
      `The input to this evaluation nests more than ${limit} levels deep, the deepest an evaluation reads, so no rule read it. ` +
        'A rule that writes an input out gives no answer on one nested much deeper than this. No setting raises this limit.',
    );
    this.name = 'InputTooDeepError';
  }
}

/** The answer to a body over the limit: a sentence naming the limit and the setting, and the limit. */
export function tooManyElementsBody(limit: number): { error: string; limit: number } {
  return {
    error:
      `The request body holds more than ${limit} array elements and object keys, the limit (security.maxInputElements, ` +
      'or IRIS_MAX_INPUT_ELEMENTS). Nothing was read or stored. Send it in smaller parts, or raise the limit.',
    limit,
  };
}
