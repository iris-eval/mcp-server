import type { Response } from 'express';
import { CONTENT_TYPE, exportFilename, type ExportEncoder, type ExportFormat, type ExportKind } from '../export/format.js';
import { writeExport } from '../export/stream.js';

/**
 * Answer a request with a streamed export (#4).
 *
 * The first batch is read before anything is sent, so a failure in the
 * query itself is still an ordinary JSON error with its status. After the
 * headers are out, a failure can no longer change the status: the
 * connection is destroyed instead of ended, so the browser marks the
 * download failed and curl reports a partial transfer — a truncated file
 * is never delivered as a complete one.
 *
 * `Cache-Control: no-store` because an export is the stored text itself;
 * no cache between the server and the browser keeps a copy.
 */
export async function sendExport<T>(
  res: Response,
  kind: ExportKind,
  format: ExportFormat,
  encoder: ExportEncoder<T>,
  batches: AsyncGenerator<T[]>,
): Promise<void> {
  const first = await batches.next();

  res.status(200);
  res.setHeader('Content-Type', CONTENT_TYPE[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(kind, format)}"`);
  res.setHeader('Cache-Control', 'no-store');

  let gone = false;
  res.on('close', () => {
    if (!res.writableFinished) gone = true;
  });

  async function* all(): AsyncGenerator<T[]> {
    if (first.done) return;
    yield first.value;
    yield* batches;
  }

  try {
    await writeExport(res, encoder, all(), () => gone);
  } catch (err) {
    res.destroy(err instanceof Error ? err : new Error(String(err)));
    return;
  } finally {
    // Closes the storage read when the loop stopped early.
    await batches.return(undefined);
  }
  if (!gone) res.end();
}
