/*
 * The SQLite driver seam.
 *
 * Iris stores everything in one SQLite file, and until 0.15.0 the only way
 * to open it was `better-sqlite3` — a native addon that must be compiled
 * or downloaded for the exact Node ABI and platform. When that download
 * misses (an unusual platform, a corporate proxy, a Node upgrade before the
 * prebuild exists) the module fails to load and Iris could not start at
 * all: every migration, the adapter and the self-test were typed on the
 * addon's own classes.
 *
 * This file is the seam. Everything above it — the adapter, the twelve
 * migrations, the self-test — talks to a `Driver` with six verbs:
 * prepare, exec, pragma, transaction, fn, close. Two drivers implement it:
 *
 *   native   better-sqlite3, the default — fastest, and what every number
 *            in the proof was measured on.
 *   node     `node:sqlite`, Node's built-in (Node 22.13+; 24 unflagged) —
 *            no addon, no download, no compiler. Opened with extension
 *            loading off and `trusted_schema` off (the two hardening
 *            switches the built-in exposes; SQLite's DEFENSIVE flag is
 *            not reachable from it and the docs say so).
 *
 * Selection: `IRIS_SQLITE_DRIVER=native|node` decides; unset means native
 * with a fallback — when the native module cannot load and the built-in
 * is available, Iris warns once and uses the built-in, so a bad prebuild
 * is a slower start, not a dead one. The same holds for a binary that
 * would load and then abort the process on this Node (nativeAbortsOnCollect,
 * below). A name that is neither is refused.
 *
 * better-sqlite3 is an OPTIONAL dependency (0.20.0, #661): when npm cannot
 * install it — a release with no prebuilt binary for the platform, and no
 * compiler to build one — the install still succeeds without it, and this
 * seam finds it absent and uses the built-in. Every driver says why it was
 * chosen (`reason`), and the self-test and the startup log print it.
 *
 * Both drivers return the same shapes the adapter reads: `run()` gives
 * `{ changes }`, `get()` one row or undefined, `all()` rows; positional `?`
 * parameters; `transaction(fn)` returns a callable with `.immediate()`
 * (nested calls become savepoints, as the native driver does).
 *
 * Both keep the statements they prepare (statementCache, below): SQLite
 * compiles a statement once and runs it many times, and until 0.20.0 every
 * call here compiled it again. That was most of the cost of a write once
 * the search index existed — the insert into spans compiles the six span
 * triggers, and the index statement is 2 KB of SQL — 1.8 of 3.2 ms per
 * stored trace, before any row was written.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export type DriverName = 'better-sqlite3' | 'node';

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export type Transaction<A extends unknown[], R> = ((...args: A) => R) & { immediate: (...args: A) => R };

export interface Driver {
  readonly name: DriverName;
  /** Why this driver holds the file, in a sentence the self-test and the startup log print. */
  readonly reason: string;
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /** `PRAGMA <text>` — reads and assignments alike; returns the first row when the pragma answers with one. */
  pragma(text: string): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): Transaction<A, R>;
  /**
   * Run `fn` with SQLite's DEFENSIVE flag off, so it may delete rows from a
   * virtual table's shadow tables, and turn it back on after. Used for one
   * thing: erasing a retired search index a page at a time (search-index.ts,
   * retiring an index). better-sqlite3 opens every connection defensive;
   * node:sqlite does not, and turns it off only where it can.
   */
  writeShadowTables<R>(fn: () => R): R;
  /**
   * Define a SQL function on this connection, callable from statements
   * only (never from a trigger or view the file carries), and not
   * deterministic. An error it throws ends the statement and reaches the
   * caller as it was thrown: the search reads its matches through one, so
   * it can stop at its time budget and keep what it read (sqlite-adapter).
   */
  fn(name: string, impl: (...args: unknown[]) => unknown): void;
  close(): void;
}

