/**
 * The longest a Node timer waits, in ms. A timer set past it fires after
 * 1 ms (Node warns and sets it to 1), so a timeout set past it would end at
 * once.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * A wait that comes from a caller or a configuration, held at the longest a
 * timer waits: a value past it waits that long (about 24.8 days), never 1 ms.
 */
export function heldTimerMs(ms: number): number {
  return ms > MAX_TIMER_MS ? MAX_TIMER_MS : ms;
}
