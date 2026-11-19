/**
 * The time a judge call has, every request, its reply and the wait after a
 * rate limit together, where the caller names none (timeout_ms). An MCP
 * client built on the TypeScript SDK gives up on a request after 60 seconds
 * by default, so a call that answers inside this answers that client.
 */
export const DEFAULT_JUDGE_DEADLINE_MS = 50_000;

/**
 * The longest time a caller may give a timeout, in ms: the longest a Node
 * timer waits (src/utils/timer.ts). A timer set past it fires after 1 ms, so
 * a deadline set past it would end at once.
 */
export { MAX_TIMER_MS } from '../../utils/timer.js';