export interface OpenOptions {
  /** Busy timeout in milliseconds, set on the connection before the first statement. */
  timeout?: number;
  /** Refuse to create the file (the self-test's read of an existing database). */
  fileMustExist?: boolean;
  /** Open for reading only (the search worker's connection): no statement on it can write the file. */
  readOnly?: boolean;
  /** Force a driver; unset reads IRIS_SQLITE_DRIVER, then defaults to native with the fallback. */
  driver?: 'native' | 'node';
  /** Whether a native load failure may fall back to the built-in (default true; a test turns it off). */
  allowFallback?: boolean;
  /** Where the fallback warning goes (default: process.stderr). */
  warn?: (line: string) => void;
  /** Injectable for tests: how the native module is loaded. */
  loadNative?: () => NativeModule;
  /** Injectable for tests: how the built-in module is loaded. */
  loadNode?: () => NodeSqliteModule;
  /**
   * Injectable for tests: the native binary to inspect before loading it
   * (nativeAbortsOnCollect). Unset, it is the one better-sqlite3 would
   * load, unless `loadNative` is injected, which loads something else.
   */
  nativeBinary?: () => string | undefined;
}

export const DRIVER_VAR = 'IRIS_SQLITE_DRIVER';
export const NODE_SQLITE_MIN = '22.13.0';

/**
 * How many prepared statements one connection keeps. The store's working
 * set is a few dozen fixed statements; the rest is SQL built per call (an
 * `IN (?, ?, …)` list is one statement per length), so the bound is a
 * least-recently-used list rather than a guess at the set, and a burst of
 * one-off statements pushes out other one-off statements first.
 */
export const STATEMENT_CACHE_SIZE = 256;

/**
 * SQLITE_SCHEMA as each driver throws it: better-sqlite3 sets `code:
 * 'SQLITE_SCHEMA'`; node:sqlite sets `errcode: 17`.
 */
export function isSchemaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown };
  return e.code === 'SQLITE_SCHEMA' || (typeof e.errcode === 'number' && (e.errcode & 0xff) === 17);
}

/**
 * Prepare each SQL text once per connection and hand back the same
 * statement after that.
 *
 * A kept statement stays correct when the schema changes under it — a
 * migration, the search index built or retired, another process upgrading
 * the file. Both drivers prepare with sqlite3_prepare_v2 or v3, so SQLite
 * recompiles an expired statement on its next step by itself. It gives up
 * with SQLITE_SCHEMA only when the schema keeps changing through its own
 * retries; then the statement here is prepared again from its text and the
 * call made once more, and a second failure is thrown as it came.
 *
 * Safe to share because every caller here runs a statement to completion
 * inside one synchronous call (run, get or all; nothing iterates), so a
 * kept statement is never mid-step when the next caller takes it.
 */
export function statementCache(prepare: (sql: string) => Statement, size: number = STATEMENT_CACHE_SIZE): { prepare: (sql: string) => Statement; clear: () => void; readonly size: number } {
  const kept = new Map<string, Statement>();
  const fresh = (sql: string): Statement => {
    let inner = prepare(sql);
    const call =
      <M extends keyof Statement>(method: M) =>
      (...params: unknown[]): ReturnType<Statement[M]> => {
        try {
          return inner[method](...params) as ReturnType<Statement[M]>;
        } catch (err) {
          if (!isSchemaError(err)) throw err;
          inner = prepare(sql);
          return inner[method](...params) as ReturnType<Statement[M]>;
        }
      };
    return { run: call('run'), get: call('get'), all: call('all') };
  };
  return {
    prepare: (sql) => {
      const hit = kept.get(sql);
      if (hit !== undefined) {
        // Most recently used goes to the back; the front is the next to go.
        kept.delete(sql);
        kept.set(sql, hit);
        return hit;
      }
      const st = fresh(sql);
      kept.set(sql, st);
      if (kept.size > size) kept.delete(kept.keys().next().value as string);
      return st;
    },
    clear: () => kept.clear(),
    get size() {
      return kept.size;
    },
  };
}

/* ---- The native driver: better-sqlite3 ---- */

