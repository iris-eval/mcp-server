/*
 * The request size limit, parsed once into bytes.
 *
 * `security.requestSizeLimit` is a size string ('1mb', '500kb', '1048576').
 * It used to be handed to express as the string, which bounded HTTP bodies
 * only: the stdio transport read any message the SDK's 10 MB line buffer
 * would hold, so a 2 MB output was refused over HTTP and evaluated over
 * stdio. Both transports and the dashboard now read the number this module
 * returns, so one setting means one limit everywhere.
 *
 * Units are binary (1kb = 1024 bytes), the same reading express's own
 * parser gives the string, so an existing setting keeps its meaning. A value
 * this cannot read is refused at config load instead of silently meaning
 * "no limit", which is what express did with an unreadable string.
 */

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/** Bytes for a size string, or null when it is not one (`1mb`, `500kb`, `1.5mb`, `1048576`). */
export function parseSizeLimit(value: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
  if (!m) return null;
  const bytes = Math.floor(Number(m[1]) * UNITS[(m[2] ?? 'b').toLowerCase()]);
  return bytes > 0 ? bytes : null;
}

/** The bytes of one value that holds nothing: a string as JSON writes it, a number, `true`, `false`, `null`. */
function scalarJsonBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value).length : 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  return 4;
}

/**
 * The bytes of `value` as compact JSON, counted without writing it out.
 *
 * JSON.stringify calls itself once for each level, and on a value nested a
 * few thousand levels deep the stack runs out before it returns. This walk
 * keeps a list of its own, so it measures a value nested to any depth. For
 * a value JSON.parse returned it is `Buffer.byteLength(JSON.stringify(value))`:
 * the brackets, a comma between neighbours, each key with its colon, and
 * every string as JSON writes it. A key whose value is undefined is not
 * written, and an undefined array element is written `null`, as there.
 */
export function jsonByteLength(value: unknown): number {
  let bytes = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') {
      bytes += scalarJsonBytes(node);
    } else if (Array.isArray(node)) {
      bytes += 2 + Math.max(0, node.length - 1);
      for (const child of node) pending.push(child);
    } else {
      let members = 0;
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (child === undefined) continue;
        members += 1;
        bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
        pending.push(child);
      }
      bytes += 2 + Math.max(0, members - 1);
    }
  }
  return bytes;
}

/** The configured limit in bytes; throws with the setting's name when it cannot be read. */
export function requestSizeLimitBytes(value: string): number {
  const bytes = parseSizeLimit(value);
  if (bytes === null) {
    throw new Error(
      `security.requestSizeLimit "${value}" is not a size. Use a number of bytes or a number with kb, mb or gb, e.g. "1mb".`,
    );
  }
  return bytes;
}
