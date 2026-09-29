/*
 * Deleting a trace erases the text of every evaluation linked to it.
 *
 * eval_results.trace_id is ON DELETE SET NULL, so a deleted trace used to
 * leave its evaluations behind with output_text verbatim — including the
 * SSN no_pii had flagged — orphaned and readable by every query (found in
 * the 2026-09-05 audit). Now delete_trace and the retention sweep blank the text, the
 * expected text and the rule messages, stamp erased_at,
 * and keep the scores and the evidence offsets.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { Checkpointer } from '../../../src/storage/checkpointer.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { generateTraceId } from '../../../src/utils/ids.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { SEARCH_DRIVER } from './fts5-here.js';

const SSN_OUTPUT = 'Done. For the record, the customer SSN is 536-22-8145 and the invoice is settled.';

async function storeLinked(storage: SqliteAdapter, timestamp = new Date().toISOString()) {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds);
  const traceId = generateTraceId();
  await storage.insertTrace(LOCAL_TENANT, { trace_id: traceId, agent_name: 'erasure', input: 'q', output: SSN_OUTPUT, timestamp });
  const result = await engine.evaluate('safety', { output: SSN_OUTPUT, expected: 'the invoice is settled' });
  result.trace_id = traceId;
  result.expected_text = 'the invoice is settled';
  await storage.insertEvalResult(LOCAL_TENANT, result);
  return { traceId, evalId: result.id, before: result };
}

describe('erasure', () => {
  it('delete_trace leaves no text from the trace in its evaluations, and keeps the verdict and the evidence offsets', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { traceId, evalId, before } = await storeLinked(storage);
    const pii = before.rule_results.find((r) => r.ruleName === 'no_pii')!;
    expect(pii.passed).toBe(false);
    expect(pii.evidence?.some((e) => e.type === 'span')).toBe(true);

    expect(await storage.deleteTrace(LOCAL_TENANT, traceId)).toBe(true);

    const after = (await storage.getEvalById(LOCAL_TENANT, evalId))!;
    expect(after.output_text).toBe('');
    expect(after.expected_text).toBeUndefined();
    expect(after.erased_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.trace_id ?? undefined).toBeUndefined();
    expect(after.score).toBe(before.score);
    expect(after.passed).toBe(before.passed);
    expect(after.critical_failures).toEqual(before.critical_failures);
    const piiAfter = after.rule_results.find((r) => r.ruleName === 'no_pii')!;
    expect(piiAfter.passed).toBe(false);
    expect(piiAfter.message).toBe('erased with the trace');
    expect(piiAfter.evidence).toEqual(pii.evidence);
    expect(JSON.stringify(after)).not.toContain('536-22-8145');
    expect(JSON.stringify(after)).not.toContain('invoice');
    await storage.close();
  });

  it('the retention sweep erases the evaluations of the traces it deletes, even when the evaluation itself is young', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const { evalId } = await storeLinked(storage, old);
    const { evalId: youngEval, traceId: youngTrace } = await storeLinked(storage);

    expect(await storage.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(1);

    const swept = (await storage.getEvalById(LOCAL_TENANT, evalId))!;
    expect(swept.output_text).toBe('');
    expect(swept.erased_at).toBeDefined();
    const kept = (await storage.getEvalById(LOCAL_TENANT, youngEval))!;
    expect(kept.output_text).toBe(SSN_OUTPUT);
    expect(kept.erased_at).toBeUndefined();
    expect(kept.trace_id).toBe(youngTrace);
    await storage.close();
  });

  it('deleting an unknown trace erases nothing and reports false', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { evalId } = await storeLinked(storage);
    expect(await storage.deleteTrace(LOCAL_TENANT, 'f'.repeat(32))).toBe(false);
    expect((await storage.getEvalById(LOCAL_TENANT, evalId))!.output_text).toBe(SSN_OUTPUT);
    await storage.close();
  });
});

/*
 * delete_trace leaves no readable copy of the trace on disk once it returns
 * (#703). secure_delete zeroes the pages the delete frees, but in WAL mode
 * the zeroed pages go to iris.db-wal and iris.db keeps the old ones until a
 * checkpoint copies the new ones over: the text stayed readable in iris.db
 * for as long as the process ran. The retention sweep and --purge already
 * checkpointed; delete_trace now does too. Each case below reads the file's
 * bytes straight after the delete, with no checkpoint of its own, for Latin
 * text and for CJK text, whose two-character pieces are stored beside the
 * index (search-index.ts) and must go as well.
 */