type NativeStatement = { run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
type FunctionOptions = { deterministic: boolean; directOnly: boolean };
type NativeDatabase = {
  prepare(sql: string): NativeStatement;
  exec(sql: string): unknown;
  pragma(text: string): unknown;
  function(name: string, options: FunctionOptions, impl: (...args: unknown[]) => unknown): unknown;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F & { immediate: F };
  /** Also switches SQLITE_DBCONFIG_DEFENSIVE: off in unsafe mode, on outside it. */
  unsafeMode(on: boolean): unknown;
  close(): void;
};
type NativeModule = new (path: string, options?: { timeout?: number; fileMustExist?: boolean; readonly?: boolean }) => NativeDatabase;

const require = createRequire(import.meta.url);

function defaultLoadNative(): NativeModule {
  // Loaded here, not at the top of the module, so a missing or mismatched
  // addon is a load failure this function can answer — with the built-in —
  // rather than an import error that kills the process before any code runs.
  return require('better-sqlite3') as NativeModule;
}

function nativeDriver(Database: NativeModule, path: string, options: OpenOptions, reason: string): Driver {
  const db = new Database(path, {
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.fileMustExist ? { fileMustExist: true } : {}),
    ...(options.readOnly ? { readonly: true } : {}),
  });
  const statements = statementCache((sql) => db.prepare(sql));
  return {
    name: 'better-sqlite3',
    reason,
    prepare: statements.prepare,
    exec: (sql) => {
      db.exec(sql);
    },
    pragma: (text) => db.pragma(text),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => db.transaction(fn as (...args: never[]) => unknown) as unknown as Transaction<A, R>,
    writeShadowTables: (fn) => {
      db.unsafeMode(true);
      try {
        return fn();
      } finally {
        db.unsafeMode(false);
      }
    },
    fn: (name, impl) => {
      db.function(name, { deterministic: false, directOnly: true }, impl);
    },
    close: () => {
      statements.clear();
      db.close();
    },
  };
}

/* ---- A native binary that aborts when a statement is collected ---- */

/*
 * Node 24.19.0 changed the header-only `node::ObjectWrap`: its constructor
 * now registers an environment cleanup hook and its destructor removes it
 * with `node::RemoveEnvironmentCleanupHook(isolate, ...)`. On a runtime
 * without Node's global list of addon cleanup hooks, that call asserts
 * there is a current Environment, and during a garbage collection there
 * is none: the process aborts with "Assertion failed: (env) != nullptr"
 * (nodejs/node#65446). better-sqlite3 12.x wraps every Database, Statement
 * and iterator in an ObjectWrap, so a binary compiled against those
 * headers aborts the first time V8 frees a statement, whether the
 * database is open or closed. Measured on Node 24.21.0 with 12.11.1: a
 * binary built from source aborted in 10 runs of 10, the prebuilt binary
 * (compiled against older headers) in 0 of 10, and no exit path aborted.
 *
 * The prebuilt binaries are safe. The case is a binary npm compiled here:
 * no prebuild for the platform, or the prebuild download failed and
 * `prebuild-install || node-gyp rebuild` fell through to the compiler.
 * Such a binary imports RemoveEnvironmentCleanupHook, which no
 * better-sqlite3 source calls, so the name in the file is the mark.
 * Iris reads the file before loading it and, where the runtime cannot
 * survive it, uses Node's built-in SQLite instead of aborting later.
 */
export const OBJECTWRAP_HOOK_SYMBOL = 'RemoveEnvironmentCleanupHook';

/**
 * Whether this Node keeps the global list of addon cleanup hooks
 * (nodejs/node 1723773d), so an ObjectWrap freed during a collection is
 * safe. 26.x has it from 26.4.0, the release that also changed the header.
 * On 24.x it is on the v24.x-staging branch (nodejs/node#65943) and in no
 * release up to 24.21.0; the CI job `native addon built from source`
 * fails when a 24.x runtime stops aborting, which is when this line moves.
 * Older lines never changed the header, so their binaries never carry the mark.
 */
