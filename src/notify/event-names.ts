/*
 * The events a webhook can subscribe to — one closed list,
 * imported by the config schema (what a file may name), the detector (what
 * an evaluation yields), the capabilities object (what this server sends)
 * and the docs test. Snake_case like `Verdict.basis`, whose value
 * `detector_veto` is one of them; the moment kinds the dashboard classifies
 * (`regression-alarm`, `cost-spike`) are a different vocabulary with a
 * different job — one kind per trace, for a list — and are not copied here.
 */
export const WEBHOOK_EVENTS = [
  /** The composed verdict failed, on any basis. Issue #5's ask. */
  'verdict_fail',
  /** A critical detection vetoed the verdict (`verdict.basis === 'detector_veto'`). */
  'detector_veto',
  /** The `cost_anomaly` rule fired: this trace's cost is an outlier against the agent's own recent costs. */
  'cost_anomaly',
  /** The CUSUM watcher crossed its line at this evaluation for one rule (the stream resets and re-baselines). */
  'regression_alarm',
  /** A case answered both ways for the first time: every earlier attempt agreed, this one differs. */
  'flaky_case',
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_FORMATS = ['iris', 'slack', 'discord'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Cooldown per (event, agent, subject), in minutes, when the file names none. */
export const WEBHOOK_DEFAULT_COOLDOWN_MINUTES = 10;
/** One attempt's limit, in milliseconds, when the file names none. */
export const WEBHOOK_DEFAULT_TIMEOUT_MS = 10_000;
