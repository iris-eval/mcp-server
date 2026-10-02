import type { Driver } from '../driver.js';
import * as migration001 from './001-initial-schema.js';
import * as migration002 from './002-eval-skip-fields.js';
import * as migration003 from './003-eval-passed-index.js';
import * as migration004 from './004-tenant-id.js';
import * as migration005 from './005-normalize-created-at.js';
import * as migration006 from './006-eval-critical-failures.js';
import * as migration007 from './007-eval-provenance.js';
import * as migration008 from './008-trace-tools-catalogue.js';
import * as migration009 from './009-runs-and-case-keys.js';
import * as migration010 from './010-trace-source.js';
import * as migration011 from './011-verdict-labels.js';
import * as migration012 from './012-datasets.js';
import * as migration013 from './013-run-baseline.js';
import * as migration014 from './014-trace-session.js';
import * as migration015 from './015-trace-search.js';
import * as migration016 from './016-trace-cost-source.js';
import * as migration017 from './017-relevance-judge-spend.js';
import * as migration018 from './018-eval-risk-estimate.js';
import * as migration019 from './019-read-paths.js';
import * as migration020 from './020-eval-reference-trace.js';
import * as migration021 from './021-eval-verdict-state.js';
import { PKG_VERSION } from '../../config/defaults.js';
import { compareVersions, isVersion, latestVersion } from '../../utils/versions.js';

/*
 * The compatibility floor (0.20.0, #704). Each migration names the oldest
 * Iris release that can still use a database it has been applied to, and
 * the ledger stores that floor beside the migration's id. A release that
 * finds a migration it does not know reads the floor the newer release left
 * and opens the file when it is at or below its own version, so a migration
 * that only adds something an older release can live with (a table it never
 * reads, an index) does not lock that release out. Before 0.20.0 every
 * unknown migration refused the start, and those releases still do.
 *
 * Choosing a floor for a new migration: the release that introduces it,
 * unless every write the previous releases make keeps the new schema right
 * (a trigger, a constraint or a derived table they do not maintain is the
 * usual reason not). Lowering it is a promise every release from the floor
 * on must keep; test it against the older release's own package, as
 * 015-trace-search.ts records. The other direction matters too: a
 * migration that drops or renames something an earlier release relies on
 * by name (a column its inserts list, an index its queries name with
 * INDEXED BY) takes a floor of its own release, since those releases would
 * open the file and then fail on it.
 */
interface Migration {
  id: string;
  compatFloor: string;
  up(db: Driver): void;
}

const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
];

/** Every migration this build knows, in order. */
export const KNOWN_MIGRATION_IDS: readonly string[] = migrations.map((m) => m.id);

/** Each known migration's compatibility floor, by id. */
export const COMPAT_FLOORS: ReadonlyMap<string, string> = new Map(migrations.map((m) => [m.id, m.compatFloor]));

export interface MigrationState {
  /** How many of the known migrations the database has applied. */
  applied: number;
  /** How many this build knows. */
  known: number;
  /** Known and not applied — empty after a successful boot. */
  pending: string[];
}

/**
 * What the database has applied against what this build knows: the
 * health contract reports it so an operator can see a schema is
 * behind before a query fails on a missing column. Reads only.
 */
export function migrationState(db: Driver): MigrationState {
  const applied = new Set((db.prepare('SELECT id FROM _iris_migrations').all() as Array<{ id: string }>).map((r) => r.id));
  const pending = KNOWN_MIGRATION_IDS.filter((id) => !applied.has(id));
  return { applied: KNOWN_MIGRATION_IDS.length - pending.length, known: KNOWN_MIGRATION_IDS.length, pending };
}

/** One row of the ledger, as this build reads it. */
export interface LedgerRow {
  id: string;
  /** The release that applied it; null on rows written before 0.9.0 recorded one. */
  writerVersion: string | null;
  /** The floor the ledger holds for it, else this build's own for a migration it knows; null when neither exists. */
  compatFloor: string | null;
  /** Whether this build knows the migration. */
  known: boolean;
}

/** A database's migrations against this build's, before anything is applied. */
export interface MigrationPlan {
  /** The ledger's rows. Empty for a new file. */
  applied: LedgerRow[];
  /** Known migrations the file has not applied, in order. */
  pending: string[];
  /** Applied migrations this build does not know. */
  unknown: LedgerRow[];
  /** Of those, the ones whose floor is above this version, or that record none: any of them refuses the start. */
  blocking: LedgerRow[];
  /** The newest release that applied a migration to the file; null when none is recorded. */
  lastWriter: string | null;
  /** The oldest release that can open the file as it is; null for a new file. */
  floor: string | null;
  /** The same once the pending migrations are applied. */
  floorAfter: string | null;
  /** The version the plan was made for. */
  version: string;
}

function columns(db: Driver, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name));
}

/**
 * Read the ledger and compare it with this build. Reads only: the
 * self-test runs it on a read-only connection to the configured file.
 */
