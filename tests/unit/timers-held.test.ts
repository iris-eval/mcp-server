/*
 * A wait set from outside is held at the longest a timer waits.
 *
 * Node fires a timer set past 2,147,483,647 ms after 1 ms, so a timeout a
 * caller or a configuration sets past it would end at once, and an interval
 * would repeat on every tick. vitest's fake timers do as Node does with such
 * a delay, so each test here moves a fake clock: what is held waits, and
 * what was not ended after a millisecond.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIMER_MS, heldTimerMs } from '../../src/utils/timer.js';
import { WebhookNotifier, type ResolvedWebhookConfig } from '../../src/notify/webhook.js';
import type { WebhookMoment } from '../../src/notify/events.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createStorage } from '../../src/storage/index.js';
import { SearchWorkerClient } from '../../src/storage/search-worker-client.js';
import { Checkpointer } from '../../src/storage/checkpointer.js';
import { parseSearch } from '../../src/storage/search.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { SEARCH_DRIVER } from './storage/fts5-here.js';
import { OtelExporter, exporterFromEnv } from '../../src/otel/exporter.js';
import { createRelevanceJudge } from '../../src/eval/llm-judge/relevance-judge.js';
import { resolveSource, __clearCitationCacheForTests, __setDnsLookupForTests } from '../../src/eval/citation-verify/resolve.js';
import { scheduleRetentionSweep } from '../../src/retention.js';
import { storeGate } from '../../src/storage/ready.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { IStorageAdapter } from '../../src/types/query.js';
import type { Trace } from '../../src/types/trace.js';

/** A wait past the longest a timer keeps: about 34.7 days. */
const PAST = 3_000_000_000;
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

/** A reply that comes after `ms`, unless the request is aborted first. */
const answeredAfter = (ms: number, reply: () => Response): typeof fetch =>
  vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(reply()), ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        });
      }),
  ) as unknown as typeof fetch;

