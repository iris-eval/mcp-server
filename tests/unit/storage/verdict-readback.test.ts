/*
 * A stored verdict reads back as the verdict the caller was given.
 *
 * The read path re-composes from the row's provenance, so every composer
 * fact that can change a verdict has to be in it. Two were missing:
 *
 *   - priorMode. A deployment on eval.priorMode "per-class" was handed
 *     fail / risk_over_loss for a clean output, and the same row read back
 *     under the per-output default as pass / clean.
 *   - the calibration table. The confidence label is read from a table the
 *     corpus regenerates; re-deriving a stored label under a newer table
 *     silently changed history. The label is now re-derived only under the
 *     table it was given with, and otherwise withheld with a note.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { PUBLISHED_CALIBRATION } from '../../../src/eval/published-calibration.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalResult } from '../../../src/types/eval.js';

const CLEAN = {
  input: 'What is the capital of France?',
  output: 'The capital of France is Paris. It has been the capital since the tenth century.',
};

const dirs: string[] = [];
const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function store(): Promise<SqliteAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-readback-'));
  dirs.push(dir);
  const s = new SqliteAdapter(join(dir, 'iris.db'));
  await s.initialize();
  stores.push(s);
  return s;
}

const shape = (r: EvalResult) => ({
  passed: r.passed,
  state: r.verdict?.state,
  basis: r.verdict?.basis,
  pBad: r.verdict?.risk?.pBad,
  confidence: r.verdict?.confidence,
  interpretations: r.interpretations?.map((i) => i.text),
});

describe('a stored verdict reads back as given', () => {
  it('under eval.priorMode "per-class": the fail the caller was handed is the fail the row reads back', async () => {
    const s = await store();
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, priorMode: 'per-class' });
    const written = await engine.evaluateAll(CLEAN);
    // Read per class, the prior blocks nearly everything: this is the verdict the deployment chose.
    expect(written.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    expect(written.provenance?.composer).toMatchObject({ priorMode: 'per-class' });
    await s.insertEvalResult(LOCAL_TENANT, written);
    const read = (await s.getEvalById(LOCAL_TENANT, written.id))!;
    expect(shape(read)).toEqual(shape(written));
  });

  it('at the defaults: the row is stamped with the calibration table and reads back with the same label and notes', async () => {
    const s = await store();
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const written = await engine.evaluateAll(CLEAN);
    expect(written.provenance?.composer).toMatchObject({ priorMode: 'per-output', calibration: PUBLISHED_CALIBRATION.compositeVersion });
    expect(written.verdict?.confidence).toBeDefined();
    await s.insertEvalResult(LOCAL_TENANT, written);
    const read = (await s.getEvalById(LOCAL_TENANT, written.id))!;
    expect(shape(read)).toEqual(shape(written));
  });

  for (const [what, calibration] of [
    ['labelled under another calibration table', '000000000000'],
    ['stored before the table was stamped', undefined],
  ] as const) {
    it(`${what}: the verdict is unchanged, the label is withheld, and a note says why`, async () => {
      const s = await store();
      const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
      const written = await engine.evaluateAll(CLEAN);
      const composer = { ...written.provenance!.composer! };
      if (calibration === undefined) delete composer.calibration;
      else composer.calibration = calibration;
      written.provenance = { ...written.provenance!, composer };
      await s.insertEvalResult(LOCAL_TENANT, written);
      const read = (await s.getEvalById(LOCAL_TENANT, written.id))!;
      expect({ passed: read.passed, state: read.verdict?.state, basis: read.verdict?.basis, pBad: read.verdict?.risk?.pBad }).toEqual({
        passed: written.passed,
        state: written.verdict?.state,
        basis: written.verdict?.basis,
        pBad: written.verdict?.risk?.pBad,
      });
      expect(read.verdict?.confidence).toBeUndefined();
      const texts = (read.interpretations ?? []).map((i) => i.text);
      expect(texts.some((t) => t.includes('carries no confidence label'))).toBe(true);
      // The note names what happened in words; a table's internal id is not shown.
      expect(texts.join(' ')).toContain(calibration ? 'an earlier calibration' : 'before verdicts recorded');
      if (calibration) expect(texts.join(' ')).not.toContain(calibration);
    });
  }
});
