/*
 * How long an evaluation takes (arc 9, N-22).
 *
 * Every compare page says Iris evaluates "in-process, no model call", and
 * every incumbent's page answers the latency question with a number. Iris
 * had none, and the hardcoded-claim scanner's `latency-claim-without-
 * measurement` pattern correctly refused to let anyone type one. This
 * measures it.
 *
 * What is measured: `EvalEngine.evaluateAll(context)` — the exact call the
 * `evaluate_output` tool makes for the default eval type, over every case in
 * the proof corpus, so the spread of outputs is the spread the rules were
 * measured on rather than one convenient string. Storage is NOT in it: the
 * tool also writes the row, and a SQLite insert is a different question with
 * a different answer on a different disk.
 *
 * The first cases are discarded. A cold JIT would otherwise be reported as
 * the product's latency, which is true of no deployment that has served two
 * requests.
 *
 * Numbers vary by machine, so this block is EXCLUDED from `npm run proof --
 * --check`: the runner re-measures on every machine and CI would otherwise
 * fail on the difference between its runner and a laptop. What CI does hold
 * is that a number published anywhere equals the one in the truthbase
 * (scripts/claims/check-no-hardcoded.mjs, pattern `eval-latency`), and the
 * page says which machine produced it.
 */
import { cpus, arch, platform } from 'node:os';
import type { EvalEngine } from '../../src/eval/engine.js';
import type { EvalContext } from '../../src/types/eval.js';

/** Cases discarded before timing starts, so a cold JIT is not the claim. */
export const WARMUP = 25;

export interface LatencyResults {
  /** The call that was timed, in the words of the tool that makes it. */
  method: string;
  /** Timed evaluations, warm-up excluded. */
  n: number;
  p50Ms: number;
  p95Ms: number;
  /** The machine the numbers came from — without it a millisecond means nothing. */
  machine: { node: string; platform: string; arch: string; cpu: string };
}

/** The pth percentile by nearest rank, on a sorted ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

export async function measureLatency(engine: EvalEngine, contexts: readonly EvalContext[]): Promise<LatencyResults> {
  for (let i = 0; i < Math.min(WARMUP, contexts.length); i += 1) {
    await engine.evaluateAll(contexts[i % contexts.length]);
  }
  const samples: number[] = [];
  for (const context of contexts) {
    const started = performance.now();
    await engine.evaluateAll(context);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return {
    method: `EvalEngine.evaluateAll — the call evaluate_output makes — over every case in the proof corpus, ${WARMUP} warm-up runs discarded, storage excluded`,
    n: samples.length,
    p50Ms: round(percentile(samples, 50)),
    p95Ms: round(percentile(samples, 95)),
    machine: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model.trim() ?? 'unknown' },
  };
}