describe('delete_trace leaves no text on disk', () => {
  const dirs: string[] = [];
  const open: SqliteAdapter[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const holds = (file: string, needle: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(needle, 'utf8'));

  async function stored(output: string, needles: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'iris-delete-residue-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await s.initialize();
    open.push(s);
    await s.whenSearchIndexReady();
    await s.insertTraces(LOCAL_TENANT, [
      { trace_id: 'secret', agent_name: 'erasure', input: 'q', output, timestamp: '2026-09-28T00:00:00.000Z' },
      { trace_id: 'kept', agent_name: 'erasure', input: 'q', output: 'an ordinary answer 普通的回答', timestamp: '2026-09-28T00:01:00.000Z' },
    ]);
    // In iris.db itself before the delete, as a trace is once any checkpoint has run since it was written.
    await s.checkpoint();
    for (const n of needles) expect(holds(path, n), n).toBe(true);
    return { s, path };
  }

  /** The checkpoint worker's state, and whether an erasure is being retried: the message when an assertion fails. */
  const state = (s: SqliteAdapter, path: string) => {
    const w = (s as unknown as { checkpointer?: { active: boolean; stopped: string; truncateInProgress: boolean } }).checkpointer;
    return JSON.stringify({ walBytes: existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`).length : -1, worker: w ? { active: w.active, stopped: w.stopped, truncating: w.truncateInProgress } : null, retrying: (s as unknown as { eraseRetry?: unknown }).eraseRetry !== undefined });
  };

  function assertGone(path: string, needles: string[], s?: SqliteAdapter) {
    const why = s ? ` ${state(s, path)}` : '';
    for (const n of needles) {
      expect(holds(path, n), `${n} in iris.db${why}`).toBe(false);
      expect(holds(`${path}-wal`, n), `${n} in iris.db-wal${why}`).toBe(false);
    }
  }

  it('Latin text: gone from iris.db and its WAL when delete_trace returns', async () => {
    const secret = 'ZEBRAQUOKKASECRETTOKEN42';
    const { s, path } = await stored(`my secret is ${secret}`, [secret]);
    expect(await s.deleteTrace(LOCAL_TENANT, 'secret')).toBe(true);
    assertGone(path, [secret], s);
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'ordinary' })).total).toBe(1);
  });

  it('CJK text: the text and every piece of it the index kept are gone when delete_trace returns', async () => {
    const secret = '鼗鼙鼛鼜';
    const needles = [secret, '鼗鼙', '鼙鼛', '鼛鼜'];
    const { s, path } = await stored(`密码是${secret}不要外传`, needles);
    expect(await s.deleteTrace(LOCAL_TENANT, 'secret')).toBe(true);
    assertGone(path, needles, s);
    expect((await s.queryTraces(LOCAL_TENANT, { search: '普通' })).total).toBe(1);
  });

  it('a trace written since the last checkpoint: gone from the WAL too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-delete-residue-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await s.initialize();
    open.push(s);
    const secret = 'WALONLYSECRET77';
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 'secret', agent_name: 'erasure', input: 'q', output: `wal ${secret}`, timestamp: '2026-09-28T00:00:00.000Z' }]);
    expect(holds(`${path}-wal`, secret) || holds(path, secret)).toBe(true);
    expect(await s.deleteTrace(LOCAL_TENANT, 'secret')).toBe(true);
    assertGone(path, [secret], s);
  });
});

/*
 * The same guarantee while everything that can hold the file is busy: the
 * checkpoint worker starting (it starts at the store's first write, and a
 * delete straight after that write met it still opening its connection on
 * a Windows runner, so the text was still on disk when delete_trace
 * returned), the worker copying the log, and the search index being built
 * and merged in steps behind the start. Each store is a copy of one whose
 * traces have no index yet, so its build runs throughout.
 */
describe('delete_trace leaves no text on disk while the store works in the background', () => {
  const STORES = 12;
  const DELETES_PER_STORE = 8;
  let base: string;
  const dirs: string[] = [];
  const open: SqliteAdapter[] = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-erasure-stress-'));
    dirs.push(dir);
    base = join(dir, 'base.db');
    const s = new SqliteAdapter(base, { driver: SEARCH_DRIVER, fts5: false });
    await s.initialize();
    const at = Date.now();
    await s.insertTraces(
      LOCAL_TENANT,
      Array.from({ length: 3000 }, (_, i) => ({ trace_id: `bg-${i}`, agent_name: 'erasure', input: `question ${i}`, output: `an ordinary answer ${i} ${'with some words '.repeat(20)}`, timestamp: new Date(at - i * 1000).toISOString() })),
    );
    await s.checkpoint();
    await s.close();
  }, 60_000);

  afterAll(async () => {
    for (const st of open.splice(0)) await st.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const holds = (file: string, needle: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(needle, 'utf8'));

  it(`${STORES} stores, ${DELETES_PER_STORE} deletes each, the first straight after the store's first write: every secret is gone from iris.db and its WAL when the call returns`, async () => {
    const left: string[] = [];
    // What each erasure tried, for the message when one leaves text behind.
    let trail: string[] = [];
    const t0 = Date.now();
    const record = (what: string, run: () => unknown) => {
      const r = run();
      if (r instanceof Promise) return r.then((v) => (trail.push(`${Date.now() - t0}ms ${what} -> ${String(v)}`), v));
      trail.push(`${Date.now() - t0}ms ${what} -> ${String(r)}`);
      return r;
    };
    const proto = SqliteAdapter.prototype as unknown as { truncateCheckpointHere: () => boolean };
    const here = proto.truncateCheckpointHere;
    vi.spyOn(proto, 'truncateCheckpointHere').mockImplementation(function (this: unknown) {
      return record('TRUNCATE on the adapter', () => here.call(this)) as boolean;
    });
    const onWorker = Checkpointer.prototype.truncate;
    vi.spyOn(Checkpointer.prototype, 'truncate').mockImplementation(function (this: Checkpointer) {
      return record('TRUNCATE on the worker', () => onWorker.call(this)) as Promise<boolean>;
    });
    for (let k = 0; k < STORES; k += 1) {
      const dir = mkdtempSync(join(tmpdir(), 'iris-erasure-stress-'));
      dirs.push(dir);
      const path = join(dir, 'iris.db');
      copyFileSync(base, path);
      const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
      open.push(s);
      await s.initialize();
      for (let d = 0; d < DELETES_PER_STORE; d += 1) {
        const secret = `STRESSSECRET${k}X${d}Q${'Z'.repeat(8)}`;
        await s.insertTraces(LOCAL_TENANT, [{ trace_id: `secret-${d}`, agent_name: 'erasure', input: 'q', output: `the code is ${secret}`, timestamp: new Date().toISOString() }]);
        trail = [];
        expect(await s.deleteTrace(LOCAL_TENANT, `secret-${d}`)).toBe(true);
        const w = (s as unknown as { checkpointer?: { active: boolean; stopped: string } }).checkpointer;
        if (holds(path, secret) || holds(`${path}-wal`, secret)) left.push(`${secret} (store ${k}, delete ${d}; iris.db ${holds(path, secret)}, WAL ${holds(`${path}-wal`, secret)}; worker ${w ? `active ${w.active}, stopped ${w.stopped}` : 'none'}; retry pending ${(s as unknown as { eraseRetry?: unknown }).eraseRetry !== undefined}; tried: ${trail.join('; ')})`);
        // Let the build, the merges and the worker's copies run between deletes.
        await new Promise((r) => setTimeout(r, d % 2 === 0 ? 0 : 30));
      }
      await s.close();
      open.splice(open.indexOf(s), 1);
    }
    vi.restoreAllMocks();
    expect(left).toEqual([]);
  }, 180_000);
});

/*
 * The same guarantee while another client keeps writing. The worker's
 * TRUNCATE takes the write lock without waiting, so a write of the server's
 * connection that lands in that instant turns it away; every write now waits
 * for a TRUNCATE in flight first (sqlite-adapter.ts, insertTraces). The
 * adapter's own attempt is made to find the file held, as it does while the
 * worker copies, so each erasure goes to the worker, with writes arriving on
 * every turn of the event loop. Without the writes waiting, 8 to 11 of 20
 * deletes left the text on disk on both drivers, and with nothing forced 2
 * runs in 3 left one on Node's built-in SQLite.
 */
describe('delete_trace leaves no text on disk while another client writes', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const holds = (file: string, needle: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(needle, 'utf8'));

  it('20 deletes under steady writes, each erased on the worker: every secret is gone from iris.db and its WAL when the call returns', async () => {
    const proto = SqliteAdapter.prototype as unknown as { truncateCheckpointHere: () => boolean };
    const here = proto.truncateCheckpointHere;
    let heldHere = false;
    vi.spyOn(proto, 'truncateCheckpointHere').mockImplementation(function (this: unknown) {
      return heldHere ? false : (here.call(this) as boolean);
    });
    let turnedAway = 0;
    const onWorker = Checkpointer.prototype.truncate;
    vi.spyOn(Checkpointer.prototype, 'truncate').mockImplementation(async function (this: Checkpointer) {
      const done = await onWorker.call(this);
      if (!done) turnedAway += 1;
      return done;
    });
    const dir = mkdtempSync(join(tmpdir(), 'iris-erasure-writes-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await s.initialize();
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 'first', agent_name: 'writer', input: 'q', output: 'first', timestamp: new Date().toISOString() }]);
    let stop = false;
    let written = 0;
    const writer = (async () => {
      while (!stop) {
        await s.insertTraces(LOCAL_TENANT, [{ trace_id: `w-${written}`, agent_name: 'writer', input: 'q', output: `an ordinary answer ${written} ${'with some words '.repeat(10)}`, timestamp: new Date().toISOString() }]);
        written += 1;
        await new Promise((r) => setImmediate(r));
      }
    })();
    const left: string[] = [];
    try {
      for (let d = 0; d < 20; d += 1) {
        const secret = `WRITESSECRET${d}Q${'Z'.repeat(8)}`;
        heldHere = false;
        await s.insertTraces(LOCAL_TENANT, [{ trace_id: `secret-${d}`, agent_name: 'erasure', input: 'q', output: `the code is ${secret}`, timestamp: new Date().toISOString() }]);
        heldHere = true;
        expect(await s.deleteTrace(LOCAL_TENANT, `secret-${d}`)).toBe(true);
        if (holds(path, secret) || holds(`${path}-wal`, secret)) left.push(`${secret} (iris.db ${holds(path, secret)}, WAL ${holds(`${path}-wal`, secret)})`);
        await new Promise((r) => setTimeout(r, 15));
      }
    } finally {
      stop = true;
      await writer;
      heldHere = false;
      vi.restoreAllMocks();
      await s.close();
    }
    // The writes ran throughout, and no erasure on the worker was turned away by them.
    expect(written).toBeGreaterThan(20);
    expect(turnedAway).toBe(0);
    expect(left).toEqual([]);
  }, 60_000);
});
