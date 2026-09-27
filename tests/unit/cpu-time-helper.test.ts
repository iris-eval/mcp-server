/*
 * The linearity tripwires measure CPU time (tests/helpers/cpu-time.ts), so
 * a busy machine cannot fail them. This holds the two properties they rely
 * on: waiting is not counted, and work is.
 */
import { describe, it, expect } from 'vitest';
import { cpuMs, cpuMsAsync } from '../helpers/cpu-time.js';

describe('cpuMs', () => {
  it('does not count time spent waiting', () => {
    const started = performance.now();
    const cpu = cpuMs(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300));
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
    expect(cpu).toBeLessThan(150);
  });

  it('counts time spent computing', () => {
    const cpu = cpuMs(() => {
      const end = process.cpuUsage().user + 50_000;
      while (process.cpuUsage().user < end) {
        // spin for 50 ms of user CPU
      }
    });
    expect(cpu).toBeGreaterThanOrEqual(50);
  });

  it('cpuMsAsync does not count an await on a timer', async () => {
    const cpu = await cpuMsAsync(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(cpu).toBeLessThan(150);
  });
});
