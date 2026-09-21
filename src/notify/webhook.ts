/*
 * The webhook (arc 9, N-16): one signed POST per moment, retried, cooled
 * down, and never in the way of an evaluation.
 *
 * Every incumbent a buyer will compare Iris with delivers its alerts to a
 * webhook (LangSmith, Langfuse, Judgment, Helicone, Opik — the research
 * file), and Slack, Discord and PagerDuty are webhooks. This module owns
 * the wire: the body, the two signatures, the attempts, the backoff, the
 * cooldown and the queue. What counts as a moment is `events.ts`; where
 * the notifier is installed is `index.ts`.
 *
 * Signed two ways, so any receiver verifies with what it already has:
 *   - `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`
 *     — the Standard Webhooks convention (HMAC-SHA256 over
 *     `id.timestamp.body`; a `whsec_`-prefixed secret is base64), which a
 *     standard-webhooks library, Svix or Judgment's receiver verify as is;
 *   - `X-Iris-Signature: sha256=<hex>` — HMAC-SHA256 over the raw body,
 *     the GitHub convention, one line to verify by hand.
 * The timestamp is in the signed string, so a replay of an old delivery
 * fails a receiver that checks the tolerance (the docs recipe does).
 *
 * Delivery: one attempt and three retries (500 ms, 2 s, 8 s, ±25%
 * jitter) on a network error, a timeout, 408, 429 or 5xx; any other
 * non-2xx answer is final; then a logged drop. Deliveries run one at a
 * time from a queue capped at WEBHOOK_QUEUE_CAP so a dead receiver cannot
 * grow the process; an evaluation never waits for any of it.
 *
 * Cooldown per (event, agent, subject): the same moment inside the window
 * is not re-sent. A regression alarm is the exception by construction —
 * the watcher resets after one — but a failing verdict on every call of a
 * busy agent would otherwise be a storm.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WebhookEventName, WebhookFormat } from './event-names.js';
import type { WebhookMoment } from './events.js';

export interface ResolvedWebhookConfig {
  url: string;
  events: readonly WebhookEventName[];
  /** The signing key's bytes; null sends unsigned, which only the slack and discord formats allow. */
  secret: Buffer | null;
  cooldownMs: number;
  format: WebhookFormat;
  timeoutMs: number;
}

export interface WebhookLogger {
  info(message: string): void;
  warn(message: string): void;
  event?(name: string, fields: Record<string, unknown>): void;
}

export interface WebhookDeps {
  logger: WebhookLogger;
  /** Injected by tests; `globalThis.fetch` otherwise. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** For the User-Agent. */
  version?: string;
}

export type NotifyOutcome = 'queued' | 'unsubscribed' | 'cooldown' | 'queue_full' | 'closed';

/** One attempt, then three retries. */
export const WEBHOOK_MAX_ATTEMPTS = 4;
/** The wait before retry n (1-based), before jitter. */
export const WEBHOOK_BACKOFF_MS: readonly number[] = [500, 2_000, 8_000];
/** Deliveries waiting behind the one in flight; beyond it a moment is dropped with a log line. */
export const WEBHOOK_QUEUE_CAP = 100;
/** How far a receiver should let `webhook-timestamp` drift from its clock. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface DeliveryRecord {
  event: WebhookEventName;
  key: string;
  attempts: number;
  status: number | null;
  ok: boolean;
  error: string | null;
  latencyMs: number;
}

/** The bytes a secret string signs with: `whsec_` + base64 (Standard Webhooks), or the string itself. */
export function secretBytes(secret: string): Buffer {
  if (secret.startsWith('whsec_')) return Buffer.from(secret.slice('whsec_'.length), 'base64');
  return Buffer.from(secret, 'utf8');
}

/** `v1,<base64 HMAC-SHA256 of "id.timestamp.body">` — the Standard Webhooks signature. */
export function signStandard(secret: Buffer, id: string, timestampSeconds: number, body: string): string {
  return `v1,${createHmac('sha256', secret).update(`${id}.${timestampSeconds}.${body}`).digest('base64')}`;
}

