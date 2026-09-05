/*
 * Retention — the sweep that keeps `retention.days` true.
 *
 * It used to run once, at startup. A server that runs for a month never
 * swept again, so "traces older than 30 days are deleted" held only on
 * the day the process started. The sweep now also runs on a timer
 * (`retention.sweepIntervalHours`, default 24, 0 disables the timer) that
 * never keeps the process alive on its own (`unref`), and both paths are
 * one function so they cannot drift.
 *
 * The sweep deletes traces (spans cascade) and evaluations by their own
 * age; an evaluation younger than the window whose trace is swept keeps
 * its scores and loses its text (see SqliteAdapter.deleteTracesOlderThan).
 */
import type { IrisConfig } from './types/config.js';
import type { IStorageAdapter } from './types/query.js';
import { LOCAL_TENANT } from './types/tenant.js';

export interface RetentionLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface SweepOutcome {
  deletedTraces: number;
  deletedEvals: number;
}

/**
 * One sweep for the local tenant. Never throws — a failed sweep is logged
 * and the server keeps serving; the next tick tries again.
 */
export async function runRetentionSweep(storage: IStorageAdapter, config: IrisConfig, logger: RetentionLogger): Promise<SweepOutcome | null> {
  if (config.retention.days <= 0) return null;
  try {
    const deletedTraces = await storage.deleteTracesOlderThan(LOCAL_TENANT, config.retention.days);
    /*
     * Evaluations too (#372). Deleting a trace only NULLs trace_id on
     * its evaluations, so every eval row — output_text verbatim,
     * including whatever no_pii flagged — used to outlive the retention
     * window indefinitely while the traces around it were swept.
     */
    const deletedEvals = await storage.deleteEvalResultsOlderThan(LOCAL_TENANT, config.retention.days);
    if (deletedTraces + deletedEvals > 0) {
      // Fold the WAL into the main file and truncate it, so the swept
      // rows do not survive as readable text in iris.db-wal.
      await storage.checkpoint();
      logger.info(`Retention cleanup: deleted ${deletedTraces} trace(s) and ${deletedEvals} evaluation(s) older than ${config.retention.days} days`);
    }
    return { deletedTraces, deletedEvals };
  } catch (err) {
    logger.warn(`Retention cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The timer. Returns the handle (already unref'd) so a caller can clear it
 * on shutdown, or null when retention or the timer is disabled.
 */
export function scheduleRetentionSweep(storage: IStorageAdapter, config: IrisConfig, logger: RetentionLogger): NodeJS.Timeout | null {
  const hours = config.retention.sweepIntervalHours;
  if (config.retention.days <= 0 || !(hours > 0)) return null;
  const timer = setInterval(() => {
    void runRetentionSweep(storage, config, logger);
  }, hours * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
