/**
 * The longest a Node timer waits, in ms. A timer set past it fires after
 * 1 ms (Node warns and sets it to 1), so a timeout set past it would end at
 * once.
 */
export const MAX_TIMER_MS = 2_147_483_647;
