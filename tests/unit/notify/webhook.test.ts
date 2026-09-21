/*
 * The webhook's wire (arc 9, N-16): two signatures a receiver can verify,
 * the Standard Webhooks body, the retries and their backoff, the final
 * answers that are not retried, the cooldown per (event, agent, subject),
 * the queue cap, the formats, and a real receiver on a socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { WebhookNotifier, WEBHOOK_BACKOFF_MS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_QUEUE_CAP, renderPayload, retryable, signBody, signStandard, verifyDelivery, type ResolvedWebhookConfig } from '../../../src/notify/webhook.js';
import { secretBytes } from '../../../src/notify/config.js';
import type { WebhookMoment } from '../../../src/notify/events.js';

const SECRET = secretBytes('shh-not-for-the-wire');

const moment = (over: Partial<WebhookMoment> = {}): WebhookMoment => ({
  event: 'verdict_fail',
  subject: 'no_pii',
  summary: 'support-bot: the verdict failed on detector veto — no_pii.',
  evaluation_id: 'e-1',
  trace_id: 't-1',
  agent_name: 'support-bot',
  run_id: 'nightly-1',
  case_key: 'refund-policy',
  evaluated_at: '2026-09-21T12:00:00.000Z',
  verdict: { state: 'fail', basis: 'detector_veto', by: ['no_pii'] },
  score: 0.4,
  failed_rules: ['no_pii'],
  critical_failures: ['no_pii'],
  detail: { by: ['no_pii'] },
  ...over,
});

const config = (over: Partial<ResolvedWebhookConfig> = {}): ResolvedWebhookConfig => ({
  url: 'https://hooks.example.test/iris',
  events: ['verdict_fail', 'detector_veto', 'cost_anomaly', 'regression_alarm', 'flaky_case'],
  secret: SECRET,
  cooldownMs: 10 * 60_000,
  format: 'iris',
  timeoutMs: 10_000,
  ...over,
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that answers from a script of statuses (the last repeats) and records every call. */
function scriptedFetch(statuses: number[]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), event: vi.fn() };
}