export function runtimeKeepsAddonHooks(version: string = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  if (major > 26) return true;
  if (major === 26) return minor >= 4;
  return false;
}

/** The better_sqlite3.node that `require('better-sqlite3')` would load, found the way it finds it; undefined when there is none. */
export function nativeBinaryPath(): string | undefined {
  try {
    const pkg = require.resolve('better-sqlite3/package.json');
    const bindings = createRequire(pkg)('bindings') as (opts: { bindings: string; path: true; module_root: string }) => string;
    return bindings({ bindings: 'better_sqlite3.node', path: true, module_root: dirname(pkg) });
  } catch {
    return undefined;
  }
}

/**
 * The binary carries the ObjectWrap cleanup hook and this runtime would
 * abort on it. A file that cannot be found or read is not evidence either
 * way: the load that follows reports what is wrong with it.
 */
export function nativeAbortsOnCollect(binary: string | undefined, version: string = process.versions.node): boolean {
  if (binary === undefined || runtimeKeepsAddonHooks(version)) return false;
  let marked = carriesHookMark.get(binary);
  if (marked === undefined) {
    try {
      // About 2 MB, read once per process (4 ms measured); every store opened after that asks the map.
      marked = readFileSync(binary).includes(OBJECTWRAP_HOOK_SYMBOL);
    } catch {
      return false;
    }
    carriesHookMark.set(binary, marked);
  }
  return marked;
}
const carriesHookMark = new Map<string, boolean>();

/* ---- The built-in driver: node:sqlite ---- */