/** `sha256=<hex HMAC-SHA256 of the body>` — the GitHub-style signature. */
export function signBody(secret: Buffer, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export interface VerifyOptions {
  /** Seconds a `webhook-timestamp` may drift from `now`; default WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS. */
  toleranceSeconds?: number;
  /** The receiver's clock, in seconds; default the wall clock. */
  nowSeconds?: number;
}

/**
 * What a receiver does with a delivery: either signature proves the body
 * came from the holder of the secret; the Standard Webhooks headers also
 * prove it is not a replay. Exported for tests and the docs recipe.
 */
export function verifyDelivery(secret: Buffer, headers: Record<string, string | undefined>, body: string, options: VerifyOptions = {}): { ok: boolean; reason: string | null } {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) lower[k.toLowerCase()] = v;
  const id = lower['webhook-id'];
  const ts = lower['webhook-timestamp'];
  const standard = lower['webhook-signature'];
  if (id && ts && standard) {
    const seconds = Number(ts);
    if (!Number.isInteger(seconds)) return { ok: false, reason: 'webhook-timestamp is not an integer' };
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance = options.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
    if (Math.abs(now - seconds) > tolerance) return { ok: false, reason: `webhook-timestamp is ${Math.abs(now - seconds)} s from now, beyond the ${tolerance} s tolerance` };
    const expected = signStandard(secret, id, seconds, body);
    const offered = standard.split(' ').filter((s) => s.startsWith('v1,'));
    if (offered.some((s) => safeEqual(s, expected))) return { ok: true, reason: null };
    return { ok: false, reason: 'no v1 signature matches' };
  }
  const github = lower['x-iris-signature'];
  if (github) {
    if (safeEqual(github, signBody(secret, body))) return { ok: true, reason: null };
    return { ok: false, reason: 'X-Iris-Signature does not match the body' };
  }
  return { ok: false, reason: 'no signature header' };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The body for one format. The `iris` body is the Standard Webhooks shape: type, timestamp, data. */
export function renderPayload(moment: WebhookMoment, format: WebhookFormat, meta: { id: string; timestamp: string }): string {
  if (format === 'slack') return JSON.stringify({ text: slackText(moment) });
  if (format === 'discord') return JSON.stringify({ content: slackText(moment).slice(0, 2000) });
  return JSON.stringify({ id: meta.id, type: `iris.${moment.event}`, timestamp: meta.timestamp, data: moment });
}

function slackText(moment: WebhookMoment): string {
  const who = moment.agent_name ?? 'an agent';
  const where = [moment.trace_id ? `trace ${moment.trace_id}` : null, moment.run_id ? `run ${moment.run_id}` : null, moment.case_key ? `case ${moment.case_key}` : null]
    .filter(Boolean)
    .join(' · ');
  return `*Iris — ${moment.event.replace(/_/g, ' ')}* (${who})\n${moment.summary}${where ? `\n${where}` : ''}`;
}

/** A network error, a timeout, 408, 429 and 5xx are retried; everything else is the receiver's final word. */
export function retryable(status: number | null): boolean {
  return status === null || status === 408 || status === 429 || status >= 500;
}

export class WebhookNotifier {
  private readonly lastSent = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly userAgent: string;
  private readonly subscribed: ReadonlySet<WebhookEventName>;

  constructor(
    private readonly config: ResolvedWebhookConfig,
    private readonly deps: WebhookDeps,
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.userAgent = `iris-eval/${deps.version ?? 'unknown'}`;
    this.subscribed = new Set(config.events);
  }

  /** The cooldown key: the same moment for the same agent and subject inside the window is one moment. */
  static cooldownKey(moment: Pick<WebhookMoment, 'event' | 'agent_name' | 'subject'>): string {
    return `${moment.event}|${moment.agent_name ?? '-'}|${moment.subject}`;
  }

  /** Decide now, deliver later. Synchronous, never throws. */
  notify(moment: WebhookMoment): NotifyOutcome {
    if (this.closed) return 'closed';
    if (!this.subscribed.has(moment.event)) return 'unsubscribed';
    const key = WebhookNotifier.cooldownKey(moment);
    const now = this.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.config.cooldownMs) return 'cooldown';
    if (this.pending >= WEBHOOK_QUEUE_CAP) {
      this.deps.logger.warn(`Webhook dropped ${moment.event} for ${moment.agent_name ?? 'an agent'}: ${WEBHOOK_QUEUE_CAP} deliveries are already waiting`);
      this.deps.logger.event?.('webhook_dropped', { event: moment.event, key, reason: 'queue_full' });
      return 'queue_full';
    }
    this.lastSent.set(key, now);
    this.pruneCooldowns(now);
    this.pending += 1;
    this.chain = this.chain
      .then(() => this.deliver(moment, key))
      .catch(() => undefined)
      .then(() => {
        this.pending -= 1;
      });
    return 'queued';
  }

  /** Resolves when every queued delivery has finished — for tests and for shutdown. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Stop taking moments; what is queued still runs. */
  close(): void {
    this.closed = true;
  }

  private pruneCooldowns(now: number): void {
    if (this.lastSent.size < 1_000) return;
    for (const [key, at] of this.lastSent) if (now - at >= this.config.cooldownMs) this.lastSent.delete(key);
  }

  private backoff(attempt: number): number {
    const base = WEBHOOK_BACKOFF_MS[Math.min(attempt - 1, WEBHOOK_BACKOFF_MS.length - 1)];
    return Math.round(base * (0.75 + 0.5 * this.random()));
  }

  private async deliver(moment: WebhookMoment, key: string): Promise<DeliveryRecord> {
    const id = `msg_${randomBytes(12).toString('hex')}`;
    const startedAt = this.now();
    const timestampSeconds = Math.floor(startedAt / 1000);
    const body = renderPayload(moment, this.config.format, { id, timestamp: new Date(startedAt).toISOString() });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': this.userAgent,
      'webhook-id': id,
      'webhook-timestamp': String(timestampSeconds),
      'x-iris-event': moment.event,
    };
    if (this.config.secret) {
      headers['webhook-signature'] = signStandard(this.config.secret, id, timestampSeconds, body);
      headers['x-iris-signature'] = signBody(this.config.secret, body);
    }
    let status: number | null = null;
    let error: string | null = null;
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      status = null;
      error = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await this.fetchImpl(this.config.url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
        status = res.status;
        if (res.ok) {
          const record: DeliveryRecord = { event: moment.event, key, attempts: attempt, status, ok: true, error: null, latencyMs: this.now() - startedAt };
          this.deps.logger.event?.('webhook_delivered', { event: moment.event, key, attempts: attempt, status, latency_ms: record.latencyMs });
          return record;
        }
        error = `HTTP ${status}`;
        if (!retryable(status)) break;
      } catch (err) {
        error = err instanceof Error && err.name === 'AbortError' ? `timeout after ${this.config.timeoutMs} ms` : err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < WEBHOOK_MAX_ATTEMPTS) await this.sleep(this.backoff(attempt));
    }
    const attempts = status !== null && !retryable(status) ? 1 : WEBHOOK_MAX_ATTEMPTS;
    const record: DeliveryRecord = { event: moment.event, key, attempts, status, ok: false, error, latencyMs: this.now() - startedAt };
    this.deps.logger.warn(`Webhook dropped ${moment.event} for ${moment.agent_name ?? 'an agent'} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${error ?? 'unknown error'}`);
    this.deps.logger.event?.('webhook_dropped', { event: moment.event, key, attempts, status, reason: error ?? 'unknown error' });
    return record;
  }
}
