/*
 * A wait set from outside is held at the longest a timer waits.
 *
 * Node fires a timer set past 2,147,483,647 ms after 1 ms, so a timeout a
 * caller or a configuration sets past it would end at once, and an interval
 * would repeat on every tick. vitest's fake timers do as Node does with such
 * a delay, so the tests of the first block move a fake clock: what is held
 * waits, and what was not ended after a millisecond. Those of the second,
 * where a thread or SQLite itself does the waiting, run on real timers.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDriver } from '../../src/storage/driver.js';
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
import { callLLMJudge } from '../../src/eval/llm-judge/client.js';
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
    // Read once, as a timer reads a length: an object with valueOf is asked once, and the number it names is handed on.
    let reads = 0;
    const counted = { valueOf: () => (reads += 1, 5_000) } as unknown as number;
    expect(heldTimerMs(counted)).toBe(5_000);
    expect(reads).toBe(1);
    // The longest a timer waits, in hours: past it a sweep ran on every tick.
    expect(MAX_TIMER_MS / 3_600_000).toBeCloseTo(596.52, 2);
    expect(readFileSync(resolve(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8')).toContain(
      "- **A wait set from outside past what a timer can wait is held at it.** Node fires a timer set past 2,147,483,647 ms (about 24.8 days) after 1 ms. Every wait in the server that takes its length from outside is now held at that maximum: `IRIS_OTEL_TIMEOUT_MS`, `retention.sweepIntervalHours` in `config.json`, and those an embedder sets in code (the `timeoutMs` of `createRelevanceJudge`, of a citation's fetch and of a webhook, `storage.searchBudgetMs`, the store gate's wait, and SQLite's busy timeout as a driver, a checkpointer or a search thread is given it), with a provider's `Retry-After` inside such a deadline. Past it, an export, a judge call, a fetch or a webhook's delivery ended at once, every search answered nothing, a store waited for no lock (or, under better-sqlite3, did not open), and a sweep set past about 596.5 hours ran on every tick of the clock; such a sweep now runs every 596.5 hours. The reasons these waits give name the length they waited, and a judge's `timeoutMs` given as text is read as the number it names, where the call ended at once.",
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

  it('a retention sweep set past 596.52 hours runs every 596.52 hours, where it ran on every tick', async () => {
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

  it('each wait set from outside is handed to its timer held at the maximum itself; NaN and a fraction as Node reads them', async () => {
    const set = vi.spyOn(globalThis, 'setTimeout');
    const every = vi.spyOn(globalThis, 'setInterval');
    const handed = (): unknown[] => set.mock.calls.map((call) => call[1]);
    try {
      // Nothing answers, and the stand-in sets no timer of its own: each wait is set, and read off the timer the code sets.
      global.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
      const trace: Trace = { trace_id: '00000000000000000000000000000002', agent_name: 'test', timestamp: '2026-11-19T00:00:00Z' };
      void new OtelExporter({ endpoint: 'https://collector.example:4318', serviceName: 'iris', timeoutMs: PAST }).exportTraces([trace]);
      await vi.advanceTimersByTimeAsync(1);
      expect(handed()).toContain(MAX_TIMER_MS);
      set.mockClear();
      void createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: PAST }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' });
      await vi.advanceTimersByTimeAsync(1);
      expect(handed()).toContain(MAX_TIMER_MS);
      set.mockClear();
      __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
      try {
        void resolveSource('https://example.com/held', { allowFetch: true, timeoutMs: PAST }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(1);
        expect(handed()).toContain(MAX_TIMER_MS);
      } finally {
        __setDnsLookupForTests(null);
        __clearCitationCacheForTests();
      }
      set.mockClear();
      void storeGate({ whenReady: () => new Promise<void>(() => undefined) } as unknown as IStorageAdapter, { waitMs: PAST }).wait().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1);
      expect(handed()).toContain(MAX_TIMER_MS);
      set.mockClear();
      const hookConfig: ResolvedWebhookConfig = { url: 'https://hooks.example.test/iris', events: ['verdict_fail'], secret: null, cooldownMs: 0, format: 'slack', timeoutMs: PAST };
      const notifier = new WebhookNotifier(hookConfig, { logger: { info: () => undefined, warn: () => undefined }, fetch: global.fetch, sleep: async () => undefined, random: () => 0.5 });
      notifier.notify({ event: 'verdict_fail', subject: 'no_pii', summary: 'support-bot: the verdict failed.', evaluation_id: 'e-3', trace_id: 't-3', agent_name: 'support-bot' } as WebhookMoment);
      await vi.advanceTimersByTimeAsync(1);
      expect(handed()).toContain(MAX_TIMER_MS);
      set.mockClear();
      // A length that is not a number reaches the timer as Node reads it: NaN waits a millisecond, as it did.
      void new OtelExporter({ endpoint: 'https://collector.example:4318', serviceName: 'iris', timeoutMs: Number.NaN }).exportTraces([trace]).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1);
      expect(handed().some((ms) => Number.isNaN(ms))).toBe(true);
      // A sweep every half hour is a sweep every 1,800,000 ms.
      const config = structuredClone(defaultConfig);
      config.retention.sweepIntervalHours = 0.5;
      const storage = { deleteTracesOlderThan: vi.fn(async () => 0), deleteEvalResultsOlderThan: vi.fn(async () => 0), keptPastRetention: vi.fn(async () => null), checkpoint: vi.fn(async () => undefined) };
      const timer = scheduleRetentionSweep(storage as unknown as IStorageAdapter, config, { info: vi.fn(), warn: vi.fn() });
      expect(every.mock.calls.map((call) => call[1])).toContain(1_800_000);
      clearInterval(timer!);
    } finally {
      set.mockRestore();
      every.mockRestore();
    }
  });

  it("a rate limit's wait past it, inside the deadline, is waited out and asked again; one past the deadline is answered at once", async () => {
    const asked = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2500000' } }));
    global.fetch = asked as unknown as typeof fetch;
    void createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: PAST }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' });
    await vi.advanceTimersByTimeAsync(10);
    expect(asked).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
    expect(asked).toHaveBeenCalledTimes(2);
    // A wait of 4,000,000 s does not fit before a deadline of 3,000,000,000 ms: the rate limit is the answer, at once.
    global.fetch = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '4000000' } })) as unknown as typeof fetch;
    let record: unknown;
    void createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: PAST }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' }).then((r) => (record = r));
    await vi.advanceTimersByTimeAsync(10);
    expect(record).toMatchObject({ error: expect.stringMatching(/rate/i) });
  });

  it('a judge given its timeoutMs as text waits that many ms, and a held wait says the length it waited', async () => {
    // A provider that never answers: only the abort ends its request.
    global.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
        }),
    ) as unknown as typeof fetch;
    let text: { error?: string } | undefined;
    void createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: '5000' as unknown as number }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' }).then((r) => (text = r as { error?: string }));
    await vi.advanceTimersByTimeAsync(4_990);
    expect(text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(text?.error).toContain('did not answer within 5000 ms');
    let held: { error?: string } | undefined;
    void createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: PAST }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' }).then((r) => (held = r as { error?: string }));
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 10);
    expect(held?.error).toContain(`did not answer within ${MAX_TIMER_MS} ms`);
    let refused: unknown;
    void storeGate({ whenReady: () => new Promise<void>(() => undefined) } as unknown as IStorageAdapter, { waitMs: PAST }).wait().catch((err: unknown) => (refused = err));
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 10);
    expect(String((refused as Error)?.message)).toContain(`this request waited ${Math.round(MAX_TIMER_MS / 1000)} s`);
    // A citation's fetch and a webhook's delivery say the same length.
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    try {
      let fetchError: unknown;
      void resolveSource('https://example.com/never', { allowFetch: true, timeoutMs: PAST }).catch((err: unknown) => (fetchError = err));
      await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 10);
      expect(String((fetchError as Error)?.message ?? JSON.stringify(fetchError))).toContain(`Fetch timed out after ${MAX_TIMER_MS}ms`);
    } finally {
      __setDnsLookupForTests(null);
      __clearCitationCacheForTests();
    }
    const lines: string[] = [];
    const config: ResolvedWebhookConfig = { url: 'https://hooks.example.test/iris', events: ['verdict_fail'], secret: null, cooldownMs: 0, format: 'slack', timeoutMs: PAST };
    const notifier = new WebhookNotifier(config, { logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) }, fetch: global.fetch, sleep: async () => undefined, random: () => 0.5 });
    notifier.notify({ event: 'verdict_fail', subject: 'no_pii', summary: 'support-bot: the verdict failed.', evaluation_id: 'e-4', trace_id: 't-4', agent_name: 'support-bot' } as WebhookMoment);
    for (let attempt = 0; attempt < 4; attempt += 1) await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 10);
    await notifier.idle();
    expect(lines.join('\n')).toContain(`timeout after ${MAX_TIMER_MS} ms`);
  });

  it('the judge client called alone reads a timeoutMs given as text as the number it names', async () => {
    global.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
        }),
    ) as unknown as typeof fetch;
    let error: unknown;
    void callLLMJudge({ provider: 'anthropic', model: 'claude-haiku-4-5', systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 10, temperature: 0, apiKey: 'k', timeoutMs: '5000' as unknown as number }).catch((err: unknown) => (error = err));
    await vi.advanceTimersByTimeAsync(4_990);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(String((error as Error)?.message)).toContain('did not answer within 5000 ms');
  });

  it("a webhook's backoff is held too, whatever its random answers", async () => {
    const slept: number[] = [];
    const receiver = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const config: ResolvedWebhookConfig = { url: 'https://hooks.example.test/iris', events: ['verdict_fail'], secret: null, cooldownMs: 0, format: 'slack', timeoutMs: 1_000 };
    const notifier = new WebhookNotifier(config, { logger: { info: () => undefined, warn: () => undefined }, fetch: receiver, sleep: async (ms) => void slept.push(ms), random: () => 1e9 });
    notifier.notify({ event: 'verdict_fail', subject: 'no_pii', summary: 'support-bot: the verdict failed.', evaluation_id: 'e-2', trace_id: 't-2', agent_name: 'support-bot' } as WebhookMoment);
    await vi.advanceTimersByTimeAsync(10);
    await notifier.idle();
    expect(slept.length).toBeGreaterThan(0);
    expect(Math.max(...slept)).toBe(MAX_TIMER_MS);
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

  it("SQLite's busy timeout given past it in code is held, by either driver: the file opens, and its connection waits for a lock", () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-held-busy-'));
    dirs.push(dir);
    for (const driver of ['node', 'native'] as const) {
      const db = openDriver(join(dir, `${driver}.db`), { driver, timeout: PAST, allowFallback: false });
      try {
        expect(JSON.stringify(db.pragma('busy_timeout')), driver).toContain(String(MAX_TIMER_MS));
      } finally {
        db.close();
      }
    }
  });

  it("a checkpointer given a busy timeout past it waits for another connection's lock, where it waited for none", async () => {
    const path = await storeWithATrace();
    const checkpointer = new Checkpointer({ path, driver: SEARCH_DRIVER === 'node' ? 'node' : 'better-sqlite3', busyMs: PAST, onReady: () => undefined, onFailed: () => undefined, warn: () => undefined });
    expect(await checkpointer.started).toBe(true);
    // A TRUNCATE waits for no reader, and the busy timeout is set back after it: held, as the driver set it.
    await checkpointer.truncate();
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      holder.exec('COMMIT');
      holder.close();
    };
    setTimeout(release, 300);
    try {
      // A write needs the lock the other connection holds for 300 ms: it waits, where it was refused at once.
      await checkpointer.exec('CREATE TABLE held_probe (x INTEGER)');
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    } finally {
      release();
      await checkpointer.close();
    }
  });

  it("a search's stuck timer, its budget a little under the maximum and the grace after it, is held at the maximum", async () => {
    const path = await storeWithATrace();
    const set = vi.spyOn(globalThis, 'setTimeout');
    const searcher = new SearchWorkerClient({ path, driver: SEARCH_DRIVER, busyTimeoutMs: 5000 }, 10_000, undefined, 10_000, () => undefined);
    try {
      const plan = { whereClause: 'WHERE tenant_id = ?', params: ['local'], filtered: false, sortBy: 'relevance', sortOrder: 'desc', limit: 50, offset: 0 };
      const found = await searcher.search({ tenantId: LOCAL_TENANT, parsed: parseSearch('fox'), plan, index: 'scan', budgetMs: MAX_TIMER_MS - 5_000 });
      expect(found.complete).toBe(true);
      expect(set.mock.calls.map((call) => call[1])).toContain(MAX_TIMER_MS);
    } finally {
      set.mockRestore();
      await searcher.close();
    }
  });

  it("the search thread's and the checkpoint thread's close waits past it wait for the thread, where each was stopped after a millisecond", async () => {
    const path = await storeWithATrace();
    const warned: string[] = [];
    const searcher = new SearchWorkerClient({ path, driver: SEARCH_DRIVER, busyTimeoutMs: 5000 }, 10_000, undefined, PAST, (line) => warned.push(line));
    const plan = { whereClause: 'WHERE tenant_id = ?', params: ['local'], filtered: false, sortBy: 'relevance', sortOrder: 'desc', limit: 50, offset: 0 };
    const found = await searcher.search({ tenantId: LOCAL_TENANT, parsed: parseSearch('fox'), plan, index: 'scan', budgetMs: 10_000 });
    expect(found.complete).toBe(true);
    const set = vi.spyOn(globalThis, 'setTimeout');
    try {
      await searcher.close();
      // Each close wait is handed to its timer at the maximum itself.
      expect(set.mock.calls.map((call) => call[1])).toContain(MAX_TIMER_MS);
      set.mockClear();
      const checkpointer = new Checkpointer({ path, driver: SEARCH_DRIVER === 'node' ? 'node' : 'better-sqlite3', busyMs: 5000, onReady: () => undefined, onFailed: () => undefined, closeTimeoutMs: PAST, warn: (line) => warned.push(line) });
      expect(await checkpointer.started).toBe(true);
      set.mockClear();
      await checkpointer.close();
      expect(set.mock.calls.map((call) => call[1])).toContain(MAX_TIMER_MS);
    } finally {
      set.mockRestore();
    }
    expect(warned).toEqual([]);
  });
});