type NodeStatement = { run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
type NodeDatabase = {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  function(name: string, options: FunctionOptions, impl: (...args: unknown[]) => unknown): void;
  close(): void;
  enableDefensive?(on: boolean): void;
};
type NodeSqliteModule = { DatabaseSync: new (path: string, options?: Record<string, unknown>) => NodeDatabase };

function defaultLoadNode(): NodeSqliteModule {
  return require('node:sqlite') as NodeSqliteModule;
}

export function nodeSqliteAvailable(loadNode: () => NodeSqliteModule = defaultLoadNode): boolean {
  try {
    return typeof loadNode().DatabaseSync === 'function';
  } catch {
    return false;
  }
}

function nodeDriver(mod: NodeSqliteModule, path: string, options: OpenOptions, reason: string): Driver {
  if (options.fileMustExist && path !== ':memory:' && !existsSync(path)) {
    // DatabaseSync has no "must exist" switch and open() creates the file; refuse here, as the native driver does.
    throw new Error(`SQLite database file does not exist: ${path}`);
  }
  // No extension loading — a plugin-shaped .so is not something a trace store should ever load.
  const db = new mod.DatabaseSync(path, { allowExtension: false, ...(options.readOnly ? { readOnly: true } : {}) });
  if (options.timeout !== undefined) db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.timeout))}`);
  // The hardening the built-in exposes: schema text is never trusted to run functions or virtual tables.
  db.exec('PRAGMA trusted_schema = OFF');
  let depth = 0;
  let savepoints = 0;
  const runIn = <A extends unknown[], R>(mode: 'DEFERRED' | 'IMMEDIATE', fn: (...args: A) => R, args: A): R => {
    if (depth > 0) {
      const sp = `iris_sp_${++savepoints}`;
      db.exec(`SAVEPOINT ${sp}`);
      depth += 1;
      try {
        const out = fn(...args);
        db.exec(`RELEASE ${sp}`);
        return out;
      } catch (err) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
        throw err;
      } finally {
        depth -= 1;
      }
    }
    db.exec(`BEGIN ${mode}`);
    depth += 1;
    try {
      const out = fn(...args);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth -= 1;
    }
  };
  /*
   * node:sqlite reads a statement's column count before its first step, and
   * SQLite recompiles an expired statement inside that step: so the first
   * read after the schema changed builds its rows with the old count — a
   * column added is missing, a table rebuilt with fewer columns throws
   * "Cannot get name of column". A statement prepared fresh is no cure when
   * another connection made the change: this connection compiles against
   * the schema it last loaded until a step notices. (better-sqlite3 has
   * neither gap; the statement-cache tests hold both drivers.) So a read
   * checks the schema version first, one pragma; when it moved, one step
   * over sqlite_schema makes the connection load the new schema, and the
   * statement is prepared again against it.
   */
  const schemaVersion = db.prepare('PRAGMA schema_version');
  const loadSchema = db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1');
  const version = (): unknown => (schemaVersion.get() as { schema_version: unknown }).schema_version;
  let loaded: unknown;
  const currentSchema = (): unknown => {
    const now = version();
    if (now !== loaded) {
      loadSchema.get();
      loaded = now;
    }
    return now;
  };
  const statements = statementCache((sql) => {
    const preparedAgainst = currentSchema();
    let st = db.prepare(sql);
    let preparedAt = preparedAgainst;
    const current = (): NodeStatement => {
      const now = currentSchema();
      if (now !== preparedAt) {
        st = db.prepare(sql);
        preparedAt = now;
      }
      return st;
    };
    return {
      run: (...p) => {
        const r = st.run(...p);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: (...p) => current().get(...p),
      all: (...p) => current().all(...p),
    };
  });
  return {
    name: 'node',
    reason,
    prepare: statements.prepare,
    exec: (sql) => db.exec(sql),
    pragma: (text) => db.prepare(`PRAGMA ${text}`).get(),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const tx = ((...args: A) => runIn('DEFERRED', fn, args)) as Transaction<A, R>;
      tx.immediate = (...args: A) => runIn('IMMEDIATE', fn, args);
      return tx;
    },
    writeShadowTables: (fn) => {
      // A Node that opens connections defensive has the switch to turn it off; one without the switch never turned it on.
      if (typeof db.enableDefensive !== 'function') return fn();
      db.enableDefensive(false);
      try {
        return fn();
      } finally {
        db.enableDefensive(true);
      }
    },
    fn: (name, impl) => {
      // Every built-in with FTS5 (22.16+) has it; one without never runs the statements that call it (the search reads the traces instead).
      if (typeof db.function === 'function') db.function(name, { deterministic: false, directOnly: true }, impl);
    },
    close: () => {
      statements.clear();
      db.close();
    },
  };
}

/* ---- Selection ---- */

function nodeSupportsSqlite(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/** Which driver `IRIS_SQLITE_DRIVER` asks for; a name that is neither is refused at once. */
export function requestedDriver(raw: string | undefined = process.env.IRIS_SQLITE_DRIVER): 'native' | 'node' | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'native' || v === 'better-sqlite3') return 'native';
  if (v === 'node' || v === 'node:sqlite') return 'node';
  throw new Error(`${DRIVER_VAR}=${JSON.stringify(raw)} is not a driver. Use "native" (better-sqlite3, the default) or "node" (Node's built-in node:sqlite, Node ${NODE_SQLITE_MIN} or later).`);
}

/**
 * Open the file with the driver the deployment chose, else native with
 * the fallback. The one place the choice is made, so the adapter, the
 * self-test and the health contract cannot disagree about which driver
 * holds the file.
 */
