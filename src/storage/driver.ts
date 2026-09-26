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
 * migrations, the self-test — talks to a `Driver` with five verbs:
 * prepare, exec, pragma, transaction, close. Two drivers implement it:
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
 * is a slower start, not a dead one. A name that is neither is refused.
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
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

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
  close(): void;
}

export interface OpenOptions {
  /** Busy timeout in milliseconds, set on the connection before the first statement. */
  timeout?: number;
  /** Refuse to create the file (the self-test's read of an existing database). */
  fileMustExist?: boolean;
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
}

export const DRIVER_VAR = 'IRIS_SQLITE_DRIVER';
export const NODE_SQLITE_MIN = '22.13.0';

/* ---- The native driver: better-sqlite3 ---- */

type NativeStatement = { run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
type NativeDatabase = {
  prepare(sql: string): NativeStatement;
  exec(sql: string): unknown;
  pragma(text: string): unknown;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F & { immediate: F };
  close(): void;
};
type NativeModule = new (path: string, options?: { timeout?: number; fileMustExist?: boolean }) => NativeDatabase;

const require = createRequire(import.meta.url);

function defaultLoadNative(): NativeModule {
  // Loaded here, not at the top of the module, so a missing or mismatched
  // addon is a load failure this function can answer — with the built-in —
  // rather than an import error that kills the process before any code runs.
  return require('better-sqlite3') as NativeModule;
}

function nativeDriver(Database: NativeModule, path: string, options: OpenOptions, reason: string): Driver {
  const db = new Database(path, { ...(options.timeout !== undefined ? { timeout: options.timeout } : {}), ...(options.fileMustExist ? { fileMustExist: true } : {}) });
  return {
    name: 'better-sqlite3',
    reason,
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => {
      db.exec(sql);
    },
    pragma: (text) => db.pragma(text),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => db.transaction(fn as (...args: never[]) => unknown) as unknown as Transaction<A, R>,
    close: () => db.close(),
  };
}

/* ---- The built-in driver: node:sqlite ---- */

type NodeStatement = { run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
type NodeDatabase = { prepare(sql: string): NodeStatement; exec(sql: string): void; close(): void };
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
  const db = new mod.DatabaseSync(path, { allowExtension: false });
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
  return {
    name: 'node',
    reason,
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        run: (...p) => {
          const r = st.run(...p);
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
        },
        get: (...p) => st.get(...p),
        all: (...p) => st.all(...p),
      };
    },
    exec: (sql) => db.exec(sql),
    pragma: (text) => db.prepare(`PRAGMA ${text}`).get(),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const tx = ((...args: A) => runIn('DEFERRED', fn, args)) as Transaction<A, R>;
      tx.immediate = (...args: A) => runIn('IMMEDIATE', fn, args);
      return tx;
    },
    close: () => db.close(),
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
    const what = absent
      ? 'The native SQLite module (better-sqlite3) is not installed — it is optional, and npm skips it when it cannot build it for this platform'
      : `The native SQLite module (better-sqlite3) could not load (${reason})`;
    const fix = absent ? 'install it with npm install better-sqlite3 where a prebuilt binary or a C++ toolchain is available' : 'reinstall it with npm rebuild better-sqlite3';
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
    return nodeDriver(loadNode(), path, options, absent ? 'better-sqlite3 is not installed (optional; npm skips it when it cannot build it here), so Iris uses Node\'s built-in SQLite' : `better-sqlite3 could not load (${reason}), so Iris uses Node's built-in SQLite`);
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