export function inspectMigrations(db: Driver, version: string = PKG_VERSION): MigrationPlan {
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_iris_migrations'").get() !== undefined;
  const cols = hasLedger ? columns(db, '_iris_migrations') : new Set<string>();
  const rows = hasLedger
    ? (db
        .prepare(
          `SELECT id, ${cols.has('writer_version') ? 'writer_version' : 'NULL AS writer_version'}, ${cols.has('compat_floor') ? 'compat_floor' : 'NULL AS compat_floor'} FROM _iris_migrations`,
        )
        .all() as Array<{ id: string; writer_version: string | null; compat_floor: string | null }>)
    : [];
  const applied: LedgerRow[] = rows.map((r) => {
    const known = COMPAT_FLOORS.has(r.id);
    const recorded = r.compat_floor && isVersion(r.compat_floor) ? r.compat_floor : null;
    return { id: r.id, writerVersion: r.writer_version, compatFloor: recorded ?? (known ? COMPAT_FLOORS.get(r.id)! : null), known };
  });
  const appliedIds = new Set(applied.map((r) => r.id));
  const pending = KNOWN_MIGRATION_IDS.filter((id) => !appliedIds.has(id));
  const unknown = applied.filter((r) => !r.known);
  const blocking = unknown.filter((r) => r.compatFloor === null || compareVersions(r.compatFloor, version) > 0);
  const floor = latestVersion(applied.map((r) => r.compatFloor));
  return {
    applied,
    pending,
    unknown,
    blocking,
    lastWriter: latestVersion(applied.map((r) => r.writerVersion)),
    floor,
    floorAfter: latestVersion([floor, ...pending.map((id) => COMPAT_FLOORS.get(id))]),
    version,
  };
}

/** Where the README says how to go back to an older release. */
export const DOWNGRADING_URL = 'https://github.com/iris-eval/mcp-server#downgrading';

/** A database this version cannot open: a newer release applied a migration whose floor is above it. */
export class IncompatibleDatabaseError extends Error {
  constructor(readonly plan: MigrationPlan) {
    const writers = [...new Set(plan.blocking.map((r) => r.writerVersion ?? 'an unknown version'))].join(', ');
    const floors = plan.blocking.map((r) => r.compatFloor);
    const needs = floors.every((f) => f !== null) ? `need Iris ${latestVersion(floors)} or later` : 'need a newer Iris';
    super(
      `This database was migrated by a newer Iris (${writers}) — migration(s) ${plan.blocking.map((r) => r.id).join(', ')} ${needs}, and this is v${plan.version}. ` +
        'Upgrade Iris: `npx -y @iris-eval/mcp-server@latest install --upgrade` moves every MCP client on this machine to the newest release. ' +
        `To go back to v${plan.version} instead, restore the backup taken before that upgrade (${DOWNGRADING_URL}), or point IRIS_DB_PATH at a database this version wrote.`,
    );
    this.name = 'IncompatibleDatabaseError';
  }
}

/** Refuse a plan with a blocking migration. */
export function assertCompatible(plan: MigrationPlan): void {
  if (plan.blocking.length > 0) throw new IncompatibleDatabaseError(plan);
}

export function runMigrations(db: Driver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _iris_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  /*
   * A downgrade guard (0.9.0). Before it, a binary that did not know a
   * migration silently ignored it and read a schema newer than itself —
   * half the columns, none of the meaning. An applied id this build has
   * never heard of refuses to start, naming the version that wrote it, so
   * the operator upgrades instead of corrupting — unless its compatibility
   * floor (above) says this version can use the file.
   */
  assertCompatible(inspectMigrations(db));

  // The floor column (0.20.0), added under the write lock so two processes starting on one file cannot both add it.
  db.transaction(() => {
    if (!columns(db, '_iris_migrations').has('compat_floor')) db.exec('ALTER TABLE _iris_migrations ADD COLUMN compat_floor TEXT');
  }).immediate();

  /*
   * Two processes on one cold file — a server booting and a hook-driven
   * `ingest` — both used to read "not applied" and then both try to apply:
   * the second writer failed on SQLITE_BUSY_SNAPSHOT or a duplicate column.
   * Each migration now runs under BEGIN IMMEDIATE (the write lock is taken
   * before anything is read) and re-checks the applied set INSIDE that
   * lock, so the loser of the race sees the winner's row and skips. The
   * busy_timeout the adapter sets is what makes the loser wait rather than
   * fail.
   */
  const isApplied = db.prepare('SELECT 1 FROM _iris_migrations WHERE id = ?');
  const markApplied = db.prepare('INSERT INTO _iris_migrations (id, compat_floor) VALUES (?, ?)');
  for (const migration of migrations) {
    db.transaction(() => {
      if (isApplied.get(migration.id)) return;
      migration.up(db);
      markApplied.run(migration.id, migration.compatFloor);
    }).immediate();
  }
  // Every applied migration names the binary that applied it (this one, for
  // rows written before the column existed — the closest true statement),
  // and its floor (rows written before 0.20.0 recorded none).
  db.transaction(() => {
    db.prepare('UPDATE _iris_migrations SET writer_version = ? WHERE writer_version IS NULL').run(PKG_VERSION);
    const setFloor = db.prepare('UPDATE _iris_migrations SET compat_floor = ? WHERE id = ? AND compat_floor IS NULL');
    for (const m of migrations) setFloor.run(m.compatFloor, m.id);
  }).immediate();
}
