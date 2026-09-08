/*
 * Where a rule's threshold came from.
 *
 * compose.decides() reads `thresholdSource` on a policy's count evidence
 * to tell a deployment's policy from our guess. Three rules used to derive
 * it by comparing the effective value to the shipped number
 * (`threshold === 0.10 ? 'default' : 'config'`) — so a deployment that
 * deliberately set the shipped number was stamped "default" and demoted to
 * advisory — and one rule read presence in customConfig, which the engine
 * defeats by merging the shipped thresholds into customConfig on every
 * call, so that rule gated at the shipped default while every surface said
 * it advised.
 *
 * The engine now installs thresholdSourceOf on the context from what it
 * alone knows: which keys the deployment's config file supplied, and which
 * keys a caller put on the context itself. Outside the engine (the proof
 * runner and the unit tests call rule.evaluate directly), presence in
 * customConfig is the caller having configured it. Never value equality.
 * Two values only: a threshold is the deployment's or it is ours.
 */
import type { EvalContext } from '../types/eval.js';

export type ThresholdSource = 'default' | 'config';

export function thresholdSourceOf(context: EvalContext, key: string): ThresholdSource {
  if (context.thresholdSourceOf) return context.thresholdSourceOf(key);
  return context.customConfig !== undefined && key in context.customConfig ? 'config' : 'default';
}