export function openDriver(path: string, options: OpenOptions = {}): Driver {
  const choice = options.driver ?? requestedDriver();
  const loadNative = options.loadNative ?? defaultLoadNative;
  const loadNode = options.loadNode ?? defaultLoadNode;
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (choice === 'node') {
    if (!nodeSupportsSqlite() && options.loadNode === undefined) {
      throw new Error(`${DRIVER_VAR}=node needs Node ${NODE_SQLITE_MIN} or later for node:sqlite; this is Node ${process.versions.node}. Unset it to use better-sqlite3.`);
    }
    return nodeDriver(loadNode(), path, options, `${DRIVER_VAR}=node chose Node's built-in SQLite`);
  }

  /** The native driver cannot hold the file: fall back to the built-in with one warning, or refuse, naming why and the fix. */
  const fallBack = (what: string, fix: string, reason: string): Driver => {
    const canFallBack = options.allowFallback !== false && choice === undefined && nodeSqliteAvailable(loadNode);
    if (!canFallBack) {
      throw new Error(
        `${what}. ` +
          (choice === 'native'
            ? `${DRIVER_VAR}=native forbids the fallback; unset it to let Iris use Node's built-in SQLite (Node ${NODE_SQLITE_MIN}+), or ${fix}.`
            : `Node's built-in SQLite is not available on Node ${process.versions.node} (it needs ${NODE_SQLITE_MIN}+); ${fix}, or upgrade Node.`),
      );
    }
    warn(
      `[iris.storage] ${what}; using Node's built-in SQLite (node:sqlite). ` +
        `The store works the same; the native driver is faster and is what the proof was measured on — ${fix}, or set ${DRIVER_VAR}=node to choose the built-in on purpose.`,
    );
    return nodeDriver(loadNode(), path, options, reason);
  };

  // Read before loading: once a statement of this binary exists, the next collection can abort the process.
  const binary = (options.nativeBinary ?? (options.loadNative ? () => undefined : nativeBinaryPath))();
  if (nativeAbortsOnCollect(binary)) {
    return fallBack(
      `The native SQLite module (better-sqlite3) at ${binary} was compiled against Node headers that make it abort on Node ${process.versions.node} when it frees a statement (nodejs/node#65446)`,
      'reinstall the prebuilt binary with npm rebuild better-sqlite3 (it is compiled against headers without the change)',
      `better-sqlite3 here was compiled against Node headers that abort on Node ${process.versions.node} when a statement is freed (nodejs/node#65446), so Iris uses Node's built-in SQLite`,
    );
  }

  let Database: NativeModule;
  try {
    Database = loadNative();
    // better-sqlite3 loads its binding lazily, in the constructor: an in-memory
    // open is the probe that surfaces a missing, disabled or mismatched addon
    // with no file involved. A file error later is a real error, never a
    // reason to switch drivers.
    new Database(':memory:').close();
  } catch (err) {
    const absent = notInstalled(err);
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    // Not installed and failed to load are different facts with different fixes: say which.
    return fallBack(
      absent
        ? 'The native SQLite module (better-sqlite3) is not installed — it is optional, and npm skips it when it cannot build it for this platform'
        : `The native SQLite module (better-sqlite3) could not load (${reason})`,
      absent ? 'install it with npm install better-sqlite3 where a prebuilt binary or a C++ toolchain is available' : 'reinstall it with npm rebuild better-sqlite3',
      absent ? 'better-sqlite3 is not installed (optional; npm skips it when it cannot build it here), so Iris uses Node\'s built-in SQLite' : `better-sqlite3 could not load (${reason}), so Iris uses Node's built-in SQLite`,
    );
  }
  return nativeDriver(Database, path, options, choice === 'native' ? `${DRIVER_VAR}=native chose better-sqlite3` : 'better-sqlite3 loaded (the default)');
}

/** The module is absent, as opposed to present and failing to load its binding. */
function notInstalled(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return !!e && e.code === 'MODULE_NOT_FOUND' && typeof e.message === 'string' && e.message.includes("'better-sqlite3'");
}

/**
 * SQLITE_BUSY as each driver throws it: better-sqlite3 sets `code:
 * 'SQLITE_BUSY'`; node:sqlite sets `code: 'ERR_SQLITE_ERROR'` with
 * `errcode: 5` and the message "database is locked". SQLITE_LOCKED (6,
 * "database table is locked") is a different condition and is not this.
 */
export function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  if (e.code === 'SQLITE_BUSY' || e.errcode === 5) return true;
  return typeof e.message === 'string' && /\bdatabase is locked\b/.test(e.message);
}
