/**
 * The time a judge call has, every request, its reply and the wait after a
 * rate limit together, where the caller names none (timeout_ms). An MCP
 * client built on the TypeScript SDK gives up on a request after 60 seconds
 * by default, so a call that answers inside this answers that client.
 */
export const DEFAULT_JUDGE_DEADLINE_MS = 50_000;
