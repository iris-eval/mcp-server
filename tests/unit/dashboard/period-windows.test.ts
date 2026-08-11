import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evalStatsPeriodSchema } from '../../../src/dashboard/validation.js';

/*
 * The Health view derives its "vs prior period" comparison by requesting a
 * DOUBLE-WIDTH window and subtracting the current one. That arithmetic was
 * always right — but the server's enum only accepted 24h/7d/30d/all, so the
 * doubled window came back 400 and EVERY delta on the default screen
 * rendered "—". It had never worked once. The selector also offered 90d,
 * which the server rejected outright.
 *
 * Two bugs, one shape: the UI's vocabulary was wider than the server's, and
 * nothing tested the two against each other.
 *
 * This test reads the ACTUAL selector source rather than restating its
 * options here. A copy of the list would drift the moment someone adds a
 * period to the UI — which is precisely the bug being fixed.
 */

function periodsOfferedByTheUI(): Array<{ id: string; days: number }> {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../dashboard/src/components/dashboard/PeriodSelector.tsx'),
    'utf-8',
  );
  const options = [...source.matchAll(/\{\s*id:\s*'([^']+)'\s*,\s*label:\s*'[^']*'\s*,\s*days:\s*(\d+)\s*\}/g)];
  if (options.length === 0) {
    throw new Error('could not parse PERIOD_OPTIONS — the selector shape changed, update this test');
  }
  return options.map((m) => ({ id: m[1], days: Number(m[2]) }));
}

describe('period vocabulary: the UI and the server agree', () => {
  it('the server accepts every period the selector can produce', () => {
    for (const { id } of periodsOfferedByTheUI()) {
      expect(
        evalStatsPeriodSchema.safeParse({ period: id }).success,
        `the selector offers "${id}" but the server rejects it`,
      ).toBe(true);
    }
  });

  it('the server accepts the DOUBLED window behind every selector period', () => {
    // HealthView asks for `${periodToDays(p) * 2}d` to compute the prior
    // window. If the server can't answer that, the delta silently dies.
    for (const { id, days } of periodsOfferedByTheUI()) {
      const prior = `${days * 2}d`;
      expect(
        evalStatsPeriodSchema.safeParse({ period: prior }).success,
        `comparison for "${id}" requests "${prior}", which the server rejects — the delta renders "—"`,
      ).toBe(true);
    }
  });

  it('still rejects nonsense', () => {
    for (const bad of ['5d', 'yesterday', '30D', 'ALL', 'drop table']) {
      expect(evalStatsPeriodSchema.safeParse({ period: bad }).success).toBe(false);
    }
  });
});
