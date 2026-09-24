/*
 * The webhook's configuration: the defaults, what the strict
 * file refuses by name, what startup refuses that the schema cannot see
 * (the environment's URL, an unsigned iris hook), the secret file, and the
 * capabilities object that names the events and the host and never the key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../src/config/index.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { buildCapabilities } from '../../../src/capabilities.js';
import { assertWebhookConfig, resolveWebhookSecret, webhookSettings } from '../../../src/notify/config.js';
import { WEBHOOK_EVENTS } from '../../../src/notify/event-names.js';

let scratch: string;
let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['IRIS_HOME', 'IRIS_DB_PATH', 'IRIS_WEBHOOK_URL', 'IRIS_WEBHOOK_SECRET'];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'iris-webhook-config-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.IRIS_HOME = home;
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(scratch, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify(value));
}

function refusal(): string {
  try {
    loadConfig();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('loadConfig accepted the file');
}

describe('the defaults', () => {
  it('ships with no webhook, and a bare url means every event, ten minutes, the iris format, ten seconds', () => {
    expect(defaultConfig.notify).toEqual({ webhook: null });
    expect(webhookSettings(null)).toBeNull();
    expect(webhookSettings({ url: 'https://hooks.example.test/a/b?token=t', secret: 's' })).toEqual({
      host: 'hooks.example.test',
      events: [...WEBHOOK_EVENTS],
      cooldownMinutes: 10,
      format: 'iris',
      timeoutMs: 10_000,
      signed: true,
    });
    expect(webhookSettings({ url: 'https://h.test', events: ['flaky_case'], cooldownMinutes: 0, format: 'slack', timeoutMs: 500 })).toMatchObject({ events: ['flaky_case'], cooldownMinutes: 0, format: 'slack', timeoutMs: 500, signed: false });
  });
});

describe('config.json', () => {
  it('a webhook with a url and a secret loads with the defaults filled in by the reader', () => {
    writeConfig({ notify: { webhook: { url: 'https://hooks.example.test/iris', secret: 'shh', events: ['regression_alarm', 'flaky_case'] } } });
    const config = loadConfig();
    expect(config.notify.webhook).toEqual({ url: 'https://hooks.example.test/iris', secret: 'shh', events: ['regression_alarm', 'flaky_case'] });
    expect(webhookSettings(config.notify.webhook)!.events).toEqual(['regression_alarm', 'flaky_case']);
  });

  it('a typo’d event refuses startup naming it and the events Iris sends', () => {
    writeConfig({ notify: { webhook: { url: 'https://hooks.example.test/iris', secret: 'shh', events: ['regression_alarm', 'regresion_alarm'] } } });
    const message = refusal();
    expect(message).toMatch(/Iris refuses to start on a key it does not read/);
    expect(message).toContain('"notify.webhook.events.1": "regresion_alarm" is not an event Iris sends — the events: verdict_fail, detector_veto, cost_anomaly, regression_alarm, flaky_case');
  });

  it('a misspelled key under the webhook names the key it meant; an empty events list, a bad url and a bad format are named', () => {
    writeConfig({ notify: { webhook: { url: 'https://hooks.example.test/iris', secrett: 'shh' } } });
    expect(refusal()).toContain('unknown key "notify.webhook.secrett" — did you mean "notify.webhook.secret"?');
    writeConfig({ notify: { webhook: { url: 'https://hooks.example.test/iris', secret: 's', events: [] } } });
    expect(refusal()).toContain('"notify.webhook.events": at least one event, or omit the key to send every event');
    writeConfig({ notify: { webhook: { url: 'ftp://hooks.example.test/iris', secret: 's' } } });
    expect(refusal()).toContain('"notify.webhook.url": an http(s) URL');
    writeConfig({ notify: { webhook: { url: 'https://hooks.example.test/iris', secret: 's', format: 'teams' } } });
    expect(refusal()).toMatch(/"notify\.webhook\.format": /);
    writeConfig({ notify: { webhook: null } });
    expect(loadConfig().notify.webhook).toBeNull();
  });

  it('the iris format without a secret refuses startup with the sentence; slack and discord may post unsigned', () => {
    writeConfig({ notify: { webhook: { url: 'https://hooks.example.test/iris' } } });
    expect(refusal()).toContain('the iris format signs every delivery, so it needs secret or secretFile');
    writeConfig({ notify: { webhook: { url: 'https://hooks.slack.com/services/T/B/x', format: 'slack' } } });
    expect(loadConfig().notify.webhook).toMatchObject({ format: 'slack' });
    writeConfig({ notify: { webhook: { url: 'https://discord.com/api/webhooks/1/x', format: 'discord' } } });
    expect(loadConfig().notify.webhook).toMatchObject({ format: 'discord' });
  });

  it('IRIS_WEBHOOK_URL and IRIS_WEBHOOK_SECRET merge over the file, and a url from the environment is still checked', () => {
    process.env.IRIS_WEBHOOK_URL = 'https://hooks.example.test/from-env';
    process.env.IRIS_WEBHOOK_SECRET = 'env-secret';
    expect(loadConfig().notify.webhook).toEqual({ url: 'https://hooks.example.test/from-env', secret: 'env-secret' });
    writeConfig({ notify: { webhook: { url: 'https://hooks.example.test/from-file', events: ['flaky_case'] } } });
    expect(loadConfig().notify.webhook).toEqual({ url: 'https://hooks.example.test/from-env', secret: 'env-secret', events: ['flaky_case'] });
    delete process.env.IRIS_WEBHOOK_URL;
    delete process.env.IRIS_WEBHOOK_SECRET;
    process.env.IRIS_WEBHOOK_SECRET = 'lonely';
    writeConfig({});
    expect(refusal()).toBe('notify.webhook.url is required — set it in config.json, or IRIS_WEBHOOK_URL');
    delete process.env.IRIS_WEBHOOK_SECRET;
    process.env.IRIS_WEBHOOK_URL = 'not a url';
    expect(refusal()).toBe('notify.webhook.url: "not a url" is not an http(s) URL');
    process.env.IRIS_WEBHOOK_URL = 'https://hooks.example.test/x';
    expect(refusal()).toContain('the iris format signs every delivery');
  });
});

describe('assertWebhookConfig and the secret', () => {
  it('names each refusal', () => {
    expect(() => assertWebhookConfig(null)).not.toThrow();
    expect(() => assertWebhookConfig({ url: 'https://h.test', secret: 'a', secretFile: '/b' })).toThrow('set secret or secretFile, not both');
    expect(() => assertWebhookConfig({ url: 'https://h.test', secret: 'a', events: ['nope' as never] })).toThrow('"nope" is not an event Iris sends');
    expect(() => assertWebhookConfig({ url: 'https://h.test', secret: 'a', format: 'teams' as never })).toThrow('"teams" is not a format — the formats: iris, slack, discord');
  });

  it('reads the secret from the file, trimmed; an empty or unreadable file refuses startup by path', () => {
    const path = join(scratch, 'secret.txt');
    writeFileSync(path, 'file-secret\n');
    expect(resolveWebhookSecret({ url: 'https://h.test', secretFile: path })!.toString('utf8')).toBe('file-secret');
    writeFileSync(path, '   \n');
    expect(() => resolveWebhookSecret({ url: 'https://h.test', secretFile: path })).toThrow(`notify.webhook.secretFile: ${path} is empty`);
    expect(() => resolveWebhookSecret({ url: 'https://h.test', secretFile: join(scratch, 'missing') })).toThrow(/cannot read .*missing/);
    expect(resolveWebhookSecret({ url: 'https://h.test', secret: 'whsec_' + Buffer.from('abc').toString('base64') })!.toString('utf8')).toBe('abc');
    expect(resolveWebhookSecret({ url: 'https://h.test', format: 'slack' })).toBeNull();
  });
});

describe('the capabilities object', () => {
  it('names the events, the host and the format; never the URL’s path or the secret', () => {
    const none = buildCapabilities({ config: defaultConfig });
    expect(none.notify).toEqual({ webhook: null });
    const config = structuredClone(defaultConfig);
    config.notify.webhook = { url: 'https://hooks.slack.com/services/T000/B000/SECRETTOKEN', secret: 'the-signing-key', events: ['regression_alarm'], format: 'slack' };
    const caps = buildCapabilities({ config });
    expect(caps.notify.webhook).toEqual({ host: 'hooks.slack.com', events: ['regression_alarm'], cooldownMinutes: 10, format: 'slack', timeoutMs: 10_000, signed: true });
    const printed = JSON.stringify(caps);
    expect(printed).not.toContain('SECRETTOKEN');
    expect(printed).not.toContain('the-signing-key');
  });
});
