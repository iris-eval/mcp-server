/*
 * Where the webhook is installed (arc 9, N-16): on the store, after an
 * evaluation row is durable — so every door that writes an evaluation
 * (`evaluate_output`, `log_trace` with `evaluate`, `POST /api/v1/traces`,
 * the OTLP door with `evaluateOnIngest`, a re-evaluation) reaches it
 * without each door knowing. The demo server never installs it: a week of
 * backdated seeds is not a week of alerts.
 */
import type { IrisConfig } from '../types/config.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalResult } from '../types/eval.js';
import type { TenantId } from '../types/tenant.js';
import { PKG_VERSION } from '../config/defaults.js';
import type { WebhookEventName } from './event-names.js';
import { resolveWebhookSecret, webhookSettings, type WebhookSettings } from './config.js';
import { momentsOf } from './events.js';
import { WebhookNotifier, type WebhookDeps, type WebhookLogger } from './webhook.js';

export { WEBHOOK_EVENTS, WEBHOOK_FORMATS, type WebhookEventName, type WebhookFormat } from './event-names.js';
export { assertWebhookConfig, resolveWebhookSecret, secretBytes, webhookSettings, type WebhookSettings } from './config.js';
export { WebhookNotifier, verifyDelivery, signBody, signStandard, renderPayload, type WebhookLogger } from './webhook.js';
export { momentsOf, type WebhookMoment } from './events.js';

export interface WebhookInstall {
  settings: WebhookSettings;
  notifier: WebhookNotifier;
  /** Unsubscribe, stop taking moments, and wait briefly for what is in flight. */
  dispose(): Promise<void>;
}

export interface InstallDeps extends Partial<Omit<WebhookDeps, 'logger'>> {
  readFile?: (path: string) => string;
}

/**
 * Subscribe a notifier to the store's evaluation writes. Returns null when
 * `notify.webhook` is null. Throws at startup — before any port is bound —
 * when the secret cannot be resolved.
 */
export function installWebhookNotifier(storage: IStorageAdapter, config: IrisConfig, logger: WebhookLogger, deps: InstallDeps = {}): WebhookInstall | null {
  const cfg = config.notify?.webhook;
  const settings = webhookSettings(cfg);
  if (!cfg || !settings) return null;
  const secret = resolveWebhookSecret(cfg, deps.readFile);
  const notifier = new WebhookNotifier(
    { url: cfg.url, events: settings.events, secret, cooldownMs: settings.cooldownMinutes * 60_000, format: settings.format, timeoutMs: settings.timeoutMs },
    { logger, fetch: deps.fetch, now: deps.now, sleep: deps.sleep, random: deps.random, version: deps.version ?? PKG_VERSION },
  );
  const wanted = new Set<WebhookEventName>(settings.events);
  const onInserted = (tenantId: TenantId, result: EvalResult): void => {
    // Detached on purpose: the write has returned to its caller already, and nothing here may reach back into it.
    void momentsOf(storage, tenantId, result, wanted)
      .then((moments) => {
        for (const moment of moments) notifier.notify(moment);
      })
      .catch((err: unknown) => {
        logger.warn(`Webhook skipped evaluation ${result.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
  };
  const unsubscribe = storage.onEvalResultInserted(onInserted);
  logger.info(`Webhook armed: ${settings.events.join(', ')} → ${settings.host} (${settings.format}, ${secret ? 'signed' : 'unsigned'}; cooldown ${settings.cooldownMinutes} min)`);
  return {
    settings,
    notifier,
    dispose: async () => {
      unsubscribe();
      notifier.close();
      await Promise.race([notifier.idle(), new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
    },
  };
}