describe('the signatures', () => {
  it('a receiver verifies the Standard Webhooks headers, and separately the GitHub-style one, against the raw body', () => {
    const body = '{"type":"iris.verdict_fail"}';
    const id = 'msg_abc';
    const ts = 1_790_000_000;
    const standard = signStandard(SECRET, id, ts, body);
    expect(standard).toBe(`v1,${createHmac('sha256', SECRET).update(`${id}.${ts}.${body}`).digest('base64')}`);
    expect(verifyDelivery(SECRET, { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': standard }, body, { nowSeconds: ts + 30 })).toEqual({ ok: true, reason: null });
    // Header names are matched case-insensitively, and a space-separated list is searched.
    expect(verifyDelivery(SECRET, { 'Webhook-Id': id, 'Webhook-Timestamp': String(ts), 'Webhook-Signature': `v1,nope ${standard}` }, body, { nowSeconds: ts }).ok).toBe(true);
    const github = signBody(SECRET, body);
    expect(github).toBe(`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`);
    expect(verifyDelivery(SECRET, { 'X-Iris-Signature': github }, body).ok).toBe(true);
  });

  it('a tampered body, a wrong secret, a replay outside the tolerance and a missing header all fail with a reason', () => {
    const body = '{"a":1}';
    const id = 'msg_1';
    const ts = 1_790_000_000;
    const headers = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': signStandard(SECRET, id, ts, body) };
    expect(verifyDelivery(SECRET, headers, '{"a":2}', { nowSeconds: ts }).reason).toBe('no v1 signature matches');
    expect(verifyDelivery(secretBytes('other'), headers, body, { nowSeconds: ts }).ok).toBe(false);
    expect(verifyDelivery(SECRET, headers, body, { nowSeconds: ts + 301 }).reason).toMatch(/beyond the 300 s tolerance/);
    expect(verifyDelivery(SECRET, headers, body, { nowSeconds: ts + 299 }).ok).toBe(true);
    expect(verifyDelivery(SECRET, { 'webhook-id': id, 'webhook-timestamp': 'now', 'webhook-signature': 'v1,x' }, body).reason).toMatch(/not an integer/);
    expect(verifyDelivery(SECRET, { 'x-iris-signature': 'sha256=00' }, body).reason).toMatch(/does not match/);
    expect(verifyDelivery(SECRET, {}, body).reason).toBe('no signature header');
  });

  it('a whsec_ secret signs with its base64 bytes, the way a Standard Webhooks library expects', () => {
    const raw = Buffer.from('twenty-four-byte-secret!');
    const whsec = `whsec_${raw.toString('base64')}`;
    expect(secretBytes(whsec).equals(raw)).toBe(true);
    expect(signStandard(secretBytes(whsec), 'id', 1, 'b')).toBe(signStandard(raw, 'id', 1, 'b'));
    expect(secretBytes('plain').equals(Buffer.from('plain', 'utf8'))).toBe(true);
  });
});

describe('the body', () => {
  it('the iris format is the Standard Webhooks shape — id, a dotted type, a timestamp, the moment as data — and carries no text', () => {
    const body = JSON.parse(renderPayload(moment(), 'iris', { id: 'msg_1', timestamp: '2026-09-21T12:00:01.000Z' })) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['id', 'type', 'timestamp', 'data']);
    expect(body.type).toBe('iris.verdict_fail');
    const data = body.data as Record<string, unknown>;
    expect(data).toMatchObject({ event: 'verdict_fail', trace_id: 't-1', evaluation_id: 'e-1', agent_name: 'support-bot', verdict: { basis: 'detector_veto' } });
    expect(data).not.toHaveProperty('input');
    expect(data).not.toHaveProperty('output');
  });

  it('the slack format is { text } and the discord format is { content }, each naming the event, the agent and the summary', () => {
    const slack = JSON.parse(renderPayload(moment(), 'slack', { id: 'x', timestamp: 'y' })) as { text: string };
    expect(Object.keys(slack)).toEqual(['text']);
    expect(slack.text).toContain('verdict fail');
    expect(slack.text).toContain('support-bot');
    expect(slack.text).toContain('the verdict failed on detector veto');
    expect(slack.text).toContain('trace t-1');
    const discord = JSON.parse(renderPayload(moment(), 'discord', { id: 'x', timestamp: 'y' })) as { content: string };
    expect(Object.keys(discord)).toEqual(['content']);
    expect(discord.content.length).toBeLessThanOrEqual(2000);
  });
});

describe('delivery', () => {
  it('one POST with both signatures, the id and timestamp headers, the event header and a user agent; the receiver verifies the raw body', async () => {
    const { fetchImpl, calls } = scriptedFetch([200]);
    const log = logger();
    const n = new WebhookNotifier(config(), { logger: log, fetch: fetchImpl, now: () => 1_790_000_000_000, version: '9.9.9' });
    expect(n.notify(moment())).toBe('queued');
    await n.idle();
    expect(calls).toHaveLength(1);
    const { headers, body, url } = calls[0];
    expect(url).toBe('https://hooks.example.test/iris');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('iris-eval/9.9.9');
    expect(headers['x-iris-event']).toBe('verdict_fail');
    expect(headers['webhook-id']).toMatch(/^msg_[0-9a-f]{24}$/);
    expect(headers['webhook-timestamp']).toBe('1790000000');
    expect(verifyDelivery(SECRET, headers, body, { nowSeconds: 1_790_000_000 })).toEqual({ ok: true, reason: null });
    expect(verifyDelivery(SECRET, { 'x-iris-signature': headers['x-iris-signature'] }, body).ok).toBe(true);
    expect((JSON.parse(body) as { id: string }).id).toBe(headers['webhook-id']);
    expect(log.event).toHaveBeenCalledWith('webhook_delivered', expect.objectContaining({ event: 'verdict_fail', attempts: 1, status: 200 }));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a 5xx, a 429 and a network error are retried with the backoff 500 ms, 2 s, 8 s; the fourth failure is a logged drop', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const log = logger();
    const { fetchImpl, calls } = scriptedFetch([503, 429, 200]);
    const n = new WebhookNotifier(config(), { logger: log, fetch: fetchImpl, sleep, random: () => 0.5 });
    n.notify(moment());
    await n.idle();
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([WEBHOOK_BACKOFF_MS[0], WEBHOOK_BACKOFF_MS[1]]);
    expect(log.event).toHaveBeenCalledWith('webhook_delivered', expect.objectContaining({ attempts: 3 }));

    sleeps.length = 0;
    const dead = scriptedFetch([500]);
    const n2 = new WebhookNotifier(config(), { logger: log, fetch: dead.fetchImpl, sleep, random: () => 0.5 });
    n2.notify(moment({ agent_name: 'other-bot' }));
    await n2.idle();
    expect(dead.calls).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(sleeps).toEqual([...WEBHOOK_BACKOFF_MS]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Webhook dropped verdict_fail for other-bot after 4 attempts: HTTP 500/));
    expect(log.event).toHaveBeenCalledWith('webhook_dropped', expect.objectContaining({ attempts: 4, status: 500 }));

    const flaky = vi.fn(async () => {
      if (flaky.mock.calls.length === 1) throw new TypeError('fetch failed');
      return new Response(null, { status: 204 });
    });
    const n3 = new WebhookNotifier(config(), { logger: log, fetch: flaky as unknown as typeof fetch, sleep, random: () => 0.5 });
    n3.notify(moment({ agent_name: 'third-bot' }));
    await n3.idle();
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('the jitter keeps each wait within ±25% of its base', async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = scriptedFetch([500]);
    const n = new WebhookNotifier(config(), { logger: logger(), fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    n.notify(moment());
    await n.idle();
    expect(sleeps).toEqual(WEBHOOK_BACKOFF_MS.map((b) => b * 0.75));
    const high = new WebhookNotifier(config(), { logger: logger(), fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms), random: () => 1 });
    sleeps.length = 0;
    high.notify(moment());
    await high.idle();
    expect(sleeps).toEqual(WEBHOOK_BACKOFF_MS.map((b) => b * 1.25));
  });

  it('a 4xx other than 408 and 429 is the receiver’s final word: one attempt, dropped with the status', async () => {
    const log = logger();
    const { fetchImpl, calls } = scriptedFetch([400]);
    const n = new WebhookNotifier(config(), { logger: log, fetch: fetchImpl, sleep: async () => undefined });
    n.notify(moment());
    await n.idle();
    expect(calls).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/after 1 attempt: HTTP 400/));
    expect(retryable(400)).toBe(false);
    expect(retryable(404)).toBe(false);
    expect(retryable(408)).toBe(true);
    expect(retryable(429)).toBe(true);
    expect(retryable(500)).toBe(true);
    expect(retryable(null)).toBe(true);
  });

  it('a receiver that never answers is a timeout, retried like a network error', async () => {
    const log = logger();
    const hanging = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    const n = new WebhookNotifier(config({ timeoutMs: 20 }), { logger: log, fetch: hanging, sleep: async () => undefined });
    n.notify(moment());
    await n.idle();
    expect(hanging).toHaveBeenCalledTimes(WEBHOOK_MAX_ATTEMPTS);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('timeout after 20 ms'));
  });
});