const JUDGMENT = (): Response =>
  new Response(
    JSON.stringify({
      id: 'm',
      content: [{ type: 'text', text: JSON.stringify({ score: 0.9, passed: true, rationale: 'on the subject', dimensions: { addresses_request: 0.9, on_subject: 0.9, specific_to_request: 0.9 } }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200 },
  );

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('a wait set from outside is held at the longest a timer waits', () => {
  it('at 2,147,483,647 ms, and a shorter wait as it is; the changelog says which waits', () => {
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
    expect(heldTimerMs(1_000)).toBe(1_000);
    expect(heldTimerMs(MAX_TIMER_MS)).toBe(MAX_TIMER_MS);
    expect(heldTimerMs(MAX_TIMER_MS + 1)).toBe(MAX_TIMER_MS);
    expect(heldTimerMs(1e10)).toBe(MAX_TIMER_MS);
    // The longest a timer waits, in hours: past it a sweep ran on every tick.
    expect(MAX_TIMER_MS / 3_600_000).toBeCloseTo(596.52, 2);
    expect(readFileSync(resolve(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8')).toContain(
      "- **A wait set from outside past what a timer can wait is held at it.** Node fires a timer set past 2,147,483,647 ms (about 24.8 days) after 1 ms. Every wait in the server that takes its length from outside is now held at that maximum: `IRIS_OTEL_TIMEOUT_MS`, `retention.sweepIntervalHours` in `config.json`, and those an embedder sets in code (the `timeoutMs` of `createRelevanceJudge`, of a citation's fetch and of a webhook, `storage.searchBudgetMs`, and the store gate's wait), with a provider's `Retry-After` inside such a deadline. Past it, an export, a judge call, a fetch or a webhook's delivery ended at once, every search answered nothing, and a sweep set past about 596.5 hours ran on every tick of the clock; such a sweep now runs every 596.5 hours.",
    );
  });

  it('an OTel export whose timeout is past it waits for its reply, set in code or by IRIS_OTEL_TIMEOUT_MS', async () => {
    global.fetch = answeredAfter(50, () => new Response('{}', { status: 200 }));
    process.env.IRIS_OTEL_ENDPOINT = 'https://collector.example:4318';
    process.env.IRIS_OTEL_TIMEOUT_MS = String(PAST);
    const trace: Trace = { trace_id: '00000000000000000000000000000001', agent_name: 'test', timestamp: '2026-11-19T00:00:00Z' };
    const fromEnv = exporterFromEnv();
    expect(fromEnv).not.toBeNull();
    for (const exporter of [new OtelExporter({ endpoint: 'https://collector.example:4318', serviceName: 'iris', timeoutMs: PAST }), fromEnv!]) {
      const result = exporter.exportTraces([trace]);
      await vi.advanceTimersByTimeAsync(60);
      expect(await result).toMatchObject({ ok: true, status: 200 });
    }
  });

  it('a judge an embedder makes with a timeoutMs past it waits for its reply', async () => {
    global.fetch = answeredAfter(50, JUDGMENT);
    const judged = createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: PAST }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' });
    await vi.advanceTimersByTimeAsync(60);
    const record = await judged;
    expect(record).toMatchObject({ score: 0.9 });
    expect((record as { error?: string }).error).toBeUndefined();
  });

  it("a rate limit's wait past it is not asked again after a millisecond", async () => {
    // The provider asks for a wait of 2,500,000 s, inside a deadline of 3,000,000,000 ms: the wait is held, so no second request comes soon.
    const asked = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2500000' } }));
    global.fetch = asked as unknown as typeof fetch;
    void createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: PAST }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' });
    await vi.advanceTimersByTimeAsync(10);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("a citation fetch whose timeout is past it waits for the page", async () => {
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    try {
      global.fetch = answeredAfter(50, () => new Response('The source says so.', { status: 200, headers: { 'content-type': 'text/plain' } }));
      const fetched = resolveSource('https://example.com/page', { allowFetch: true, timeoutMs: PAST });
      await vi.advanceTimersByTimeAsync(60);
      expect(await fetched).toMatchObject({ status: 200 });
    } finally {
      __setDnsLookupForTests(null);
      __clearCitationCacheForTests();
    }
  });

  it("the store gate's wait past it waits for the store", async () => {
    let open!: () => void;
    const raw = { whenReady: () => new Promise<void>((resolve) => (open = resolve)) } as unknown as IStorageAdapter;
    const gate = storeGate(raw, { waitMs: PAST });
    let settled = 'waiting';
    gate.wait().then(
      () => (settled = 'ready'),
      () => (settled = 'refused'),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe('waiting');
    open();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('ready');
  });

  it('a retention sweep set past 596 hours runs at that interval, where it ran on every tick', async () => {
    const storage = {
      deleteTracesOlderThan: vi.fn(async () => 0),
      deleteEvalResultsOlderThan: vi.fn(async () => 0),
      keptPastRetention: vi.fn(async () => null),
      checkpoint: vi.fn(async () => undefined),
    };
    const config = structuredClone(defaultConfig);
    config.retention.sweepIntervalHours = 720;
    const timer = scheduleRetentionSweep(storage as unknown as IStorageAdapter, config, { info: vi.fn(), warn: vi.fn() });
    expect(timer).not.toBeNull();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(storage.deleteTracesOlderThan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
      expect(storage.deleteTracesOlderThan).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(timer!);
    }
  });

  it('a webhook whose timeout is past it waits for the receiver, where every attempt ended after a millisecond and the moment was dropped', async () => {
    const lines: string[] = [];
    const receiver = answeredAfter(50, () => new Response(null, { status: 200 }));
    const config: ResolvedWebhookConfig = { url: 'https://hooks.example.test/iris', events: ['verdict_fail'], secret: null, cooldownMs: 0, format: 'slack', timeoutMs: PAST };
    const notifier = new WebhookNotifier(config, { logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) }, fetch: receiver, sleep: async () => undefined, random: () => 0.5 });
    expect(notifier.notify({ event: 'verdict_fail', subject: 'no_pii', summary: 'support-bot: the verdict failed.', evaluation_id: 'e-1', trace_id: 't-1', agent_name: 'support-bot' } as WebhookMoment)).toBe('queued');
    await vi.advanceTimersByTimeAsync(60);
    await notifier.idle();
    expect(receiver).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.includes('dropped'))).toEqual([]);
  });
});

describe('waits a store sets in code, held, where a thread of its own answers (real timers)', () => {
  const dirs: string[] = [];
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A store on disk with one trace in it, closed. */
  const storeWithATrace = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-held-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const seed = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await seed.initialize();
    await seed.insertTrace(LOCAL_TENANT, { trace_id: 't-1', agent_name: 'probe', timestamp: new Date().toISOString(), input: 'where is the quick brown fox', output: 'the quick brown fox is in the garden' } as Trace);
    await seed.close();
    return path;
  };

  it("a search whose budget is past it reads to its end, where every search was called stuck after a millisecond and answered nothing", async () => {
    const config = structuredClone(defaultConfig);
    config.storage.path = await storeWithATrace();
    config.storage.searchBudgetMs = PAST;
    const storage = createStorage(config);
    await storage.initialize();
    try {
      for (let i = 0; i < 2; i += 1) {
        const found = await storage.queryTraces(LOCAL_TENANT, { search: 'fox', limit: 10 });
        expect(found.total, `search ${i + 1}`).toBe(1);
        expect(found.search?.complete, `search ${i + 1}`).toBe(true);
      }
    } finally {
      await storage.close();
    }
  });

  it("the search thread's and the checkpoint thread's close waits past it wait for the thread, where each was stopped after a millisecond", async () => {
    const path = await storeWithATrace();
    const warned: string[] = [];
    const searcher = new SearchWorkerClient({ path, driver: SEARCH_DRIVER, busyTimeoutMs: 5000 }, 10_000, undefined, PAST, (line) => warned.push(line));
    const plan = { whereClause: 'WHERE tenant_id = ?', params: ['local'], filtered: false, sortBy: 'relevance', sortOrder: 'desc', limit: 50, offset: 0 };
    const found = await searcher.search({ tenantId: LOCAL_TENANT, parsed: parseSearch('fox'), plan, index: 'scan', budgetMs: 10_000 });
    expect(found.complete).toBe(true);
    await searcher.close();
    const checkpointer = new Checkpointer({ path, driver: SEARCH_DRIVER === 'node' ? 'node' : 'better-sqlite3', busyMs: 5000, onReady: () => undefined, onFailed: () => undefined, closeTimeoutMs: PAST, warn: (line) => warned.push(line) });
    expect(await checkpointer.started).toBe(true);
    await checkpointer.close();
    expect(warned).toEqual([]);
  });
});
