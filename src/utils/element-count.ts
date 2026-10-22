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

/** The answer to a body over the limit: a sentence naming the limit and the setting, and the limit. */
export function tooManyElementsBody(limit: number): { error: string; limit: number } {
  return {
    error:
      `The request body holds more than ${limit} array elements and object keys, the limit (security.maxInputElements, ` +
      'or IRIS_MAX_INPUT_ELEMENTS). Nothing was read or stored. Send it in smaller parts, or raise the limit.',
    limit,
  };
}
