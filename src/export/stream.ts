import type { Writable } from 'node:stream';
import type { ExportEncoder } from './format.js';

/**
 * Write an export to a stream: the encoder's header, then each batch as it
 * arrives, waiting for 'drain' whenever the stream's buffer is full so a
 * slow reader (a browser saving to a slow disk, a pipe into another
 * program) holds back the reads instead of the server buffering the whole
 * export. Returns how many records were written.
 *
 * Stops early, without an error, when `aborted()` turns true (the client
 * went away) or the stream closes; the generator is closed on the way out
 * either way, so no read outlives the request. A read that throws is
 * rethrown for the caller to end the response with.
 */
export async function writeExport<T>(
  out: Writable,
  encoder: ExportEncoder<T>,
  batches: AsyncIterable<T[]>,
  aborted: () => boolean = () => false,
): Promise<number> {
  let written = 0;
  if (encoder.header !== '' && !out.write(encoder.header)) await drained(out);
  for await (const batch of batches) {
    if (aborted() || out.destroyed) break;
    written += batch.length;
    if (!out.write(encoder.batch(batch))) await drained(out);
  }
  return written;
}

/** Resolves on 'drain', or on 'close' when the reader goes away first, so a stalled download never pins the export. */
function drained(out: Writable): Promise<void> {
  if (out.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      out.off('drain', done);
      out.off('close', done);
      resolve();
    };
    out.once('drain', done);
    out.once('close', done);
  });
}
