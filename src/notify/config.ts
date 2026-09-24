/*
 * The webhook's configuration, read three ways: what the
 * capabilities object prints, what startup refuses, and the signing key.
 * Pure — no delivery code — so the config loader and the capabilities
 * builder can import it without pulling the sender in.
 */
import { readFileSync } from 'node:fs';
import type { WebhookConfig } from '../types/config.js';
import { WEBHOOK_DEFAULT_COOLDOWN_MINUTES, WEBHOOK_DEFAULT_TIMEOUT_MS, WEBHOOK_EVENTS, WEBHOOK_FORMATS, type WebhookEventName, type WebhookFormat } from './event-names.js';

/** The settings as the capabilities object prints them: never the URL's secret parts, never the key. */
export interface WebhookSettings {
  /** The receiver's host, for a log line and the capabilities object; the full URL may carry a token. */
  host: string;
  events: readonly WebhookEventName[];
  cooldownMinutes: number;
  format: WebhookFormat;
  timeoutMs: number;
  /** Whether deliveries carry signatures. */
  signed: boolean;
}

/** `notify.webhook` with the defaults filled in, or null when nothing is configured. */
export function webhookSettings(cfg: WebhookConfig | null | undefined): WebhookSettings | null {
  if (!cfg) return null;
  let host = cfg.url ?? '';
  try {
    host = new URL(cfg.url).host;
  } catch {
    /* refused at startup by assertWebhookConfig; keep the string for a message */
  }
  return {
    host,
    events: cfg.events && cfg.events.length > 0 ? [...cfg.events] : [...WEBHOOK_EVENTS],
    cooldownMinutes: cfg.cooldownMinutes ?? WEBHOOK_DEFAULT_COOLDOWN_MINUTES,
    format: cfg.format ?? 'iris',
    timeoutMs: cfg.timeoutMs ?? WEBHOOK_DEFAULT_TIMEOUT_MS,
    signed: Boolean(cfg.secret || cfg.secretFile),
  };
}

export const UNSIGNED_IRIS_WEBHOOK =
  'notify.webhook: the iris format signs every delivery, so it needs secret or secretFile (any string; a whsec_-prefixed base64 secret is read the Standard Webhooks way). Set format to slack or discord to post unsigned to a URL that is itself the credential.';

/**
 * What the strict schema cannot see: a webhook assembled from the
 * environment (IRIS_WEBHOOK_URL, IRIS_WEBHOOK_SECRET) never passed it, and
 * the secret requirement depends on the format. Throws one sentence naming
 * the key; called by loadConfig before any port is bound.
 */
export function assertWebhookConfig(cfg: WebhookConfig | null | undefined): void {
  if (!cfg) return;
  if (typeof cfg.url !== 'string' || cfg.url.length === 0) {
    throw new Error('notify.webhook.url is required — set it in config.json, or IRIS_WEBHOOK_URL');
  }
  if (!/^https?:\/\//i.test(cfg.url) || !URL.canParse(cfg.url)) {
    throw new Error(`notify.webhook.url: "${cfg.url}" is not an http(s) URL`);
  }
  if (cfg.events !== undefined) {
    if (!Array.isArray(cfg.events) || cfg.events.length === 0) throw new Error('notify.webhook.events: at least one event, or omit the key to send every event');
    for (const event of cfg.events) {
      if (!(WEBHOOK_EVENTS as readonly string[]).includes(event)) {
        throw new Error(`notify.webhook.events: "${String(event)}" is not an event Iris sends — the events: ${WEBHOOK_EVENTS.join(', ')}`);
      }
    }
  }
  if (cfg.format !== undefined && !(WEBHOOK_FORMATS as readonly string[]).includes(cfg.format)) {
    throw new Error(`notify.webhook.format: "${String(cfg.format)}" is not a format — the formats: ${WEBHOOK_FORMATS.join(', ')}`);
  }
  if (cfg.secret && cfg.secretFile) throw new Error('notify.webhook: set secret or secretFile, not both');
  if ((cfg.format ?? 'iris') === 'iris' && !cfg.secret && !cfg.secretFile) throw new Error(UNSIGNED_IRIS_WEBHOOK);
}

/** The bytes a secret string signs with: `whsec_` + base64 (Standard Webhooks), or the string itself. */
export function secretBytes(secret: string): Buffer {
  if (secret.startsWith('whsec_')) return Buffer.from(secret.slice('whsec_'.length), 'base64');
  return Buffer.from(secret, 'utf8');
}

/**
 * The signing key, from `secret` or the trimmed contents of `secretFile`;
 * null for an unsigned slack or discord hook. Throws when the file cannot
 * be read or is empty — at startup, named.
 */
export function resolveWebhookSecret(cfg: WebhookConfig, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): Buffer | null {
  assertWebhookConfig(cfg);
  let raw = cfg.secret ?? null;
  if (cfg.secretFile) {
    try {
      raw = readFile(cfg.secretFile).trim();
    } catch (err) {
      throw new Error(`notify.webhook.secretFile: cannot read ${cfg.secretFile} — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (raw.length === 0) throw new Error(`notify.webhook.secretFile: ${cfg.secretFile} is empty`);
  }
  return raw === null ? null : secretBytes(raw);
}
