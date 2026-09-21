/*
 * The SQLite driver seam (arc 8, R-0; plan §4.19).
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
 * Both drivers return the same shapes the adapter reads: `run()` gives
 * `{ changes }`, `get()` one row or undefined, `all()` rows; positional `?`
 * parameters; `transaction(fn)` returns a callable with `.immediate()`
 * (nested calls become savepoints, as the native driver does).
 */
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

function nativeDriver(Database: NativeModule, path: string, options: OpenOptions): Driver {
  const db = new Database(path, { ...(options.timeout !== undefined ? { timeout: options.timeout } : {}), ...(options.fileMustExist ? { fileMustExist: true } : {}) });
  return {
    name: 'better-sqlite3',
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

function nodeDriver(mod: NodeSqliteModule, path: string, options: OpenOptions): Driver {
  const db = new mod.DatabaseSync(path, {
    // No extension loading — a plugin-shaped .so is not something a trace
    // store should ever load; `open` false is what fileMustExist wants.
    allowExtension: false,
    ...(options.fileMustExist ? { open: false } : {}),
  });
  if (options.fileMustExist) {
    // DatabaseSync has no "must exist" switch; open it read-write only if the file is there.
    (db as unknown as { open(): void }).open();
  }
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
export function requestedDriver(env: NodeJS.ProcessEnv = process.env): 'native' | 'node' | undefined {
  const raw = env[DRIVER_VAR];
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
    return nodeDriver(loadNode(), path, options);
  }

  let Database: NativeModule;
  try {
    Database = loadNative();
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    const canFallBack = options.allowFallback !== false && choice === undefined && nodeSqliteAvailable(loadNode);
    if (!canFallBack) {
      throw new Error(
        `The native SQLite module (better-sqlite3) could not load: ${reason}. ` +
          (choice === 'native'
            ? `${DRIVER_VAR}=native forbids the fallback; unset it to let Iris use Node's built-in SQLite (Node ${NODE_SQLITE_MIN}+), or reinstall the module (npm rebuild better-sqlite3).`
            : `Node's built-in SQLite is not available on Node ${process.versions.node} (it needs ${NODE_SQLITE_MIN}+); reinstall the module (npm rebuild better-sqlite3) or upgrade Node.`),
      );
    }
    warn(
      `[iris.storage] The native SQLite module (better-sqlite3) could not load (${reason}); falling back to Node's built-in SQLite (node:sqlite). ` +
        `The store works the same; the native driver is faster and is what the proof was measured on — reinstall it with npm rebuild better-sqlite3, or set ${DRIVER_VAR}=node to choose the built-in on purpose.`,
    );
    return nodeDriver(loadNode(), path, options);
  }
  return nativeDriver(Database, path, options);
}
