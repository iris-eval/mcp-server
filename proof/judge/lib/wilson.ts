/*
 * Wilson moved to src/eval/stats.ts in arc 5, and this file re-exports it.
 *
 * The direction is what matters. `compare_runs` returns an interval to a
 * user now, so the SHIPPED server needs Wilson — and `src/` cannot import
 * `proof/`, because proof/ is not in the published package. Rather than
 * keep a second copy here for the harness, the harness borrows the shipped
 * one: one implementation, one place to fix, and the published proof
 * numbers are computed by the very code the product runs.
 *
 * Every existing importer under proof/ keeps its import path.
 */
export { wilson, Z_95, type WilsonInterval } from '../../../src/eval/stats.js';
