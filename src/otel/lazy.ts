// Process-wide lazy exporter — initialized on first use, then reused.
// Tests may reset it via __resetExporterForTests.

import { OtelExporter, exporterFromEnv } from './exporter.js';
import type { Trace } from '../types/trace.js';

let cachedExporter: OtelExporter | null | undefined; // undefined = not yet resolved

export function getLazyExporter(): OtelExporter | null {
  if (cachedExporter === undefined) {
    cachedExporter = exporterFromEnv();
  }
  return cachedExporter;
}

export function __resetExporterForTests(override?: OtelExporter | null): void {
  cachedExporter = override === undefined ? undefined : override;
}

// Fire-and-forget wrapper with inline error swallow. Runs in the
// background; the caller does NOT await. We log on failure so operators
// aren't surprised by silent drop, but never let an exporter problem
// bubble into user-visible tool errors.
export function bestEffortExport(
  trace: Trace,
  onError?: (err: Error) => void,
): void {
  const exporter = getLazyExporter();
  if (!exporter) return;

  exporter
    .exportTraces([trace])
    .then((result) => {
      if (!result.ok) {
        const msg = `OTel export failed: status=${result.status} ${result.error ?? ''}`.trim();
        onError?.(new Error(msg));
      }
    })
    .catch((err: Error) => onError?.(err));
}