describe('the decisions before delivery', () => {
  it('an event the file did not name is not sent', () => {
    const { fetchImpl } = scriptedFetch([200]);
    const n = new WebhookNotifier(config({ events: ['regression_alarm'] }), { logger: logger(), fetch: fetchImpl });
    expect(n.notify(moment())).toBe('unsubscribed');
    expect(n.notify(moment({ event: 'regression_alarm', subject: 'no_pii' }))).toBe('queued');
  });

  it('the cooldown holds the same (event, agent, subject) for the window, and nothing else', async () => {
    let clock = 1_000_000;
    const { fetchImpl, calls } = scriptedFetch([200]);
    const n = new WebhookNotifier(config({ cooldownMs: 10 * 60_000 }), { logger: logger(), fetch: fetchImpl, now: () => clock });
    expect(n.notify(moment())).toBe('queued');
    expect(n.notify(moment({ evaluation_id: 'e-2', trace_id: 't-2' }))).toBe('cooldown');
    expect(n.notify(moment({ subject: 'no_injection' }))).toBe('queued');
    expect(n.notify(moment({ agent_name: 'other-bot' }))).toBe('queued');
    expect(n.notify(moment({ event: 'detector_veto' }))).toBe('queued');
    clock += 10 * 60_000 - 1;
    expect(n.notify(moment())).toBe('cooldown');
    clock += 1;
    expect(n.notify(moment())).toBe('queued');
    await n.idle();
    expect(calls).toHaveLength(5);
    expect(WebhookNotifier.cooldownKey(moment({ agent_name: null }))).toBe('verdict_fail|-|no_pii');
  });

  it('the cooldown is set when the moment is queued, so a delivery that is still retrying does not let a twin through', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = vi.fn(async () => {
      await gate;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const n = new WebhookNotifier(config(), { logger: logger(), fetch: blocking });
    expect(n.notify(moment())).toBe('queued');
    expect(n.notify(moment())).toBe('cooldown');
    release();
    await n.idle();
  });

  it(`the queue holds ${WEBHOOK_QUEUE_CAP} deliveries; beyond that a moment is dropped with a log line`, async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = vi.fn(async () => {
      await gate;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const log = logger();
    const n = new WebhookNotifier(config(), { logger: log, fetch: blocking });
    for (let i = 0; i < WEBHOOK_QUEUE_CAP; i += 1) expect(n.notify(moment({ subject: `rule-${i}` }))).toBe('queued');
    expect(n.notify(moment({ subject: 'one-too-many' }))).toBe('queue_full');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('deliveries are already waiting'));
    expect(log.event).toHaveBeenCalledWith('webhook_dropped', expect.objectContaining({ reason: 'queue_full' }));
    release();
    await n.idle();
    expect(blocking).toHaveBeenCalledTimes(WEBHOOK_QUEUE_CAP);
  });

  it('after close() nothing more is taken; what was queued still runs', async () => {
    const { fetchImpl, calls } = scriptedFetch([200]);
    const n = new WebhookNotifier(config(), { logger: logger(), fetch: fetchImpl });
    n.notify(moment());
    n.close();
    expect(n.notify(moment({ subject: 'x' }))).toBe('closed');
    await n.idle();
    expect(calls).toHaveLength(1);
  });
});

describe('a receiver on a socket', () => {
  let server: Server | null = null;
  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('the real fetch delivers to a local receiver, which verifies the signature over the bytes it read', async () => {
    const received: Array<{ headers: Record<string, string | undefined>; body: string }> = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        received.push({ headers: req.headers as Record<string, string | undefined>, body });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    const n = new WebhookNotifier(config({ url }), { logger: logger() });
    n.notify(moment({ event: 'cost_anomaly', subject: 'cost_anomaly' }));
    await n.idle();
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers['x-iris-event']).toBe('cost_anomaly');
    expect(verifyDelivery(SECRET, headers, body).ok).toBe(true);
    expect((JSON.parse(body) as { type: string }).type).toBe('iris.cost_anomaly');
  });
});
