/*
 * How long an evaluation takes is measured, not typed.
 *
 * Every incumbent's page answers the latency question with a number and
 * Iris had none — the hardcoded-claim scanner refused one, correctly,
 * because nothing had measured it. `npm run proof` measures it now through
 * the call `evaluate_output` makes, over the same corpus the rules were
 * measured on, and the number travels with the machine that produced it.
 *
 * Held here: the percentile is the one the report claims (nearest rank, not
 * an interpolation); the markers let `--check` ignore a number that is a
 * property of the machine, and stripping them leaves exactly what a render
 * without the section produces; the truthbase carries the block; and the
 * proof page reads it rather than typing it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { percentile, WARMUP } from '../proof/lib/latency.js';
import { LATENCY_START, LATENCY_END, stripLatency } from '../proof/run.js';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const claims = JSON.parse(read('.claims.json')) as {
  proof?: { latency?: { method: string; n: number; p50Ms: number; p95Ms: number; machine: { node: string; platform: string; arch: string; cpu: string } } };
};

describe('the latency measurement', () => {
  it('takes the percentile by nearest rank, so the reported figure is a sample that was observed', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
    // Every reported value is one of the samples — never an average of two.
    for (const p of [1, 25, 50, 75, 95, 99]) expect(sorted).toContain(percentile(sorted, p));
  });

  it('discards a warm-up, so a cold JIT is not published as the product’s latency', () => {
    expect(WARMUP).toBeGreaterThan(0);
    expect(read('proof/lib/latency.ts')).toContain('performance.now()');
  });

  it('marks its section in RESULTS.md so the byte comparison can ignore the machine, and stripping it leaves the file a render without it produces', () => {
    const md = read('proof/RESULTS.md');
    expect(md).toContain(LATENCY_START);
    expect(md).toContain(LATENCY_END);
    const stripped = stripLatency(md);
    expect(stripped).not.toContain(LATENCY_START);
    expect(stripped).not.toContain('How long one evaluation takes');
    // Exactly one line gone from the surroundings: the section and no more.
    const before = md.slice(0, md.indexOf(LATENCY_START));
    const after = md.slice(md.indexOf(LATENCY_END) + LATENCY_END.length + 1);
    expect(stripped).toBe(before + after);
    expect(stripLatency('no markers here')).toBe('no markers here');
  });

  it('is in the truthbase with the machine that produced it, and the numbers are plausible for an in-process evaluation', () => {
    const l = claims.proof?.latency;
    expect(l, 'proof.latency in .claims.json — run `npm run proof`').toBeDefined();
    expect(l!.n).toBeGreaterThan(100);
    expect(l!.p50Ms).toBeGreaterThan(0);
    expect(l!.p95Ms).toBeGreaterThanOrEqual(l!.p50Ms);
    // A local rule pass that takes a second is a bug, not a measurement.
    expect(l!.p95Ms).toBeLessThan(1000);
    expect(l!.method).toContain('evaluateAll');
    for (const k of ['node', 'platform', 'arch', 'cpu'] as const) expect(String(l!.machine[k]).length).toBeGreaterThan(1);
  });

  it('the published truthbase schema describes the block, and the proof page reads it instead of typing a number', () => {
    const schema = JSON.parse(read('website/public/claims-schema-v1.json')) as { properties: { proof: { properties: Record<string, { required?: string[] }> } } };
    const latency = schema.properties.proof.properties.latency;
    expect(latency, 'proof.latency in claims-schema-v1.json').toBeDefined();
    expect(latency.required).toEqual(['method', 'n', 'p50Ms', 'p95Ms', 'machine']);

    const page = read('website/src/app/proof/page.tsx');
    expect(page).toContain('PROOF?.latency');
    expect(page).toContain('{l.p50Ms} ms');
    expect(page).toContain('{l.machine.cpu}');
    // The scanner's pattern is what keeps a number out of any other surface.
    expect(read('scripts/claims/check-no-hardcoded.mjs')).toContain("name: 'eval-latency'");
  });
});
