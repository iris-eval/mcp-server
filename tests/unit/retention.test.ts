/*
 * The retention sweep runs at boot AND on a timer; the timer never keeps
 * the process alive; both paths are one function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRetentionSweep, scheduleRetentionSweep } from '../../src/retention.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { IStorageAdapter } from '../../src/types/query.js';

function fakeStorage(traces = 2, evals = 1, kept: { runId: string; traces: number; evaluations: number } | null = null) {
  return {
    deleteTracesOlderThan: vi.fn(async () => traces),
    deleteEvalResultsOlderThan: vi.fn(async () => evals),
    keptPastRetention: vi.fn(async () => kept),
    checkpoint: vi.fn(async () => undefined),
  } as unknown as IStorageAdapter & { deleteTracesOlderThan: ReturnType<typeof vi.fn>; deleteEvalResultsOlderThan: ReturnType<typeof vi.fn>; checkpoint: ReturnType<typeof vi.fn> };
}
const logger = { info: vi.fn(), warn: vi.fn() };

describe('retention', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the shipped default sweeps every 24 hours', () => {
    expect(defaultConfig.retention.sweepIntervalHours).toBe(24);
    expect(defaultConfig.retention.days).toBe(30);
  });

  it('one sweep deletes traces and evaluations older than the window and checkpoints when anything went', async () => {
    const storage = fakeStorage();
    const out = await runRetentionSweep(storage, defaultConfig, logger);
    expect(out).toEqual({ deletedTraces: 2, deletedEvals: 1, deletedBackups: 0, kept: null });
    expect(storage.deleteTracesOlderThan).toHaveBeenCalledWith(expect.anything(), 30);
    expect(storage.checkpoint).toHaveBeenCalledTimes(1);
    const quiet = fakeStorage(0, 0);
    await runRetentionSweep(quiet, defaultConfig, logger);
    expect(quiet.checkpoint).not.toHaveBeenCalled();
  });

  it('a sweep that keeps the pinned baseline run past the window says so, with the run and the counts', async () => {
    const info = vi.fn();
    const out = await runRetentionSweep(fakeStorage(0, 0, { runId: 'release-1', traces: 40, evaluations: 40 }), defaultConfig, { info, warn: vi.fn() });
    expect(out?.kept).toEqual({ runId: 'release-1', traces: 40, evaluations: 40 });
    expect(info).toHaveBeenCalledWith(
      'Retention cleanup: kept 40 trace(s) and 40 evaluation(s) older than 30 days: they belong to the pinned baseline run release-1. Unpin the run and the next sweep deletes them.',
    );
    // Nothing kept, nothing said.
    const quiet = vi.fn();
    await runRetentionSweep(fakeStorage(0, 0), defaultConfig, { info: quiet, warn: vi.fn() });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('a sweep whose report of what was kept fails still reports what it deleted', async () => {
    const storage = fakeStorage();
    (storage as unknown as { keptPastRetention: () => Promise<never> }).keptPastRetention = async () => {
      throw new Error('database is locked');
    };
    const warn = vi.fn();
    const out = await runRetentionSweep(storage, defaultConfig, { info: vi.fn(), warn });
    expect(out).toEqual({ deletedTraces: 2, deletedEvals: 1, deletedBackups: 0, kept: null });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not count what the pinned baseline run keeps past the window: database is locked/));
  });

  it('the timer fires the same sweep every sweepIntervalHours and is unref\'d so it never holds the process open', async () => {
    const storage = fakeStorage();
    const config = structuredClone(defaultConfig);
    config.retention.sweepIntervalHours = 1;
    const timer = scheduleRetentionSweep(storage, config, logger)!;
    expect(timer).not.toBeNull();
    expect(typeof timer.hasRef === 'function' ? timer.hasRef() : false).toBe(false);
    expect(storage.deleteTracesOlderThan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(storage.deleteTracesOlderThan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(storage.deleteTracesOlderThan).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  it('no timer when retention is off or the interval is 0', () => {
    const off = structuredClone(defaultConfig);
    off.retention.days = 0;
    expect(scheduleRetentionSweep(fakeStorage(), off, logger)).toBeNull();
    const noTimer = structuredClone(defaultConfig);
    noTimer.retention.sweepIntervalHours = 0;
    expect(scheduleRetentionSweep(fakeStorage(), noTimer, logger)).toBeNull();
  });

  it('a failing sweep is logged and returns null instead of throwing', async () => {
    const storage = fakeStorage();
    storage.deleteTracesOlderThan.mockRejectedValueOnce(new Error('disk gone'));
    expect(await runRetentionSweep(storage, defaultConfig, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk gone'));
  });
});
