/*
 * The retention sweep runs at boot AND on a timer; the timer never keeps
 * the process alive; both paths are one function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRetentionSweep, scheduleRetentionSweep } from '../../src/retention.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { IStorageAdapter } from '../../src/types/query.js';

function fakeStorage(traces = 2, evals = 1) {
  return {
    deleteTracesOlderThan: vi.fn(async () => traces),
    deleteEvalResultsOlderThan: vi.fn(async () => evals),
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
    expect(out).toEqual({ deletedTraces: 2, deletedEvals: 1 });
    expect(storage.deleteTracesOlderThan).toHaveBeenCalledWith(expect.anything(), 30);
    expect(storage.checkpoint).toHaveBeenCalledTimes(1);
    const quiet = fakeStorage(0, 0);
    await runRetentionSweep(quiet, defaultConfig, logger);
    expect(quiet.checkpoint).not.toHaveBeenCalled();
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
