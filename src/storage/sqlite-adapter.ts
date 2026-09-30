/*
 * SqliteAdapter — tenant-enforcing SQLite implementation of IStorageAdapter.
 *
 * Every public method takes a TenantId as its first parameter and uses
 * it in the SQL layer to prevent cross-tenant data leaks. See the
 * 2026-04-23 threat model §5 for the design principles.
 *
 * Discipline:
 *   - Every method first validates tenantId is a non-empty string.
 *     If validation fails, throws TenantContextRequiredError. This is
 *     defense-in-depth — the TenantId type system already prevents
 *     empty strings at compile time, but we verify at runtime too so
 *     any dynamic bypass (e.g. a buggy cast) still fails safe.
 *   - Every INSERT binds tenant_id from the parameter, never from the
 *     payload data.
 *   - Every SELECT includes `WHERE tenant_id = ?` as the first
 *     condition; composite indexes put tenant_id first.
 *   - Aggregate queries (stats, trends) scope to the tenant.
 *   - DELETE operations scope to the tenant — a tenant can only delete
 *     its own data.
 */
import { openDriver, isBusyError, type Driver, type DriverName } from './driver.js';
import { resolveCaseKey } from '../eval/case-key.js';

/** How long a statement waits on another connection's lock before SQLITE_BUSY — on the connection and as the pragma, one number. */
export const BUSY_TIMEOUT_MS = 5000;
import { toolsHash } from '../eval/catalogue.js';
import { evidenceSignature, issueKey } from '../eval/labels.js';
import { ensureOwnerOnly } from '../utils/write-atomic.js';
import type {
  IStorageAdapter,
  DashboardSummary,
  TraceQueryOptions,
  TraceQueryResult,
  TraceSearchInfo,
  TraceExportOptions,
  TraceRecord,
  EvalResultFilter,
  SearchWorkerStatus,
  EvalStatsPeriod,
  EvalStats,
  AgentFailureLogEntry,
  AgentCostRow,
  DriftWindow,
  EvalStatsTrendBucket,
  TrendCohort,
  EvalStatsRuleBreakdown,
  EvalStatsFailure,
  IssueGroup,
  LabelTallyRow,
  RuleFireStat,
  VerdictLabel,
} from '../types/query.js';
import type { Trace, Span } from '../types/trace.js';
import type { EvalResult, QuestionId, Provenance, EvalRuleResult, Evidence } from '../types/eval.js';
import { deriveCoverage, deriveCriticalSkipped } from '../eval/verdict.js';
import { compose, interpretations, DEFAULT_COMPOSE, type ComposeConfig } from '../eval/compose.js';
import { rememberRiskEstimate, storedRiskEstimate, RISK_KEY_VERSION } from '../eval/risk.js';
import type { TenantId } from '../types/tenant.js';
import { TenantContextRequiredError } from '../types/tenant.js';
import { randomBytes } from 'node:crypto';
import { runMigrations, migrationState, inspectMigrations, assertCompatible, DOWNGRADING_URL, type MigrationState, type MigrationPlan } from './migrations/index.js';
import { backupDatabase, backupDatabaseWith, type BackupResult } from './backup.js';
import { PKG_VERSION } from '../config/defaults.js';
import { Checkpointer, AUTOCHECKPOINT_PAGES, TAIL_CHECKPOINT_PAGES, STEP_TRUNCATE_PAGES } from './checkpointer.js';
import { readPathsMissing, DROP_REPLACED, READ_PATH_INDEX_NAMES } from './read-paths.js';
import { assumeFts5, fts5Available, reconcileSearchIndex, indexNextBatch, nextBuildBatch, nextStepSize, eraseRetiredStep, isShadowWriteRefused, retiredRemain, ERASE_ROWS, ERASE_ROWS_RANGE, sweepEraseMode, deleteOwingMerge, mergeOwed, mergeOwedStep, levelMergeStep, filterIndexMissing, CREATE_FILTER_INDEX, MERGE_PAGES, MERGE_PAGES_RANGE, searchIndexProgress, type SearchIndexStatus, BUILD_BATCH, unindexedRemain, indexInsertedTraces, bulkIndexDelete, indexCjk, indexCjkPending, CJK_PENDING_TABLE, SEARCH_DOCS_TABLE, type SearchIndexState, BUILD_STEP_MS, BUILD_BATCH_RANGE, enqueueTraces, indexQueued, queueWaiting, queuedUpTo, searchFilterIndexExists, dropSearchFilterIndex, QUEUE_TABLE } from './search-index.js';
import { parseSearch, searchRefusal, describeTerm, mayHoldCjk, type ParsedSearch, type TraceMatch } from './search.js';
import { installSearchFunctions, matchSearch, type MatchRequest, type MatchResult, type SearchPlan } from './search-match.js';
import { SearchWorkerClient, SearchWorkerUnavailable, warnSearchWorkerUnavailable } from './search-worker-client.js';
import { SqliteJudgeSpendLedger } from './judge-spend.js';
import { resolveTraceCost } from '../cost/trace-cost.js';

const ALLOWED_SORT_COLUMNS = new Set(['timestamp', 'latency_ms', 'cost_usd']);

/** Rows an export reads per statement; the bound on what one export holds in memory at once. */
export const EXPORT_BATCH = 250;

/**
 * The indexes a trace list reads, named (#711). A session or an agent is
 * the narrowest range, and each index is in time order; otherwise the page
 * walks the covering time index, which also holds latency and cost, so a
 * page sorted by either sorts index entries and reads 50 rows rather than
 * every row (0.37 s at 100,000 traces when the planner took another
 * index). The count takes the smallest index that answers its filters.
 * The export walks the page's index too.
 */
function traceIndexes(filter: TraceQueryOptions['filter']): { countIndex: string; pageIndex: string } {
  const narrowest = filter?.session_id !== undefined ? 'idx_traces_tenant_session' : filter?.agent_name ? 'idx_traces_tenant_agent_timestamp' : undefined;
  return {
    countIndex: narrowest ?? (filter?.since || filter?.until ? 'idx_traces_tenant_timestamp_cover' : 'idx_traces_tenant_framework'),
    pageIndex: narrowest ?? 'idx_traces_tenant_timestamp_cover',
  };
}

/** An id list read in one statement, handed out `size` at a time. */
function* chunks(ids: readonly string[], size: number): Generator<string[]> {
  for (let i = 0; i < ids.length; i += size) yield ids.slice(i, i + size);
}

/**
 * Stored rule results, read back in one shape. Every reader sorts or groups
 * by `ruleName`, so a single stored result without one stopped the server at
 * startup (the local-label refresh sorts rule names). A result written with
 * `rule` instead of `ruleName` — the shape of hand-seeded or externally
 * written rows; no release writes it — is read under `rule`; a result with
 * neither is dropped; a value that is not a JSON list reads as no results.
 * Missing `message` and `score` read as '' and 0, so the result still fits
 * the published response schema.
 */
export function parseRuleResults<T = EvalRuleResult>(raw: unknown): T[] {
  if (raw === null || raw === undefined || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: T[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const ruleName = typeof r.ruleName === 'string' ? r.ruleName : typeof r.rule === 'string' ? r.rule : undefined;
    if (ruleName === undefined) continue;
    out.push({ message: '', score: 0, ...r, ruleName } as T);
  }
  return out;
}
const ALLOWED_SORT_ORDERS = new Set(['asc', 'desc']);

/**
 * Defense-in-depth runtime check. The TypeScript brand prevents most
 * misuse at compile time; this catches any dynamic cast bypass.
 */
function assertTenant(tenantId: TenantId): void {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TenantContextRequiredError(
      'SqliteAdapter method invoked without a valid TenantId; refusing to query',
    );
  }
}

export type RedactMode = 'none' | 'critical_spans';
export interface SqliteAdapterOptions {
  /** storage.redact — replace the spans a critical detector flagged in the stored text. */
  redact?: RedactMode;
  /** Force a driver (tests, the self-test); unset reads IRIS_SQLITE_DRIVER, then native with the fallback. */
  driver?: 'native' | 'node';
  /** Tests only: false behaves as a SQLite built without FTS5, so the search fallback can be exercised on a build that has it. */
  fts5?: boolean;
  /**
   * Where the store's own lines go: the search index build starting and
   * finishing, and anything that stopped it. The server passes its logger;
   * unset, `info` lines are dropped and `warn` lines go to stderr.
   */
  log?: (level: 'info' | 'warn', line: string) => void;
  /** storage.searchBudgetMs — how long one search may read before it answers with what it found (default SEARCH_BUDGET_MS). */
  searchBudgetMs?: number;
  /** false runs every search on this connection, on the caller's thread (the benchmark's comparison); default: on a worker thread, for a store in a file. */
  searchWorker?: boolean;
  /** Tests only: the module the search worker runs, to make it fail to start. */
  searchWorkerEntry?: URL;
  /** storage.synchronous — when a commit reaches the disk; see initialize(). Default `normal`. */
  synchronous?: SynchronousMode;
  /**
   * storage.searchIndex — `off` keeps no full-text index: a write stores the
   * trace and nothing more, and a search reads the traces within its budget
   * (search-match.ts, the scan). An index kept before is erased after the
   * start; `on` again builds a new one. Default `on`.
   */
  searchIndex?: 'on' | 'off';
  /** Copy the file before applying a migration to it (default true; backup.ts). */
  backup?: boolean;
  /**
   * Tests only: the log sizes, in pages, at which this connection checkpoints
   * while the worker runs (default TAIL_CHECKPOINT_PAGES) and a background
   * step has the worker empty the log (default STEP_TRUNCATE_PAGES), so a test
   * can prove what they do on a smaller log.
   */
  checkpointPages?: { tail: number; stepTruncate: number };
  /**
   * On a file with migrations pending, let initialize() return before the
   * copy and the migrations, which then run on the checkpoint worker's
   * connection; whenReady() resolves when they are done (default false:
   * initialize() returns with the file migrated). The server sets it, so
   * it answers its client while a large file is copied and migrated.
   */
  upgradeAfterStart?: boolean;
}

/** Where a store is on its way to serving: whenReady() resolves at `ready`. */
export interface StoreReadiness {
  state: 'opening' | 'copying' | 'migrating' | 'ready' | 'failed';
  /** When it entered this state (epoch ms). */
  since: number;
  /** For `failed`, the reason. */
  detail?: string;
}

/** What a start that migrated an existing file did: the storage layer's half of #704. */
export interface UpgradeReport {
  dbPath: string;
  /** The release that last migrated the file, when one was recorded. */
  from: string | null;
  /** This release. */
  to: string;
  /** The migrations this start applied. */
  applied: string[];
  /** The oldest release that could open the file before, and can now. */
  floorBefore: string | null;
  floorAfter: string | null;
  /** The copy taken first, or why there is none. */
  backup: BackupResult;
}
export type SynchronousMode = 'normal' | 'full';

/**
 * How long one search may read matches, in milliseconds, before it stops
 * and answers with what it found (`search.complete: false`). A search runs
 * on the event loop, and every MCP and HTTP request waits while it does, so
 * this is also the longest a search can hold them (#703). At 100,000
 * traces on the machine in the changelog, a word in every trace takes about
 * a quarter of it, and the costliest query the limits allow about 600 ms.
 */
export const SEARCH_BUDGET_MS = 1000;

/**
 * The queue indexer's timing (#729; scheduleIndexing). Queued traces are
 * indexed once writes pause for INDEX_IDLE_MS, and not before: a search
 * indexes the queue itself before it reads the index, so how soon a trace
 * is indexed changes no answer, and a step run between two writes of a
 * stream holds the second one for the step. When the queue reaches
 * INDEX_BACKLOG_TRACES, the indexer starts during the stream, and a write
 * that finds more than that queued indexes some of it before it returns
 * (holdBackForIndex), so the queue a search indexes first never holds more.
 */
export const INDEX_IDLE_MS = 25;
export const INDEX_BACKLOG_TRACES = 1000;
/**
 * A batch of at least this many traces (an OTLP request, `iris-eval
 * ingest`) is indexed in the transaction that stores it, as before #729:
 * it is already a batch, and its index write costs no more there (128 µs a
 * trace in batches of 100, 95 µs in batches of 1,000, against 558 µs one
 * at a time). Queueing it too cost 5% of OTLP ingest and made the search
 * after a burst wait for the queue. Smaller batches are queued.
 */
export const INDEX_INLINE_MIN = 100;

/** How often a delete's checkpoint is tried again while a reader holds it off (eraseFromFile). */
const ERASE_RETRY_MS = 20;
/** How long a delete waits for its erasure on the checkpoint worker, off the event loop, before it leaves it to the retry (eraseFromFile). */
const ERASE_WAIT_MS = 250;

/** The retention sweep's step, in traces: from one, because erasing one trace row by row can take 120 ms by itself. */
const SWEEP_BATCH = 1;
const SWEEP_BATCH_RANGE = [1, 1024] as const;
/** The evaluation sweep's step, in rows. */
const EVAL_SWEEP_BATCH = 256;
const EVAL_SWEEP_BATCH_RANGE = [64, 16_384] as const;

/** Give the event loop a turn: requests that arrived during a step are answered before the next. */
const yieldToRequests = () => new Promise<void>((resolve) => setImmediate(resolve));
/** What every text field of an erased evaluation reads afterwards. */
export const ERASED_MESSAGE = 'erased with the trace';

/**
 * A run as a reader sees it.
 *
 * Almost every field here is DERIVED from the rows in the run rather than
 * read out of the `runs` table, and that is deliberate. Two sources for one
 * fact is how a registry starts disagreeing with the data it describes: a
 * stored `n` drifts the moment a trace is deleted, and a stored
 * `rulesetHash` is wrong the moment one trace in the run is re-evaluated.
 * The registry therefore stores only what CANNOT be derived — the caller's
 * own label, and the fact that a run was produced by re-evaluating another
 * one — and everything countable is counted at read time.
 */
export interface RunSummaryRow {
  runId: string;
  /** The caller's name for this batch; null when it was never registered. */
  label: string | null;
  /** Set when this run came from re-evaluating another, so a rules change is never read as an agent change. */
  reevaluationOf: string | null;
  traces: number;
  evaluated: number;
  passed: number;
  agentNames: string[];
  engineVersions: string[];
  rulesetHashes: string[];
  startedAt: string | null;
  lastActivityAt: string | null;
  /** Pinned as the baseline every later run is compared against; at most one per tenant. */
  baseline: boolean;
}

/** One trace's latest evaluation inside a run — the unit a comparison counts. */
/** One case in a dataset: the key, and the answer the reader expects (carried, not yet read by any statistic). */
export interface DatasetCase {
  caseKey: string;
  expected: unknown | null;
}

export interface DatasetSummary {
  id: string;
  label: string;
  version: number;
  createdAt: string;
  /** How many case keys the dataset holds. */
  cases: number;
}

export interface DatasetDetail extends DatasetSummary {
  caseKeys: DatasetCase[];
}

/** Labels are unique per tenant; the route answers 409 with this sentence. */
export class DatasetExistsError extends Error {
  readonly status = 409;
  constructor(label: string) {
    super(`A dataset labelled "${label}" already exists; labels are unique. Read it at GET /api/v1/datasets/${encodeURIComponent(label)}, or choose another label.`);
    this.name = 'DatasetExistsError';
  }
}

export interface RunResultRow {
  evalId: string;
  traceId: string | null;
  /** What makes this the same question as a row in another run; null when nothing supplied or derived one. */
  caseKey: string | null;
  agentName: string | null;
  passed: boolean;
  /** Rules that fired, for the per-rule breakdown. Skips are not failures. */
  failedRules: string[];
  engineVersion: string | null;
  rulesetHash: string | null;
  configHash: string | null;
  createdAt: string;
  /** How many older evaluations of these traces were collapsed away. */
  supersededInRun?: number;
}

/** One attempt at one case — every attempt, because repetition is what is being measured. */
export interface CaseResultRow {
  evalId: string;
  traceId: string | null;
  caseKey: string | null;
  /** The conversation the trace belongs to; null when it carried none. */
  sessionId: string | null;
  runId: string | null;
  passed: boolean;
  createdAt: string;
}

/** One row of an agent's evaluated history, as agentLogRows reads it. */
interface AgentLogRow {
  rule_results: string | null;
  run_id: string | null;
  trace_id: string;
  timestamp: string;
  cost_usd: number | null;
}

/** The native driver's name — the default, and what the proof was measured on. */
export const SQLITE_DRIVER: DriverName = 'better-sqlite3';

/** The composer facts a stored evaluation is read back under (rowToEvalResult says why), so the write can store its risk estimate under the same. */
function composeConfigOf(provenance: Provenance): ComposeConfig {
  const composer = provenance.composer;
  return { ...DEFAULT_COMPOSE, ...(composer ?? {}), calibration: composer?.calibration ?? null };
}

/**
 * The risk fill's step, in evaluations, sized like the other background
 * steps (search-index.ts, nextStepSize) and timed with its commit: the
 * commit rewrites every row the step touched and took about as long as the
 * estimates. A fill that stopped at STEP_TARGET_MS of estimates, before the
 * commit, held the event loop 47 ms at the median and 79 ms at the most
 * (20,000 evaluations from 0.19.0).
 */
const RISK_FILL_ROWS = 32;
const RISK_FILL_ROWS_RANGE = [8, 2048] as const;
/** A fill this large starts the checkpoint worker and waits for it first (fillRiskEstimates). */
const RISK_FILL_WORKER_ROWS = 2048;
/**
 * The two risk columns for an evaluation (migration 018): the estimate and
 * its key as JSON, and this build's key version. An evaluation without
 * provenance is never composed on read, and one with no detector to
 * estimate from has nothing to store: both store no estimate and are
 * marked as done, so the background fill does not visit them again.
 */
/**
 * The rows the background fill has still to visit: no version, or another
 * build's. Three queries rather than one with OR: SQLite answers an OR over
 * one index by collecting every matching rowid before the LIMIT applies,
 * which made each step cost as much as the whole backlog. Each of these is
 * one range of idx_eval_results_risk_version, read only as far as the LIMIT.
 */
export const RISK_FILL_QUERIES = [
  // Named: with statistics, SQLite read every evaluation for `IS NULL` instead, at every start (query-plans.test.ts).
  'SELECT rowid AS rid, * FROM eval_results INDEXED BY idx_eval_results_risk_version WHERE risk_version IS NULL LIMIT ?',
  'SELECT rowid AS rid, * FROM eval_results INDEXED BY idx_eval_results_risk_version WHERE risk_version < ? LIMIT ?',
  'SELECT rowid AS rid, * FROM eval_results INDEXED BY idx_eval_results_risk_version WHERE risk_version > ? LIMIT ?',
] as const;
function riskColumns(result: EvalResult): [string | null, string | null] {
  if (!result.provenance) return [null, RISK_KEY_VERSION];
  const cfg = composeConfigOf(result.provenance);
  const stored = storedRiskEstimate(result, cfg.prior, cfg.priorMode);
  return [stored ? JSON.stringify(stored) : null, RISK_KEY_VERSION];
}

/** The one stderr line a start that migrated an existing file prints. */
export function upgradeLine(r: UpgradeReport): string {
  const lockedOut = r.floorAfter !== null && r.floorAfter !== r.floorBefore ? ` Iris releases before ${r.floorAfter} cannot open it now.` : '';
  const copy = r.backup.taken
    ? ` The file as it was is at ${r.backup.path}; to go back, see ${DOWNGRADING_URL}.`
    : ` No copy was taken first: ${r.backup.reason}. To keep one, stop every Iris process and copy the file before the next upgrade.`;
  return `[iris.storage] Upgraded ${r.dbPath} for Iris ${r.to} (${r.applied.join(', ')}).${lockedOut}${copy}`;
}

export class SqliteAdapter implements IStorageAdapter {
  /** After-insert listeners for evaluations; see IStorageAdapter.onEvalResultInserted. */
  private readonly evalListeners = new Set<(tenantId: TenantId, result: EvalResult) => void>();

  onEvalResultInserted(listener: (tenantId: TenantId, result: EvalResult) => void): () => void {
    this.evalListeners.add(listener);
    return () => {
      this.evalListeners.delete(listener);
    };
  }

  /** Which driver holds the file: `better-sqlite3`, or `node` when the built-in was chosen or fallen back to. */
  get driver(): DriverName {
    return this.db.name;
  }

  /** Why that driver holds the file: the default, a deployment's choice, or the fallback and its cause. */
  get driverReason(): string {
    return this.db.reason;
  }
  private db: Driver;
  private readonly dbPath: string;

  /** storage.redact — see SqliteAdapterOptions. */
  private readonly redact: RedactMode;
  /** storage.synchronous — see SqliteAdapterOptions. */
  private readonly synchronous: SynchronousMode;

  /** Whether searches use the FTS5 index or read the traces; settled in initialize(). */
  private searchIndex: SearchIndexState = 'unavailable';
  private readonly searchIndexWanted: boolean;
  /** The background build of the search index, while one runs; see buildSearchIndex. */
  private searchBuild: Promise<SearchIndexState> | undefined;
  /** The indexes the hot reads name, being built after the start, while they are (buildReadPaths), and whether all of them exist. */
  private readPaths: Promise<void> | undefined;
  private readPathsReady = false;
  /** The covering index being built after the start, while it is; see createFilterIndex. */
  private filterIndex: Promise<void> | undefined;
  private riskFill: Promise<void> | undefined;
  /** The merge a sweep owes, while one runs; see settleOwedMerge. */
  private merging: Promise<void> | undefined;
  /** Retention sweeps in progress: close() waits for each to stop at its next step. */
  private readonly sweeps = new Set<Promise<unknown>>();
  /** The worker thread that checkpoints the WAL off the event loop (checkpointer.ts); none for a database in memory. */
  private checkpointer: Checkpointer | undefined;
  private closing = false;
  private markClosing: () => void = () => undefined;
  /** Resolves when close() begins: a wait that must not hold a close up races it. Declared after markClosing, whose initializer would otherwise replace the resolver. */
  private readonly closingNow: Promise<void> = new Promise((resolve) => (this.markClosing = resolve));
  /** The queue indexer (#729; scheduleIndexing): its idle timer, the drain running, its last step (indexStep), and the traces this process queued since the queue was last empty. */
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  private indexing: Promise<void> | undefined;
  private indexSteps: Promise<unknown> = Promise.resolve();
  private indexBatch = BUILD_BATCH;
  private queuedSinceDrain = 0;
  private readonly fts5Override: boolean | undefined;
  /** SqliteAdapterOptions.checkpointPages, or the defaults. */
  private readonly tailCheckpointPages: number;
  private readonly stepTruncatePages: number;
  private readonly log: (level: 'info' | 'warn', line: string) => void;
  /** storage.searchBudgetMs — see SEARCH_BUDGET_MS. */
  private readonly searchBudgetMs: number;
  /** Whether searches run on a worker thread (SqliteAdapterOptions.searchWorker); the client once one has started. */
  private readonly searchOnWorker: boolean;
  private searchWorker: SearchWorkerClient | undefined;
  private readonly searchWorkerEntry: URL | undefined;
  /** Why the search worker could not start, once it has not: searches then stay on this thread. */
  private searchWorkerFailure: string | undefined;
  /** A delete's checkpoint waiting for a reader (eraseFromFile). */
  private eraseRetry: NodeJS.Timeout | undefined;
  private readonly backupFirst: boolean;
  private readonly upgradeAfterStart: boolean;
  private upgrade: UpgradeReport | undefined;
  /** Resolves once the store serves: with initialize(), or when the upgrade after the start is done (upgradeAfterStart). */
  private ready: Promise<void> = Promise.resolve();
  private readyState: StoreReadiness = { state: 'opening', since: Date.now() };
  /** The highest traces rowid known to be in the search index; see catchUpOtherWriters. */
  private indexedThrough = 0;

  constructor(dbPath: string, options?: SqliteAdapterOptions) {
    this.dbPath = dbPath;
    this.redact = options?.redact ?? 'none';
    this.synchronous = options?.synchronous ?? 'normal';
    this.fts5Override = options?.fts5;
    this.tailCheckpointPages = options?.checkpointPages?.tail ?? TAIL_CHECKPOINT_PAGES;
    this.stepTruncatePages = options?.checkpointPages?.stepTruncate ?? STEP_TRUNCATE_PAGES;
    this.searchIndexWanted = options?.searchIndex !== 'off';
    this.log = options?.log ?? ((level, line) => (level === 'warn' ? process.stderr.write(`[iris.storage] ${line}\n`) : undefined));
    this.searchBudgetMs = options?.searchBudgetMs ?? SEARCH_BUDGET_MS;
    this.backupFirst = options?.backup ?? true;
    this.upgradeAfterStart = options?.upgradeAfterStart ?? false;
    /*
     * The busy wait belongs to the CONNECTION, not to a pragma run after
     * the first statement. `PRAGMA journal_mode = WAL` on a cold file takes
     * an exclusive lock for the switch, and until 0.14.0 `busy_timeout` was
     * set only after it — so two processes opening one cold file at the
     * same instant (the CLI ingest race test, on a loaded CI runner) had
     * the second one fail on that very first pragma with SQLITE_BUSY and no
     * wait at all. The migration race was closed in 0.13.0 with
     * BEGIN IMMEDIATE; the statement before it was never covered.
     */
    this.db = openDriver(dbPath, { timeout: BUSY_TIMEOUT_MS, ...(options?.driver ? { driver: options.driver } : {}) });
    installSearchFunctions(this.db);
    // A store in memory has no file a second connection could open: it searches on this one.
    this.searchOnWorker = (options?.searchWorker ?? true) && dbPath !== ':memory:';
    this.searchWorkerEntry = options?.searchWorkerEntry;
  }

  /** What this start's migration did to an existing file; undefined when it applied nothing to one. */
  upgradeReport(): UpgradeReport | undefined {
    return this.upgrade;
  }

  /**
   * Resolves once the store serves: when initialize() does, or, for an
   * upgrade after the start, once the copy, the migrations and the search
   * index's reconcile are done. Rejects with the reason the upgrade failed.
   */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Where the store is on its way to serving (StoreReadiness). */
  readiness(): StoreReadiness {
    return this.readyState;
  }

  /** Applied against known — the health contract's `checks.migrations`. */
  async migrations(): Promise<MigrationState> {
    return migrationState(this.db);
  }

  private spendLedger: SqliteJudgeSpendLedger | undefined;

  /** The relevance judge's spend ledger on this connection (migration 017). */
  judgeSpendLedger(): SqliteJudgeSpendLedger {
    this.spendLedger ??= new SqliteJudgeSpendLedger(this.db);
    return this.spendLedger;
  }

  /**
   * `PRAGMA journal_mode = WAL` on a cold file upgrades the connection's
   * SHARED lock to EXCLUSIVE, and SQLite does not run the busy handler on
   * that upgrade — two connections each holding SHARED and each waiting
   * for the other to let go would never return — so it answers
   * SQLITE_BUSY at once. Two processes opening one cold file at the same
   * instant therefore still lost one of them on this statement, whatever
   * `busy_timeout` said: the 0.14.0 fix (the timeout set before the
   * switch, see the constructor) covers a plain wait, never this upgrade.
   * Found by a CI run on the Node 22 built-in driver (0.16.0). The
   * wait is done here instead: retry on BUSY with a short backoff inside
   * the same budget. Once either process is through, the file is WAL and
   * the pragma is a read. An error that is not BUSY is thrown as it came.
   */
  private async switchToWal(): Promise<void> {
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
      try {
        this.db.pragma('journal_mode = WAL');
        return;
      } catch (err) {
        if (!isBusyError(err) || Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async initialize(): Promise<void> {
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    try {
      // A file a newer release migrated past this one is refused before anything here writes to it, the journal-mode switch included.
      assertCompatible(inspectMigrations(this.db));
      await this.switchToWal();
    } catch (err) {
      // The same rule as a refused migration below: a failed boot must not leak the handle.
      this.db.close();
      throw err;
    }
    this.db.pragma('foreign_keys = ON');
    /*
     * When a commit reaches the disk (storage.synchronous, #711). FULL
     * syncs the write-ahead log on every commit: about 1.5 ms a write,
     * most of what a stored trace costs. NORMAL, SQLite's own guidance for
     * a write-ahead log, syncs it at each checkpoint instead. Neither can
     * corrupt the file, and a crash of Iris loses nothing under either;
     * what NORMAL gives up is the writes since the last sync on a power cut
     * or an operating-system crash, which roll back. `full` keeps every
     * commit through both.
     *
     * Until 0.20.0 nothing here set it, and what a store got depended on
     * the driver and the start: better-sqlite3's SQLite is built with
     * SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so it opened a file that was
     * already WAL at NORMAL (every start but the one that created the
     * file), while node:sqlite ran FULL throughout. Now both run what the
     * config says, NORMAL unless it says `full`.
     */
    this.db.pragma(`synchronous = ${this.synchronous === 'full' ? 'FULL' : 'NORMAL'}`);
    /*
     * secure_delete overwrites freed content with zeros instead of leaving
     * it in place until the page is reused. Without it, a DELETE — the
     * retention sweep, delete_trace, --purge — removed the row from every
     * query while the text stayed byte-for-byte readable in the file with
     * `strings iris.db`. Deletes are rare here (startup sweep, explicit
     * deletes), so the write cost is negligible; the privacy cost of the
     * alternative is the whole point of #372.
     */
    this.db.pragma('secure_delete = ON');
    if (this.fts5Override !== undefined) assumeFts5(this.db, this.fts5Override);
    /*
     * iris.db holds agent inputs and outputs verbatim, and a tool that
     * detects PII necessarily stores the PII it found. better-sqlite3
     * creates the file with the process umask (typically 0644 = readable by
     * every local account), and WAL mode creates two sidecars that hold the
     * same data. Narrow all three after the pragmas, since -wal/-shm do not
     * exist until WAL is enabled. No-op on Windows and on :memory:.
     */
    if (this.dbPath !== ':memory:') {
      ensureOwnerOnly(this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`);
    }
    /*
     * A file that already holds data and has migrations pending is copied
     * first (backup.ts): a migration cannot be undone, and the release
     * before it may not open the file afterwards. The compatibility check
     * comes before the copy, so a file this release refuses is left alone.
     */
    const plan = inspectMigrations(this.db);
    const upgrading = plan.pending.length > 0 && plan.applied.length > 0 && this.dbPath !== ':memory:';
    if (upgrading && this.upgradeAfterStart) {
      this.ready = this.upgradeInBackground(plan);
      // Read through whenReady(); a rejection nobody has asked about yet is not an unhandled one.
      this.ready.catch(() => undefined);
      return;
    }
    try {
      const backup: BackupResult = upgrading && this.backupFirst ? backupDatabase(this.db, this.dbPath, { from: plan.lastWriter, to: PKG_VERSION }) : { taken: false, reason: 'copies are turned off for this store' };
      runMigrations(this.db);
      if (upgrading) this.recordUpgrade(plan, backup);
      this.reconcile();
    } catch (err) {
      // A refused boot (a failed migration) must not leak the handle.
      this.db.close();
      throw err;
    }
    this.startBackgroundWork();
  }

  /**
   * The copy and the migrations after the start (upgradeAfterStart), on the
   * checkpoint worker's connection, so neither holds the event loop: VACUUM
   * INTO alone takes 2.4 to 2.7 s at 100,000 agent-loop traces. The copy is
   * finished before the first migration writes, and nothing else writes
   * meanwhile: the store's own background work starts after, and the server
   * holds requests until whenReady(). Without a worker, the adapter's
   * connection does both, as initialize() does.
   */
  private async upgradeInBackground(plan: MigrationPlan): Promise<void> {
    const at = (state: StoreReadiness['state'], detail?: string) => (this.readyState = { state, since: Date.now(), ...(detail !== undefined ? { detail } : {}) });
    try {
      this.ensureCheckpointer();
      const worker = this.checkpointer;
      const onWorker = worker !== undefined && (await worker.whenStarted()) && worker.active;
      at('copying');
      const options = { from: plan.lastWriter, to: PKG_VERSION };
      const backup: BackupResult = !this.backupFirst
        ? { taken: false, reason: 'copies are turned off for this store' }
        : onWorker
          ? await backupDatabaseWith(this.db, this.dbPath, options, (sql) => worker.exec(sql))
          : backupDatabase(this.db, this.dbPath, options);
      if (this.closing) throw new Error('the store was closed before its upgrade ran');
      at('migrating');
      if (onWorker) {
        try {
          await worker.migrate();
        } catch (err) {
          // A migration that failed fails here as it would at the start; a worker that stopped mid-way leaves the rest to this connection.
          if (worker.active) throw err;
          runMigrations(this.db);
        }
      } else {
        runMigrations(this.db);
      }
      this.recordUpgrade(plan, backup);
      this.reconcile();
      this.startBackgroundWork();
    } catch (err) {
      at('failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private recordUpgrade(plan: MigrationPlan, backup: BackupResult): void {
    this.upgrade = { dbPath: this.dbPath, from: plan.lastWriter, to: PKG_VERSION, applied: plan.pending, floorBefore: plan.floor, floorAfter: plan.floorAfter, backup };
    process.stderr.write(`${upgradeLine(this.upgrade)}\n`);
  }

  /** After the migrations, every start: build, repair or stand down the search index (search-index.ts). The store serves from here. */
  private reconcile(): void {
    this.searchIndex = reconcileSearchIndex(this.db, fts5Available(this.db), this.searchIndexWanted);
    if (this.searchIndex === 'ready') this.indexedThrough = this.maxTraceRowid();
    this.readyState = { state: 'ready', since: Date.now() };
  }

  /** The work that runs behind the start, once the file is migrated and reconciled. */
  private startBackgroundWork(): void {
    // The covering index a search's filters read (search-index.ts, CREATE_FILTER_INDEX): at once on a store with no traces, where there is nothing to read; after the start on one with traces.
    if (this.searchIndex !== 'unavailable' && filterIndexMissing(this.db)) {
      if (this.db.prepare('SELECT 1 FROM traces LIMIT 1').get() === undefined) this.db.exec(CREATE_FILTER_INDEX);
      else this.filterIndex = this.createFilterIndex();
    }
    // The indexes the hot reads name (read-paths.ts): built by migration 019 on a store with no traces, after the start on one with traces.
    const missing = readPathsMissing(this.db);
    this.readPathsReady = missing.length === 0;
    if (!this.readPathsReady) this.readPaths = this.buildReadPaths(missing.map((i) => i.sql));
    // Traces stored before the index existed are indexed after the start, not during it.
    if (this.searchIndex === 'building') this.searchBuild = this.buildSearchIndex();
    // Evaluations with no stored risk estimate (written before migration 018, or by an older corpus) get one, behind the start.
    this.riskFill = this.fillRiskEstimates();
    // Turned off: the index this file kept is erased after the start, in steps.
    if (this.searchIndex === 'off' && (retiredRemain(this.db) || searchFilterIndexExists(this.db))) this.searchBuild = this.eraseIndexTurnedOff();
    // A merge a sweep owed when the last server closed: carried on after the start, too.
    if (this.indexKept && mergeOwed(this.db)) void this.settleOwedMerge();
    // Traces an earlier run, or another process, queued and never indexed.
    if (this.indexKept && queueWaiting(this.db)) this.scheduleIndexing(0, true);
  }

  /**
   * Move WAL checkpoints to a worker thread, at the store's first write
   * (checkpointer.ts); until it is ready, and if it fails, this connection
   * checkpoints as before. A thread that stopped after it was ready is
   * replaced; one that could not start is not tried again.
   */
  private ensureCheckpointer(): void {
    if (this.dbPath === ':memory:' || this.closing) return;
    const stopped = this.checkpointer?.stopped;
    if (stopped === 'no' || stopped === 'before-ready') return;
    try {
      this.checkpointer = new Checkpointer({
        path: this.dbPath,
        driver: this.db.name,
        busyMs: BUSY_TIMEOUT_MS,
        onReady: () => {
          if (!this.closing) this.db.pragma(`wal_autocheckpoint = ${this.tailCheckpointPages}`);
        },
        onFailed: (reason) => {
          if (this.closing) return;
          this.db.pragma(`wal_autocheckpoint = ${AUTOCHECKPOINT_PAGES}`);
          this.log('warn', `WAL checkpoints run on the server's own connection again (${reason}); a write that triggers one waits for it.`);
        },
      });
    } catch (err) {
      this.log('warn', `WAL checkpoints stay on the server's own connection (the checkpoint worker did not start: ${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  async close(): Promise<void> {
    // Background work in progress stops at its next step; each is resumable, and the next start carries on.
    this.closing = true;
    this.markClosing();
    // An upgrade after the start runs to the end of the step it is in: a copy is not followed by the migrations, and a migration is never cut off.
    await this.ready.catch(() => undefined);
    await Promise.all([this.filterIndex, this.readPaths, this.searchBuild, this.merging, this.riskFill, ...this.sweeps]);
    /*
     * The indexer stops at its next step, and what this process queued is
     * indexed now: a short-lived process (iris-eval ingest) leaves nothing
     * on the queue for a server to find. What cannot be indexed now waits
     * for the next start.
     */
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = undefined;
    await this.indexing;
    if (this.indexKept) {
      try {
        while (indexQueued(this.db, BUILD_BATCH_RANGE[1]) !== null);
      } catch {
        // The next start's indexer takes it.
      }
    }
    // The search thread closes its own connection before this one closes.
    await this.searchWorker?.close();
    this.searchWorker = undefined;
    // A delete still waiting for a reader to finish (eraseFromFile): nothing of this process reads now.
    if (this.eraseRetry) {
      clearInterval(this.eraseRetry);
      this.eraseRetry = undefined;
      await this.truncateCheckpointNow();
    }
    await this.checkpointer?.close();
    this.db.close();
  }

  /**
   * Choose a search's page: on the search worker when this store has one
   * (search-worker-client.ts), else on this connection. A worker that
   * could not start (its thread failed before it could open the file) is
   * no reason to fail the search: it runs here, and the next search tries
   * a worker again.
   */
  private async match(request: MatchRequest): Promise<MatchResult> {
    if (!this.searchOnWorker || this.closing || this.searchWorkerFailure !== undefined) return matchSearch(this.db, request);
    // The driver this connection ended up with, never the one asked for: a machine that fell back to node:sqlite here would fail to open the native one there.
    this.searchWorker ??= new SearchWorkerClient({ path: this.dbPath, driver: this.db.name === 'node' ? 'node' : 'native', busyTimeoutMs: BUSY_TIMEOUT_MS }, undefined, this.searchWorkerEntry);
    try {
      return await this.searchWorker.search(request);
    } catch (err) {
      if (!(err instanceof SearchWorkerUnavailable)) throw err;
      // It will not start on this machine: say so once, and search here from now on.
      this.searchWorkerFailure = err.reason;
      const client = this.searchWorker;
      this.searchWorker = undefined;
      void client.close();
      warnSearchWorkerUnavailable(err.reason);
      return matchSearch(this.db, request);
    }
  }

  /** Where this store's searches run (SearchWorkerStatus): for the health contract and the self-test. */
  searchWorkerStatus(): SearchWorkerStatus {
    if (!this.searchOnWorker) return { status: 'not_used', detail: 'not used: a store in memory searches on the main thread' };
    if (this.searchWorkerFailure !== undefined) return { status: 'unavailable', detail: `unavailable (${this.searchWorkerFailure}), searches run on the main thread` };
    if (this.searchWorker?.isReady()) return { status: 'ready', detail: 'ready: searches run on their own thread' };
    return { status: 'not_started', detail: 'not started: it starts with the first search' };
  }

  /**
   * Resolves when the search index holds every trace (`ready`), or at once
   * with the state when there is nothing to build. Searches never wait for
   * it: until then they read the traces. For tests, the benchmark and any
   * caller that wants to know.
   */
  async whenSearchIndexReady(): Promise<SearchIndexState> {
    const state = await (this.searchBuild ?? Promise.resolve(this.searchIndex));
    if ((state === 'ready' || state === 'building') && !this.closing) {
      await this.indexing;
      await this.drainQueue(Infinity);
    }
    return this.searchIndex;
  }

  /**
   * Index what waits on the queue (#729), after the write that queued it
   * rather than inside it. A write only adds the trace's id to the queue;
   * this writes the index in steps, each under its own write lock and sized
   * to about BUILD_STEP_MS of work, with the event loop free between them.
   * It starts once writes pause for INDEX_IDLE_MS, so a burst of writes is
   * indexed in batches after it, and at once when this process has queued
   * INDEX_BACKLOG_TRACES, so the queue, and what a search has to index
   * before it reads the index, stays that small while writes never pause.
   */
  private scheduleIndexing(queued: number, now = false): void {
    if (this.closing) return;
    this.queuedSinceDrain += queued;
    if (this.indexing) return;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    const start = () => {
      this.indexTimer = undefined;
      this.indexing = this.runIndexer().finally(() => {
        this.indexing = undefined;
      });
    };
    if (now || this.queuedSinceDrain >= INDEX_BACKLOG_TRACES) {
      start();
      return;
    }
    this.indexTimer = setTimeout(start, INDEX_IDLE_MS);
    this.indexTimer.unref?.();
  }

  private async runIndexer(): Promise<void> {
    try {
      // Each step's merges after it, as the build does, so writes that never pause never leave a level for FTS5's own crisis merge.
      while (!this.closing && (await this.indexStep()) !== null) await this.mergeIndexed();
    } catch (err) {
      // Another writer held the lock past busy_timeout, or the file failed: the queue keeps its traces, and the next write, search or start tries again.
      process.stderr.write(`[iris.storage] Indexing queued traces for search stopped (${err instanceof Error ? err.message : String(err)}); they stay queued, and searches index them first.\n`);
    }
  }

  /**
   * One step of the queue indexer (indexQueued), sized to about
   * BUILD_STEP_MS, on a turn of the event loop of its own after the step
   * before it, whoever asked for either: the indexer after writes pause, a
   * search draining the queue, a write held back. Requests run between any
   * two steps, so the event loop is never held longer than one step. The
   * traces it took off the queue, or null when none waited (or the store is
   * closing, whose close indexes the rest).
   */
  private indexStep(): Promise<number | null> {
    return this.indexerStep((): number | null => {
      if (this.closing) return null;
      const started = performance.now();
      const n = indexQueued(this.db, this.indexBatch);
      if (n === null) {
        this.queuedSinceDrain = 0;
        return null;
      }
      const took = performance.now() - started;
      this.indexBatch = nextBuildBatch(this.indexBatch, took);
      this.queuedSinceDrain = Math.max(0, this.queuedSinceDrain - n);
      return n;
    });
  }

  /**
   * Run `work` as the indexer's next step: on a turn of the event loop of
   * its own, after the step before it (indexStep), and never while the
   * checkpoint worker truncates the log, which holds the write lock (a
   * step started then would wait for it with the event loop held).
   */
  private indexerStep<T>(work: () => T): Promise<T> {
    const step = this.indexSteps.then(() => this.turnWithoutTruncate()).then(work);
    this.indexSteps = step.catch(() => undefined);
    return step;
  }

  /** A turn of the event loop of its own, where no TRUNCATE is in progress when it resolves: the work after it runs in that same turn. */
  private async turnWithoutTruncate(): Promise<void> {
    // The covering index built after the start holds the write lock while it is (createFilterIndex): a step waits for it, as the build's do.
    if (this.filterIndex) await this.filterIndex;
    await yieldToRequests();
    while (this.checkpointer?.truncateInProgress) {
      await this.checkpointer.whenTruncated();
      await yieldToRequests();
    }
  }

  /**
   * The merges the queue's steps owe (they write with automerge off,
   * indexQueued), as indexer steps of their own until no level needs one
   * (levelMergeStep). The indexer runs them; a search draining the queue
   * does not, and leaves them to the indexer after it.
   */
  private async mergeIndexed(): Promise<void> {
    while (!this.closing) {
      const written = await this.indexerStep((): number => {
        if (this.closing) return 0;
        const started = performance.now();
        const n = levelMergeStep(this.db, this.mergePages);
        if (n > 0) this.mergePages = nextStepSize(Math.min(this.mergePages, n), performance.now() - started, MERGE_PAGES_RANGE);
        return n;
      });
      if (written === 0) return;
    }
  }

  /**
   * Index the queue, in steps (indexStep), for up to `budgetMs`: what a
   * search does before it reads the index, so it misses no trace stored
   * before it began. `upTo` is the last trace rowid it must find; traces
   * stored while it drains are indexed by the indexer after it. Whether
   * everything up to there is indexed. The queue this process leaves holds
   * at most INDEX_BACKLOG_TRACES; more waits only when another process
   * queued traces and has not indexed them.
   */
  private async drainQueue(budgetMs: number, upTo = Infinity): Promise<boolean> {
    const deadline = performance.now() + budgetMs;
    const waiting = Number.isFinite(upTo) ? () => queuedUpTo(this.db, upTo) : () => queueWaiting(this.db);
    let stepped = false;
    while (waiting()) {
      if (this.closing || performance.now() >= deadline) return false;
      await this.indexStep();
      stepped = true;
    }
    // The merges those steps owe, after this search (mergeIndexed).
    if (stepped) this.scheduleIndexing(0, true);
    return true;
  }

  /** Resolves when no background work runs: the build, a merge a sweep owes, a sweep. For tests and the benchmark. */
  async whenIdle(): Promise<void> {
    while (this.filterIndex || this.readPaths || this.searchBuild || this.merging || this.riskFill || this.sweeps.size > 0) await Promise.all([this.filterIndex, this.readPaths, this.searchBuild, this.merging, this.riskFill, ...this.sweeps]);
  }

  /**
   * Where the search index is, for health and the self-test: its state,
   * what a search reads now, and how many of the stored traces it holds.
   * The traces are counted only while it is being built; ready, it holds
   * them all.
   */
  async searchStatus(): Promise<SearchIndexStatus> {
    return searchIndexProgress(this.db, this.searchIndex);
  }

  /**
   * Fill the search index from the traces already stored, after the start
   * rather than during it (search-index.ts, installSearchIndex, says why).
   * One step at a time, each under its own write lock and sized to
   * stay under BUILD_STEP_MS from the last step's work and time, yielding
   * to the event loop between steps so requests are answered while it runs. An index
   * retired at the start is erased first, in steps of the same size rule.
   * Another process writing the same file only makes a step wait
   * (busy_timeout); a step that still fails leaves the index building and
   * searches on the scan, and the next start tries again. It says when it
   * starts and when it is done, with the counts and the time.
   */
  private async buildSearchIndex(): Promise<SearchIndexState> {
    await yieldToRequests();
    this.ensureCheckpointer();
    const began = performance.now();
    try {
      const at = searchIndexProgress(this.db, 'building');
      const [total, indexed] = [at.total ?? 0, at.indexed ?? 0];
      const what =
        indexed < total
          ? `indexing ${(total - indexed).toLocaleString('en-US')} of ${total.toLocaleString('en-US')} stored trace(s)`
          : `indexing the Chinese, Japanese and Korean text of ${at.cjk_pending.toLocaleString('en-US')} trace(s)`;
      this.log('info', `Search index: ${at.retired ? 'erasing the previous index, then ' : ''}${what} in the background; until it is done, a search reads the traces (the same results, slower)`);
      // An index retired at the start is erased first (search-index.ts, retiring an index).
      // No write step while an index is built after the start: it holds the write lock, and a step would wait for it on the event loop.
      if (this.filterIndex || this.readPaths) await this.indexesAfterStart();
      await this.eraseRetiredIndex();
      let after = 0;
      let batch = BUILD_BATCH;
      while (!this.closing) {
        await this.beforeWriteStep();
        const started = performance.now();
        const last = indexNextBatch(this.db, after, batch);
        batch = nextBuildBatch(batch, performance.now() - started);
        // The merges that step's writes owe, in steps of their own (search-index.ts, merges out of the build's steps).
        await this.levelMerges();
        if (last === null) {
          // Every trace is in the index: stream the ones queued for CJK, in steps of the same size rule.
          let queued = BUILD_BATCH;
          while (!this.closing) {
            await this.beforeWriteStep();
            const began = performance.now();
            if (indexCjkPending(this.db, queued) === null) break;
            queued = nextBuildBatch(queued, performance.now() - began);
            await this.levelMerges();
            await yieldToRequests();
          }
          if (this.closing) break;
          // Past the end. A purge's VACUUM may have renumbered rowids behind the walk: check, and walk again if so.
          const through = this.maxTraceRowid();
          if (!unindexedRemain(this.db)) {
            this.indexedThrough = through;
            this.searchIndex = 'ready';
            const { total } = searchIndexProgress(this.db, 'building');
            this.log('info', `Search index ready: ${(total ?? 0).toLocaleString('en-US')} trace(s) indexed in ${((performance.now() - began) / 1000).toFixed(1)} s`);
            break;
          }
          after = 0;
        } else {
          after = last;
        }
        await yieldToRequests();
      }
    } catch (err) {
      this.log('warn', `Building the trace search index stopped (${err instanceof Error ? err.message : String(err)}); search reads the traces until the next start finishes it.`);
    } finally {
      this.searchBuild = undefined;
    }
    return this.searchIndex;
  }

  /**
   * Create the covering index a search's filters read (search-index.ts,
   * CREATE_FILTER_INDEX), after the start: on the checkpoint worker's
   * connection, so the event loop is free while it reads every trace row,
   * or on this one when the worker cannot run. It holds the write lock
   * meanwhile; the store's own background steps wait for it, and a write a
   * client sends in that moment waits for it too, as it would behind any
   * other writer. Runs even when the store is closing: close() waits for it.
   */
  private async createFilterIndex(): Promise<void> {
    await yieldToRequests();
    const began = performance.now();
    try {
      this.ensureCheckpointer();
      const worker = this.checkpointer;
      if (worker && (await worker.whenStarted()) && worker.active) {
        try {
          await worker.exec(CREATE_FILTER_INDEX);
        } catch {
          // Refused there (the write lock held past the busy timeout, or the worker stopped): here instead, after any TRUNCATE in flight (insertTraces says why).
          while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
          this.db.exec(CREATE_FILTER_INDEX);
        }
      } else {
        while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
        this.db.exec(CREATE_FILTER_INDEX);
      }
      this.log('info', `Search index: the covering index for search filters was built after the start, in ${((performance.now() - began) / 1000).toFixed(1)} s`);
    } catch (err) {
      this.log('warn', `Building the covering index for search filters failed (${err instanceof Error ? err.message : String(err)}); search works without it, more slowly, and the next start tries again.`);
    } finally {
      this.filterIndex = undefined;
    }
  }

  /**
   * Before a background write step: once the log holds STEP_TRUNCATE_PAGES,
   * have the checkpoint worker copy and empty it (TRUNCATE), and wait for
   * that here, off the event loop. Otherwise the adapter's own checkpoint
   * (TAIL_CHECKPOINT_PAGES) lands in one step's commit in every few that
   * rewrite many rows, and holds the event loop with it (checkpointer.ts).
   * Also waits out a TRUNCATE someone else started, which holds the write
   * lock while it runs: a step started meanwhile would wait for it in the
   * busy handler, on the event loop. Checked in the turn the step runs in,
   * after its yield: the erasure's retry (eraseFromFile) can start a
   * TRUNCATE between the two.
   */
  private async beforeWriteStep(): Promise<void> {
    const worker = this.checkpointer;
    if (worker?.active && !worker.truncateInProgress && worker.logBytes() >= this.stepTruncatePages * this.pageBytes()) void worker.truncate().catch(() => undefined);
    // Checked again after each yield: the erasure's retry can start a TRUNCATE while this waits, and the step must start in the turn that saw none.
    while (this.checkpointer?.truncateInProgress) {
      await this.checkpointer.whenTruncated();
      // The worker's answer arrives as an I/O event: a step run from it would run in the same turn of the event loop as the next one, back to back.
      await yieldToRequests();
    }
  }

  private pageSize: number | undefined;
  /** The file's page size, read once. */
  private pageBytes(): number {
    if (this.pageSize === undefined) {
      const out = this.db.pragma('page_size') as Array<{ page_size: number }> | { page_size: number };
      this.pageSize = Number((Array.isArray(out) ? out[0] : out).page_size);
    }
    return this.pageSize;
  }

  /**
   * Build the indexes the hot reads name, after the start (read-paths.ts):
   * each on the checkpoint worker's connection, one statement at a time so
   * a write can go between them, or on this one when the worker cannot
   * run; then drop the ones they replace. Until all exist the reads run
   * without naming them (pinned). A build that fails leaves the reads so,
   * and the next start tries again. Runs even when the store is closing:
   * close() waits for it.
   */
  private async buildReadPaths(statements: readonly string[]): Promise<void> {
    await yieldToRequests();
    // One writer at a time: the covering index first, when it is being built too.
    if (this.filterIndex) await this.filterIndex;
    const began = performance.now();
    try {
      this.ensureCheckpointer();
      const worker = this.checkpointer;
      const onWorker = worker !== undefined && (await worker.whenStarted()) && worker.active;
      const run = async (sql: string) => {
        if (onWorker) {
          try {
            return await worker.exec(sql);
          } catch {
            // Refused there (the write lock held past the busy timeout, or the worker stopped): here instead.
          }
        }
        // After any TRUNCATE in flight (insertTraces says why).
        while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
        this.db.exec(sql);
      };
      for (const sql of statements) await run(sql);
      this.readPathsReady = true;
      await run(DROP_REPLACED);
      this.log('info', `Storage: the indexes the dashboard and the failure log read were built after the start, in ${((performance.now() - began) / 1000).toFixed(1)} s`);
    } catch (err) {
      this.log('warn', `Building the indexes the dashboard and the failure log read failed (${err instanceof Error ? err.message : String(err)}); those reads work without them, more slowly, and the next start tries again.`);
    } finally {
      this.readPaths = undefined;
    }
  }

  /** Resolves once no index is being built after the start: each holds the write lock while it is. */
  private async indexesAfterStart(): Promise<void> {
    await this.filterIndex;
    await this.readPaths;
  }

  /** Whether the indexes the hot reads name all exist, or are still being built after the start: for health and the self-test. */
  readIndexesState(): 'ready' | 'building' {
    return this.readPathsReady ? 'ready' : 'building';
  }

  /** `INDEXED BY name`, or nothing while that index is still being built after the start (read-paths.ts). */
  private pinned(name: string): string {
    return this.readPathsReady || !READ_PATH_INDEX_NAMES.has(name) ? `INDEXED BY ${name}` : '';
  }

  /** The build's merge-page budget, carried from one round of merges to the next. */
  private mergePages = MERGE_PAGES;

  /** Merge the levels the build's last step filled, in steps, until none needs it (levelMergeStep). */
  private async levelMerges(): Promise<void> {
    while (!this.closing) {
      await yieldToRequests();
      await this.beforeWriteStep();
      const started = performance.now();
      const written = levelMergeStep(this.db, this.mergePages);
      if (written === 0) return;
      this.mergePages = nextStepSize(Math.min(this.mergePages, written), performance.now() - started, MERGE_PAGES_RANGE);
    }
  }

  /**
   * Store a risk estimate for every evaluation that has none under this
   * build's key version (migration 018 says why it is stored), after the
   * start and never during it. The same steps as the index build: each
   * sized to about STEP_TARGET_MS under one write lock, its commit
   * included, yielding between them. A read never waits for it: an evaluation the
   * fill has not reached is computed on read, as before. A step that fails
   * stops the fill until the next start, which is only slower reads.
   */
  private async fillRiskEstimates(): Promise<void> {
    await yieldToRequests();
    // No write step while an index is built after the start: it holds the write lock, and a step would wait for it on the event loop.
    if (this.filterIndex || this.readPaths) await this.indexesAfterStart();
    try {
      // The rows still to fill, found through idx_eval_results_risk_version: once every row is filled, a start reads nothing.
      const [unversioned, below, above] = RISK_FILL_QUERIES.map((sql) => this.db.prepare(sql));
      const next = (limit: number): Array<Record<string, unknown>> => {
        for (const [query, params] of [[unversioned, [limit]], [below, [RISK_KEY_VERSION, limit]], [above, [RISK_KEY_VERSION, limit]]] as const) {
          const rows = query.all(...params) as Array<Record<string, unknown>>;
          if (rows.length > 0) return rows;
        }
        return [];
      };
      const store = this.db.prepare('UPDATE eval_results SET risk_estimate = ?, risk_version = ? WHERE rowid = ?');
      const step = this.db.transaction((max: number): number => {
        let written = 0;
        while (written < max) {
          const rows = next(max - written);
          if (rows.length === 0) break;
          for (const row of rows) {
            const [estimate, version] = riskColumns(this.rowToEvalResult(row));
            store.run(estimate, version, row.rid);
            written += 1;
          }
        }
        return written;
      });
      if (next(1).length === 0) return;
      /*
       * Its steps rewrite every row they fill: on a large backlog, without
       * the worker, this connection's own checkpoints land in them. So a
       * fill of RISK_FILL_WORKER_ROWS or more starts the worker and begins
       * once it is up (or could not start, or the store is closing). A small
       * one does neither: a start that has a few rows to fill and nothing to
       * write starts no thread, as before.
       */
      const backlog = RISK_FILL_QUERIES.reduce((n, sql, i) => {
        if (n >= RISK_FILL_WORKER_ROWS) return n;
        const count = `SELECT COUNT(*) AS n FROM (${sql.replace('SELECT rowid AS rid, *', 'SELECT 1')})`;
        const params = i === 0 ? [RISK_FILL_WORKER_ROWS] : [RISK_KEY_VERSION, RISK_FILL_WORKER_ROWS];
        return n + Number((this.db.prepare(count).get(...params) as { n: number }).n);
      }, 0);
      if (backlog >= RISK_FILL_WORKER_ROWS) {
        this.ensureCheckpointer();
        if (this.checkpointer) await Promise.race([this.checkpointer.whenStarted(), this.closingNow]);
        if (this.closing) return;
      }
      let rows = RISK_FILL_ROWS;
      while (!this.closing) {
        await this.beforeWriteStep();
        const started = performance.now();
        // IMMEDIATE: it reads the rows it rewrites, and the write lock is taken before that read.
        const written = step.immediate(rows);
        // Fewer than asked for: none are left.
        if (written < rows) break;
        rows = nextStepSize(written, performance.now() - started, RISK_FILL_ROWS_RANGE);
        await yieldToRequests();
      }
    } catch (err) {
      this.log('warn', `Storing risk estimates for older evaluations stopped (${err instanceof Error ? err.message : String(err)}); those evaluations compute theirs on read until the next start.`);
    } finally {
      this.riskFill = undefined;
    }
  }

  /** Resolves when the background fill of risk estimates has finished; for tests and the benchmark. */
  whenRiskEstimatesStored(): Promise<void> {
    return this.riskFill ?? Promise.resolve();
  }

  /** Whether this store keeps a search index: FTS5 here and storage.searchIndex on. */
  private get indexKept(): boolean {
    return this.searchIndex === 'ready' || this.searchIndex === 'building';
  }

  /** The index a store kept before storage.searchIndex was turned off, erased in steps after the start. */
  private async eraseIndexTurnedOff(): Promise<SearchIndexState> {
    await yieldToRequests();
    this.ensureCheckpointer();
    const began = performance.now();
    try {
      this.log('info', 'Search index: off (storage.searchIndex), so the index this database kept is being erased in the background; a search reads the traces');
      await this.eraseRetiredIndex();
      if (this.closing) return this.searchIndex;
      await yieldToRequests();
      dropSearchFilterIndex(this.db);
      this.log('info', `Search index erased in ${((performance.now() - began) / 1000).toFixed(1)} s`);
    } catch (err) {
      this.log('warn', `Erasing the search index stopped (${err instanceof Error ? err.message : String(err)}); the next start carries on.`);
    } finally {
      this.searchBuild = undefined;
    }
    return this.searchIndex;
  }

  /** Erase the index retired at the start, if there is one, in steps (search-index.ts, retiring an index). */
  private async eraseRetiredIndex(): Promise<void> {
    let rows = ERASE_ROWS;
    let oneStatement = false;
    while (!this.closing && retiredRemain(this.db)) {
      await this.beforeWriteStep();
      const started = performance.now();
      try {
        if (!eraseRetiredStep(this.db, rows, oneStatement)) return;
      } catch (err) {
        if (oneStatement || !isShadowWriteRefused(err)) throw err;
        this.log('warn', "This SQLite connection refuses writes to the search index's own tables, so the previous index is dropped in one statement; requests wait for it.");
        oneStatement = true;
        continue;
      }
      rows = nextStepSize(rows, performance.now() - started, ERASE_ROWS_RANGE);
      await yieldToRequests();
    }
  }

  /**
   * Run the merge a sweep owes to its end, in steps (search-index.ts, the
   * retention sweep). One at a time: a second caller waits for the one in
   * progress, which merges whatever is owed when each step runs.
   */
  private settleOwedMerge(): Promise<void> {
    this.merging ??= (async () => {
      await yieldToRequests();
      this.ensureCheckpointer();
      if (this.filterIndex || this.readPaths) await this.indexesAfterStart();
      try {
        let pages = MERGE_PAGES;
        while (!this.closing) {
          await this.beforeWriteStep();
          const started = performance.now();
          const { owed, written } = mergeOwedStep(this.db, pages);
          if (!owed) break;
          // Sized by what it did: its budget, or less when the merge finished early (the rows it wrote), never a budget it did not use.
          if (written > 0) pages = nextStepSize(Math.min(pages, written), performance.now() - started, MERGE_PAGES_RANGE);
          await yieldToRequests();
        }
      } catch (err) {
        this.log('warn', `Merging the search index after a retention sweep stopped (${err instanceof Error ? err.message : String(err)}); the next start carries it on. Until then the swept traces' words are still in the index's pages, though no search finds them.`);
      } finally {
        this.merging = undefined;
      }
    })();
    return this.merging;
  }

  private maxTraceRowid(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM traces').get() as { m: number }).m);
  }

  /*
   * Traces another process stored without indexing them. Every writer from
   * this release on indexes its own inserts in the transaction that stores
   * them, or queues them there for its indexer (#729; a queued trace is not
   * missing: the search indexes the queue first); a trace inserted any other way — by hand, or by a release from
   * before the index — has no docs row, and a search that trusted the index
   * would miss it until the next start rebuilt it (reconcileSearchIndex).
   * Before each search on a ready index, the traces added since the last
   * check are looked for in the index: a lookup of the table's last rowid,
   * and of each new row's id in the docs table's unique index. If any is
   * missing, the index goes back to building, so this search and the next
   * read the traces, and the background build indexes the stragglers.
   */
  private catchUpOtherWriters(): void {
    const max = this.maxTraceRowid();
    if (max <= this.indexedThrough) {
      // Rows deleted from the end, or renumbered by a purge's VACUUM: the mark follows them down.
      this.indexedThrough = max;
      return;
    }
    const missing =
      this.db.prepare(`SELECT 1 FROM traces WHERE rowid > ? AND trace_id NOT IN (SELECT trace_id FROM ${SEARCH_DOCS_TABLE}) AND trace_id NOT IN (SELECT trace_id FROM ${QUEUE_TABLE}) LIMIT 1`).get(this.indexedThrough) !== undefined;
    if (!missing) {
      this.indexedThrough = max;
      return;
    }
    this.searchIndex = 'building';
    this.searchBuild ??= this.buildSearchIndex();
  }

  async insertTrace(tenantId: TenantId, trace: Trace): Promise<void> {
    return this.insertTraces(tenantId, [trace]);
  }

  async insertTraces(tenantId: TenantId, traces: Trace[]): Promise<void> {
    assertTenant(tenantId);
    this.ensureCheckpointer();
    /*
     * After any TRUNCATE in flight on the checkpoint worker, off the event
     * loop, as deleteTrace and the background steps do. A TRUNCATE takes the
     * write lock without waiting, so a write of this connection's that lands
     * in that instant turns it away. Under steady writes it was turned away
     * at every try: with the adapter's own attempt held off by the worker's
     * copy, 8 to 11 of 20 deletes returned with the deleted text still in
     * the file, on both drivers. So every write of this connection waits
     * here, and only a reader or another process can hold a delete's
     * erasure off. Nothing is in flight almost always, and then the write
     * runs at once, in this turn; the check and the write run in the same
     * turn, so nothing can start a TRUNCATE between them.
     */
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    const insertTraceStmt = this.db.prepare(`
      INSERT INTO traces (tenant_id, trace_id, agent_name, framework, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, timestamp, tools, tools_hash, run_id, case_key, source, session_id, cost_source, cost_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Compiling this insert compiles the six span triggers of the search index: a batch without spans never asks for it.
    const insertSpanStmt = traces.some((t) => t.spans?.length)
      ? this.db.prepare(`
      INSERT INTO spans (tenant_id, span_id, trace_id, parent_span_id, name, kind, status_code, status_message, start_time, end_time, attributes, events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      : undefined;

    /** Inserts the trace and its spans; whether any of its text could hold CJK (search-index.ts, the CJK stream). */
    const insertOne = (raw: Trace): boolean => {
      /*
       * The cost settled on write. Every door settles it before it stores
       * (so its evaluation reads the same number); this is the backstop for
       * a door that does not, and a no-op on a trace already settled.
       */
      const t = resolveTraceCost(raw);
      const toolCalls = t.tool_calls ? JSON.stringify(t.tool_calls) : null;
      const metadata = t.metadata ? JSON.stringify(t.metadata) : null;
      let cjk = mayHoldCjk(t.input) || mayHoldCjk(t.output) || mayHoldCjk(toolCalls) || mayHoldCjk(metadata);
      insertTraceStmt.run(
        tenantId,
        t.trace_id,
        t.agent_name,
        t.framework ?? null,
        t.input ?? null,
        t.output ?? null,
        toolCalls,
        t.latency_ms ?? null,
        t.token_usage ? JSON.stringify(t.token_usage) : null,
        t.cost_usd ?? null,
        metadata,
        t.timestamp,
        t.tools ? JSON.stringify(t.tools) : null,
        // Derived on write so "same toolset?" is an indexed question rather
        // than a parse of every stored blob. Hashes only what a rule reads.
        toolsHash(t.tools) ?? null,
        t.run_id ?? null,
        /*
         * Derived on write when the caller sent none, so pairing works for
         * a caller who never heard of case keys. Storing it (rather than
         * deriving on read) is what lets a caller who DOES know its case
         * identity overrule the hash — see src/eval/case-key.ts.
         */
        resolveCaseKey(t.case_key, t.input),
        t.source ?? null,
        t.session_id ?? null,
        t.cost_source ?? null,
        t.cost_estimate ? JSON.stringify(t.cost_estimate) : null,
      );

      if (t.spans && insertSpanStmt) {
        for (const span of t.spans) {
          const attributes = span.attributes ? JSON.stringify(span.attributes) : null;
          const events = span.events ? JSON.stringify(span.events) : null;
          cjk ||= mayHoldCjk(attributes) || mayHoldCjk(events);
          insertSpanStmt.run(
            tenantId,
            span.span_id,
            t.trace_id,
            span.parent_span_id ?? null,
            span.name,
            span.kind,
            span.status_code,
            span.status_message ?? null,
            span.start_time,
            span.end_time ?? null,
            attributes,
            events,
          );
        }
      }
      return cjk;
    };

    const insertAll = this.db.transaction((batch: Trace[]) => {
      const mayBeCjk = batch.filter((t) => insertOne(t)).map((t) => t.trace_id);
      if (!this.indexKept) return;
      const ids = batch.map((t) => t.trace_id);
      if (batch.length < INDEX_INLINE_MIN) {
        // Queued for the search index in the same transaction, and indexed after it (#729; search-index.ts, the queue).
        enqueueTraces(this.db, ids);
        return;
      }
      // A batch this large is already the batch the indexer would write: indexed here, in the transaction that stores it, after its spans (search-index.ts says why).
      indexInsertedTraces(this.db, tenantId, ids);
      // Only traces whose text could hold CJK are read back and streamed; the rest cost that one check.
      if (mayBeCjk.length > 0) indexCjk(this.db, this.docIds(mayBeCjk));
    });
    insertAll(traces);
    if (this.indexKept && traces.length < INDEX_INLINE_MIN) {
      this.scheduleIndexing(traces.length);
      // Past the bound only while writes outrun the indexer: then this write indexes some of the queue first.
      if (this.queuedSinceDrain > INDEX_BACKLOG_TRACES) await this.holdBackForIndex();
    }
  }

  /**
   * While the queue holds more than INDEX_BACKLOG_TRACES, a write indexes some
   * of it before it returns: writes that outrun the index proceed at its
   * pace, so the queue, and what a search after them indexes first, stays
   * bounded. Never longer than BUSY_TIMEOUT_MS, the wait a write already
   * accepts for a lock.
   */
  private async holdBackForIndex(): Promise<void> {
    const depth = () => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${QUEUE_TABLE}`).get() as { n: number }).n);
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    // Between steps, the requests waiting behind this one run (indexStep).
    while (!this.closing && depth() > INDEX_BACKLOG_TRACES && Date.now() < deadline) if ((await this.indexStep()) === null) break;
  }

  async getTrace(tenantId: TenantId, traceId: string): Promise<Trace | null> {
    assertTenant(tenantId);
    const row = this.db
      .prepare('SELECT * FROM traces WHERE tenant_id = ? AND trace_id = ?')
      .get(tenantId, traceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTrace(row);
  }

  async updateTraceMetadata(tenantId: TenantId, traceId: string, patch: Record<string, unknown>): Promise<boolean> {
    assertTenant(tenantId);
    this.ensureCheckpointer();
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    // Read-then-write under IMMEDIATE, so a concurrent writer waits instead of failing the snapshot.
    const write = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT metadata FROM traces WHERE tenant_id = ? AND trace_id = ?').get(tenantId, traceId) as { metadata?: string | null } | undefined;
      if (!row) return false;
      const current = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      this.db.prepare('UPDATE traces SET metadata = ? WHERE tenant_id = ? AND trace_id = ?').run(JSON.stringify({ ...current, ...patch }), tenantId, traceId);
      this.streamCjkQueued(traceId);
      return true;
    });
    return write.immediate();
  }

  async queryTraces(tenantId: TenantId, options: TraceQueryOptions): Promise<TraceQueryResult> {
    assertTenant(tenantId);
    const plan = this.planTraceQuery(tenantId, options);
    if (plan.search) {
      return await this.searchTraces(tenantId, plan.search, plan);
    }
    const { whereClause, params, sortBy, sortOrder, limit, offset } = plan;
    const { countIndex, pageIndex } = traceIndexes(options.filter);
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM traces ${this.pinned(countIndex)} ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM traces ${this.pinned(pageIndex)} ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      traces: rows.map((row) => this.rowToTrace(row)),
      total: countRow.count,
      limit,
      offset,
    };
  }

  /**
   * Every trace a query matches, in the order its pages show them, a batch
   * at a time: the trace, its spans and its evaluations — what
   * GET /api/v1/traces/:id answers for one. The dashboard's export streams
   * from this.
   *
   * Memory is bounded by the batch, not by the store, and the generator
   * yields to the event loop before every batch so the server keeps
   * answering while an export runs. No statement stays open across a
   * yield (better-sqlite3 refuses other statements on a connection while
   * one iterates), so each batch is its own read:
   *
   *   - In time order (the list's default, and every export the dashboard
   *     makes without a search), the ids come a batch at a time by keyset
   *     on (timestamp, rowid), through the index the list's page reads
   *     (traceIndexes): an index range per batch, nothing held between
   *     batches.
   *   - Ranked by a search, the order is only known once every match is
   *     scored: the search is matched as the list's is (on the search
   *     worker when the store has one), with no time budget and no
   *     snippets, and the rows are then read a batch at a time.
   *   - Sorted by latency or cost, the ids are read in one statement first,
   *     then the rows a batch at a time.
   *
   * Either way the export's membership is fixed when it starts: a trace
   * stored after that is not included (the keyset read is bounded by the
   * largest rowid at the start), and one deleted part-way is skipped.
   */
  async *exportTraces(tenantId: TenantId, options: TraceExportOptions, batchSize = EXPORT_BATCH): AsyncGenerator<TraceRecord[]> {
    assertTenant(tenantId);
    const plan = this.planTraceQuery(tenantId, { ...options, limit: Infinity, offset: 0 });
    const { pageIndex } = traceIndexes(options.filter);
    let pages: Generator<string[]>;
    if (plan.search) {
      if (this.searchIndex === 'ready') this.catchUpOtherWriters();
      const index: 'fts5' | 'scan' = this.searchIndex === 'ready' ? 'fts5' : 'scan';
      // Traces stored a moment ago wait on the queue (#729): every one of them first, however long it takes, as the search below.
      if (index === 'fts5') {
        const upTo = this.maxTraceRowid();
        if (queuedUpTo(this.db, upTo) && !(await this.drainQueue(Infinity, upTo))) throw new Error('The store closed before the export started; try again.');
      }
      // Every match, however long it takes: an export that stopped at the list's budget would be a cut-off file.
      const { pageIds, complete } = await this.match({ tenantId, parsed: plan.search, plan, index, budgetMs: Infinity, snippets: false });
      // A search thread that failed answers as stopped with nothing read: an error here, never an empty or partial file.
      if (!complete) throw new Error('The search stopped before it read every match, so the export was not started; try again.');
      pages = chunks(pageIds, batchSize);
    } else if (plan.sortBy !== 'timestamp') {
      pages = chunks(
        (this.db
          .prepare(`SELECT trace_id FROM traces ${this.pinned(pageIndex)} ${plan.whereClause} ORDER BY ${plan.sortBy} ${plan.sortOrder}, rowid ${plan.sortOrder}`)
          .all(...plan.params) as Array<{ trace_id: string }>).map((r) => r.trace_id),
        batchSize,
      );
    } else {
      pages = this.keysetIds(`traces ${this.pinned(pageIndex)}`, 'traces', 'trace_id', 'timestamp', plan.whereClause, plan.params, plan.sortOrder, batchSize);
    }

    for (;;) {
      // Before every batch, the first included: whatever read came before was synchronous.
      await yieldToRequests();
      const next = pages.next();
      if (next.done) return;
      const chunk = next.value;
      const marks = chunk.map(() => '?').join(', ');
      // By primary key, named: a few hundred bound ids otherwise tempt the planner onto a (tenant_id, ...) index, which reads the whole tenant per batch.
      const rows = this.db
        .prepare(`SELECT * FROM traces INDEXED BY sqlite_autoindex_traces_1 WHERE tenant_id = ? AND trace_id IN (${marks})`)
        .all(tenantId, ...chunk) as Array<Record<string, unknown>>;
      const traces = new Map(rows.map((row) => [row.trace_id as string, this.rowToTrace(row)]));
      const spans = new Map<string, Span[]>();
      const spanRows = this.db
        .prepare(`SELECT * FROM spans INDEXED BY idx_spans_tenant_trace WHERE tenant_id = ? AND trace_id IN (${marks}) ORDER BY trace_id, start_time`)
        .all(tenantId, ...chunk) as Array<Record<string, unknown>>;
      for (const row of spanRows) {
        const span = this.rowToSpan(row);
        const list = spans.get(span.trace_id);
        if (list) list.push(span);
        else spans.set(span.trace_id, [span]);
      }
      const evals = await this.getEvalsByTraceIds(tenantId, chunk);
      const batch = chunk.flatMap((id) => {
        const trace = traces.get(id);
        return trace ? [{ trace, spans: spans.get(id) ?? [], evals: evals.get(id) ?? [] }] : [];
      });
      if (batch.length > 0) yield batch;
    }
  }

  /**
   * The ids a filter admits, ordered by a NOT NULL column with rowid
   * breaking ties, `size` at a time: each read starts after the previous
   * one's last (column, rowid), so it is an index range however deep into
   * the store the export has got. `from` names the table and the index to
   * walk. Bounded by the largest rowid when it starts, so rows written
   * meanwhile are not picked up.
   */
  private *keysetIds(
    from: string,
    table: 'traces' | 'eval_results',
    idColumn: 'trace_id' | 'id',
    column: 'timestamp' | 'created_at',
    whereClause: string,
    params: unknown[],
    sortOrder: string,
    size: number,
  ): Generator<string[]> {
    const ceiling = Number((this.db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() as { m: number | null }).m ?? 0);
    const desc = sortOrder === 'desc';
    const [edge, strict] = desc ? ['<=', '<'] : ['>=', '>'];
    const dir = desc ? 'DESC' : 'ASC';
    let last: { key: string; rowid: number } | undefined;
    for (;;) {
      const after = last ? ` AND ${column} ${edge} ? AND (${column} ${strict} ? OR rowid ${strict} ?)` : '';
      const rows = this.db
        .prepare(`SELECT rowid AS rid, ${idColumn} AS id, ${column} AS k FROM ${from} ${whereClause} AND rowid <= ?${after} ORDER BY ${column} ${dir}, rowid ${dir} LIMIT ?`)
        .all(...params, ceiling, ...(last ? [last.key, last.key, last.rowid] : []), size) as Array<{ rid: number; id: string; k: string }>;
      if (rows.length === 0) return;
      yield rows.map((r) => r.id);
      if (rows.length < size) return;
      const tail = rows[rows.length - 1];
      last = { key: tail.k, rowid: Number(tail.rid) };
    }
  }

  /**
   * A query's filters as SQL, its search parsed and its order checked —
   * shared by the page (queryTraces) and the export (exportTraces), so the
   * two cannot disagree about which traces a filter admits or in what order.
   */
  private planTraceQuery(tenantId: TenantId, options: TraceQueryOptions): SearchPlan & { search?: ParsedSearch } {
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    const filter = options.filter;

    if (filter?.agent_name) {
      conditions.push('agent_name = ?');
      params.push(filter.agent_name);
    }
    if (filter?.framework) {
      conditions.push('framework = ?');
      params.push(filter.framework);
    }
    if (filter?.session_id !== undefined) {
      conditions.push('session_id = ?');
      params.push(filter?.session_id);
    }
    if (filter?.since) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter?.until) {
      conditions.push('timestamp <= ?');
      params.push(filter.until);
    }
    if (filter?.min_score !== undefined || filter?.max_score !== undefined) {
      /*
       * Both bounds apply to the LATEST eval per trace (created_at DESC,
       * rowid breaking ties within the same millisecond) — the semantics
       * the get_traces description promises. These used to be two
       * INDEPENDENT EXISTS subqueries, so a trace with evals at 0.95 and
       * 0.05 matched min_score=0.4 + max_score=0.6: each bound was
       * satisfied by a different eval even though no single eval — let
       * alone the latest — was in range (#332).
       *
       * The latest eval is found through the (tenant, trace) index, named
       * (#711): left to the planner, it walked the tenant's evaluations by
       * time for every trace, to skip a sort of the one or two a trace has
       * — more than 20 s for one page at 100,000 evaluated traces.
       */
      const scoreBounds: string[] = [];
      if (filter.min_score !== undefined) {
        scoreBounds.push('e.score >= ?');
      }
      if (filter.max_score !== undefined) {
        scoreBounds.push('e.score <= ?');
      }
      conditions.push(
        'EXISTS (SELECT 1 FROM eval_results e WHERE e.rowid = ' +
          '(SELECT e2.rowid FROM eval_results e2 INDEXED BY idx_eval_results_tenant_trace WHERE e2.tenant_id = traces.tenant_id AND e2.trace_id = traces.trace_id ' +
          'ORDER BY e2.created_at DESC, e2.rowid DESC LIMIT 1) ' +
          `AND ${scoreBounds.join(' AND ')})`,
      );
      if (filter.min_score !== undefined) params.push(filter.min_score);
      if (filter.max_score !== undefined) params.push(filter.max_score);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const search = options.search !== undefined && options.search.trim() !== '' ? parseSearch(options.search) : undefined;
    // Both request paths refuse these first, with the same words; this keeps any other caller to the same limits.
    const refused = search ? searchRefusal(search) : undefined;
    if (refused !== undefined) throw new Error(`Invalid search: ${refused}`);
    // A search is ranked by relevance unless the caller chose an order.
    const sortBy = options.sort_by ?? (search ? 'relevance' : 'timestamp');
    const sortOrder = options.sort_order ?? 'desc';

    if (sortBy === 'relevance' ? !search : !ALLOWED_SORT_COLUMNS.has(sortBy)) {
      throw new Error(
        sortBy === 'relevance'
          ? 'Invalid sort column: relevance ranks a search, and this query has none (pass a search, or sort by timestamp, latency_ms or cost_usd)'
          : `Invalid sort column: ${sortBy} (allowed: ${[...ALLOWED_SORT_COLUMNS].join(', ')}, and relevance with a search)`,
      );
    }
    if (!ALLOWED_SORT_ORDERS.has(sortOrder)) {
      throw new Error(`Invalid sort order: ${sortOrder} (allowed: ${[...ALLOWED_SORT_ORDERS].join(', ')})`);
    }
    return {
      whereClause,
      params,
      filtered: conditions.length > 1,
      sortBy,
      sortOrder,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      ...(search ? { search } : {}),
    };

  }

  /**
   * The search half of queryTraces (#7). The filters are the same WHERE
   * clause, applied to the traces the search matched; the match itself is
   * the FTS5 index when this SQLite has it and a read of the traces when it
   * does not. Either way the page is chosen from trace ids first and the
   * full rows are read for that page only, so a query that matches most of
   * the store sorts ids and scores, not every input and output. Choosing
   * the page (search-match.ts) runs on the search worker; what is left
   * here, reading the page's rows and building their snippets, costs what
   * the page does, not what the store does.
   */
  private async searchTraces(tenantId: TenantId, parsed: ParsedSearch, q: SearchPlan): Promise<TraceQueryResult> {
    if (this.searchIndex === 'ready') this.catchUpOtherWriters();
    const index: 'fts5' | 'scan' = this.searchIndex === 'ready' ? 'fts5' : 'scan';
    let complete = true;
    const info = (): TraceSearchInfo => ({
      terms: parsed.terms.map(describeTerm),
      index,
      complete,
      ...(complete ? {} : { budget_ms: this.searchBudgetMs }),
      ...(parsed.ignored ? { ignored: parsed.ignored } : {}),
    });
    if (parsed.terms.length === 0) return { traces: [], total: 0, limit: q.limit, offset: q.offset, search: info() };

    let total: number;
    let pageIds: string[];

    /*
     * Traces stored a moment ago wait on the queue: index them before the
     * index is read, so the search misses none (#729). In steps, with other
     * requests answered between them, for at most the search's own budget;
     * with nothing queued it goes straight on, in the same turn of the
     * event loop.
     */
    const upTo = index === 'fts5' ? this.maxTraceRowid() : 0;
    const drained = index !== 'fts5' || !queuedUpTo(this.db, upTo) || (await this.drainQueue(this.searchBudgetMs, upTo));
    let matches: Array<TraceMatch | null>;
    ({ total, pageIds, matches, complete } = await this.match({ tenantId, parsed, plan: q, index, budgetMs: this.searchBudgetMs }));
    // What another process queued and this search could not index in time is not in the answer, and the answer says so.
    if (!drained) complete = false;

    // The snippets came with the page (search-match.ts builds them where it chose it); only the rows are read here.
    const byId = new Map<string, Trace>();
    if (pageIds.length > 0) {
      const rows = this.db
        .prepare(`SELECT * FROM traces WHERE tenant_id = ? AND trace_id IN (${pageIds.map(() => '?').join(', ')})`)
        .all(tenantId, ...pageIds) as Array<Record<string, unknown>>;
      for (const row of rows) byId.set(row.trace_id as string, this.rowToTrace(row));
    }
    const traces = pageIds.flatMap((id, i) => {
      const trace = byId.get(id);
      if (!trace) return [];
      const match = matches[i];
      return [match ? { ...trace, match } : trace];
    });
    return { traces, total, limit: q.limit, offset: q.offset, search: info() };
  }

  async insertSpan(tenantId: TenantId, span: Span): Promise<void> {
    assertTenant(tenantId);
    this.ensureCheckpointer();
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    const insert = this.db.prepare(`
      INSERT INTO spans (tenant_id, span_id, trace_id, parent_span_id, name, kind, status_code, status_message, start_time, end_time, attributes, events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      // A span added to a trace already in the search index re-indexes it, by trigger (search-index.ts).
      insert.run(
        tenantId,
        span.span_id,
        span.trace_id,
        span.parent_span_id ?? null,
        span.name,
        span.kind,
        span.status_code,
        span.status_message ?? null,
        span.start_time,
        span.end_time ?? null,
        span.attributes ? JSON.stringify(span.attributes) : null,
        span.events ? JSON.stringify(span.events) : null,
      );
      this.streamCjkQueued(span.trace_id);
    })();
  }

  /** The search index's doc ids of these traces. */
  private docIds(traceIds: readonly string[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < traceIds.length; i += 500) {
      const chunk = traceIds.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT doc_id FROM ${SEARCH_DOCS_TABLE} WHERE trace_id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk) as Array<{ doc_id: number }>;
      for (const r of rows) out.push(Number(r.doc_id));
    }
    return out;
  }

  /** A write of the adapter's own queued the trace for its CJK stream (by trigger): stream it now, in the caller's transaction. */
  private streamCjkQueued(traceId: string): void {
    if (!this.indexKept) return;
    const queued = this.db.prepare(`SELECT p.doc_id FROM ${CJK_PENDING_TABLE} p JOIN ${SEARCH_DOCS_TABLE} d ON d.doc_id = p.doc_id WHERE d.trace_id = ?`).get(traceId) as { doc_id: number } | undefined;
    if (queued) indexCjk(this.db, [Number(queued.doc_id)]);
  }

  async getSpansByTraceId(tenantId: TenantId, traceId: string): Promise<Span[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE tenant_id = ? AND trace_id = ? ORDER BY start_time')
      .all(tenantId, traceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSpan(row));
  }

  async insertEvalResult(tenantId: TenantId, result: EvalResult): Promise<void> {
    assertTenant(tenantId);
    this.ensureCheckpointer();
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    /*
     * created_at is written EXPLICITLY as ISO-8601. Leaving it to the
     * column DEFAULT (datetime('now')) stored "2026-08-09 15:00:00", which
     * every period query then compared as a string against a JS
     * toISOString() boundary — and ' ' sorts before 'T', so any eval whose
     * calendar date matched the boundary's date was dropped from the
     * window. Migration 005 rewrites rows written before this line existed.
     */
    /*
     * critical_failures is PERSISTED (migration 006) because the veto is a
     * verdict, not a presentation detail. It used to live only in the live
     * tool response, so the moment an evaluation was stored a vetoed eval
     * became indistinguishable from one that merely scored below threshold —
     * no surface could filter, count, or explain the release's flagship
     * behaviour. NULL when nothing vetoed.
     */
    /*
     * Provenance (migration 007) is the part of the receipt a row cannot
     * reconstruct: the release, the ruleset and config hashes, the threshold.
     * verdict / coverage / critical_skipped are derived on every read from
     * rule_results plus that threshold, so they are not columns.
     */
    this.db.prepare(`
      INSERT INTO eval_results (tenant_id, id, trace_id, eval_type, output_text, expected_text, score, passed, rule_results, suggestions, rules_evaluated, rules_skipped, insufficient_data, critical_failures, created_at, provenance, engine_version, ruleset_hash, config_hash, threshold, eval_cost_usd, eval_tokens, run_id, risk_estimate, risk_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      result.id,
      result.trace_id ?? null,
      result.eval_type,
      this.storedOutputText(result),
      result.expected_text ?? null,
      result.score,
      result.passed ? 1 : 0,
      JSON.stringify(result.rule_results),
      // The `suggestions` column outlived the field (0.16.0 removed it for
      // interpretations[]). It is written as an empty array rather than
      // dropped so a database this version writes still opens — and reads
      // back without a crash — on 0.15.0, which parses this column.
      '[]',
      result.rules_evaluated ?? null,
      result.rules_skipped ?? null,
      result.insufficient_data ? 1 : 0,
      result.critical_failures?.length ? JSON.stringify(result.critical_failures) : null,
      /*
       * EvalResult has declared `created_at` since the type existed and this
       * insert discarded it, so an imported or backdated evaluation silently
       * became "now" — the same accepted-and-dropped shape as log_trace's
       * tools catalogue. Honoured when supplied, and still defaulted to now,
       * which is what every caller in this package relies on.
       */
      result.created_at ?? new Date().toISOString(),
      result.provenance ? JSON.stringify(result.provenance) : null,
      result.provenance?.irisVersion ?? null,
      result.provenance?.rulesetHash ?? null,
      result.provenance?.configHash ?? null,
      result.provenance?.thresholds.default ?? null,
      result.eval_cost_usd ?? null,
      result.eval_tokens ?? null,
      // Set only by a re-evaluation. Left null, the evaluation belongs to
      // whatever run its trace does — which is right for every normal call.
      result.run_id ?? null,
      // The risk estimate the verdict was composed from, so reading the row back does not run the draws again (migration 018).
      ...riskColumns(result),
    );
    // The row is durable; tell whoever asked. A listener's failure is its own.
    for (const listener of this.evalListeners) {
      try {
        listener(tenantId, result);
      } catch {
        /* never the write's problem */
      }
    }
  }

  async getEvalsByTraceId(tenantId: TenantId, traceId: string): Promise<EvalResult[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare('SELECT * FROM eval_results WHERE tenant_id = ? AND trace_id = ? ORDER BY created_at DESC')
      .all(tenantId, traceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvalResult(row));
  }

  async getEvalsByTraceIds(tenantId: TenantId, traceIds: readonly string[]): Promise<Map<string, EvalResult[]>> {
    assertTenant(tenantId);
    const out = new Map<string, EvalResult[]>();
    // SQLite binds at most 32766 variables; a page is at most a few hundred ids, chunked anyway.
    const CHUNK = 500;
    const ids = [...new Set(traceIds)];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const marks = chunk.map(() => '?').join(', ');
      const rows = this.db
        // Named, as the export's other batch reads are: the planner chooses this index today, and nothing else would hold it there.
        .prepare(`SELECT * FROM eval_results INDEXED BY idx_eval_results_tenant_trace WHERE tenant_id = ? AND trace_id IN (${marks}) ORDER BY trace_id, created_at DESC`)
        .all(tenantId, ...chunk) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const result = this.rowToEvalResult(row);
        const key = result.trace_id ?? '';
        const list = out.get(key);
        if (list) list.push(result);
        else out.set(key, [result]);
      }
    }
    return out;
  }

  /**
   * Every evaluation in a run, one per trace, newest first.
   *
   * A trace can be evaluated more than once — re-run the rules and there
   * are two rows for one execution. Counting both would double a case and
   * quietly weight it twice in a pass rate, so this keeps the MOST RECENT
   * evaluation per trace and says how many it collapsed. That number is
   * reported rather than hidden: a run whose traces were each evaluated
   * three times is a run somebody re-ran, and a reader comparing it to
   * another should know.
   *
   * The run of an evaluation is `eval_results.run_id` when set, and the
   * run of its TRACE otherwise. Both exist for a reason: an ordinary
   * evaluation belongs to whatever batch its execution belonged to, and
   * deriving that from the trace keeps one source of truth. A
   * RE-EVALUATION belongs to a batch its trace never saw, and that is the
   * case the column exists for.
   */
  /**
   * Register (or update) a run. Only the two facts that cannot be derived
   * are written: the caller's label and, for a re-evaluation, what it re-ran.
   * Everything else a reader wants about a run is counted from its rows.
   */
  async upsertRun(
    tenantId: TenantId,
    run: { runId: string; label?: string | null; agentName?: string | null; reevaluationOf?: string | null },
  ): Promise<void> {
    assertTenant(tenantId);
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    this.db
      .prepare(
        `INSERT INTO runs (run_id, tenant_id, label, agent_name, reevaluation_of)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           label = COALESCE(excluded.label, runs.label),
           agent_name = COALESCE(excluded.agent_name, runs.agent_name),
           reevaluation_of = COALESCE(excluded.reevaluation_of, runs.reevaluation_of)`,
      )
      .run(run.runId, tenantId, run.label ?? null, run.agentName ?? null, run.reevaluationOf ?? null);
  }

  /**
   * Every run this tenant has, newest first.
   *
   * The listing is the UNION of registered runs and run ids found on traces
   * or evaluations, because a run id arrives on a log_trace call long before
   * anything registers it — a caller who passes `run` and nothing else must
   * still see their run here. A registered run with no rows yet is listed
   * too, so a re-evaluation that produced nothing is visible rather than
   * silently absent.
   */
  /* ---- Datasets ------------------------------------------ */

  async createDataset(tenantId: TenantId, input: { label: string; cases: DatasetCase[] }): Promise<DatasetDetail> {
    assertTenant(tenantId);
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    const label = input.label.trim();
    const taken = this.db.prepare('SELECT id FROM datasets WHERE tenant_id = ? AND label = ?').get(tenantId, label);
    if (taken) throw new DatasetExistsError(label);
    const id = `ds_${randomBytes(8).toString('hex')}`;
    const insertDataset = this.db.prepare('INSERT INTO datasets (id, tenant_id, label) VALUES (?, ?, ?)');
    const insertCase = this.db.prepare('INSERT OR REPLACE INTO dataset_cases (dataset_id, case_key, expected_json) VALUES (?, ?, ?)');
    this.db.transaction(() => {
      insertDataset.run(id, tenantId, label);
      for (const c of input.cases) {
        insertCase.run(id, c.caseKey, c.expected === null || c.expected === undefined ? null : JSON.stringify(c.expected));
      }
    })();
    const created = await this.getDataset(tenantId, id);
    if (!created) throw new Error(`dataset ${id} vanished after insert`);
    return created;
  }

  async getDataset(tenantId: TenantId, idOrLabel: string): Promise<DatasetDetail | null> {
    assertTenant(tenantId);
    const row = this.db
      .prepare(
        `SELECT id, label, version, created_at FROM datasets
          WHERE tenant_id = ? AND (id = ? OR label = ?)
          ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
          LIMIT 1`,
      )
      .get(tenantId, idOrLabel, idOrLabel, idOrLabel) as { id: string; label: string; version: number; created_at: string } | undefined;
    if (!row) return null;
    const cases = this.db
      .prepare('SELECT case_key, expected_json FROM dataset_cases WHERE dataset_id = ? ORDER BY case_key')
      .all(row.id) as Array<{ case_key: string; expected_json: string | null }>;
    return {
      id: row.id,
      label: row.label,
      version: row.version,
      createdAt: row.created_at,
      cases: cases.length,
      caseKeys: cases.map((c) => ({ caseKey: c.case_key, expected: c.expected_json === null ? null : (JSON.parse(c.expected_json) as unknown) })),
    };
  }

  async listDatasets(tenantId: TenantId): Promise<DatasetSummary[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT d.id, d.label, d.version, d.created_at,
                (SELECT COUNT(*) FROM dataset_cases c WHERE c.dataset_id = d.id) AS cases
           FROM datasets d
          WHERE d.tenant_id = ?
          ORDER BY d.created_at DESC, d.label ASC`,
      )
      .all(tenantId) as Array<{ id: string; label: string; version: number; created_at: string; cases: number }>;
    return rows.map((r) => ({ id: r.id, label: r.label, version: r.version, createdAt: r.created_at, cases: r.cases }));
  }

  async caseKeysInRun(tenantId: TenantId, runId: string): Promise<string[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare('SELECT DISTINCT case_key FROM traces WHERE tenant_id = ? AND run_id = ? AND case_key IS NOT NULL ORDER BY case_key')
      .all(tenantId, runId) as Array<{ case_key: string }>;
    return rows.map((r) => r.case_key);
  }

  async costByAgent(tenantId: TenantId, since: string | null, limit: number): Promise<AgentCostRow[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT agent_name,
                COUNT(*)                     AS traces,
                COUNT(cost_usd)              AS costed,
                COUNT(CASE WHEN cost_source = 'estimated' THEN 1 END) AS estimated,
                COALESCE(SUM(cost_usd), 0)   AS total,
                COALESCE(SUM(CASE WHEN cost_source = 'estimated' THEN cost_usd END), 0) AS estimated_total,
                AVG(cost_usd)                AS avg,
                MAX(cost_usd)                AS max
           FROM traces
          WHERE tenant_id = ? AND (? IS NULL OR timestamp >= ?)
          GROUP BY agent_name
          ORDER BY total DESC, agent_name ASC
          LIMIT ?`,
      )
      .all(tenantId, since, since, limit) as Array<{ agent_name: string; traces: number; costed: number; estimated: number; total: number; estimated_total: number; avg: number | null; max: number | null }>;
    return rows.map((r) => ({
      agent: r.agent_name,
      traces: r.traces,
      costedTraces: r.costed,
      estimatedTraces: r.estimated,
      totalCostUsd: Math.round(r.total * 1e6) / 1e6,
      estimatedCostUsd: Math.round(r.estimated_total * 1e6) / 1e6,
      avgCostUsd: r.avg === null ? null : Math.round(r.avg * 1e6) / 1e6,
      maxCostUsd: r.max,
    }));
  }

  async listRuns(tenantId: TenantId, limit = 50): Promise<RunSummaryRow[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `WITH ids(run_id) AS (
             SELECT run_id FROM runs WHERE tenant_id = ? AND run_id IS NOT NULL
             UNION SELECT run_id FROM traces WHERE tenant_id = ? AND run_id IS NOT NULL
             UNION SELECT run_id FROM eval_results WHERE tenant_id = ? AND run_id IS NOT NULL
           )
           SELECT i.run_id                                                                              AS run_id,
                  r.label                                                                               AS label,
                  r.reevaluation_of                                                                     AS reevaluation_of,
                  COALESCE(r.baseline, 0)                                                               AS baseline,
                  (SELECT COUNT(*) FROM traces t WHERE t.tenant_id = ? AND t.run_id = i.run_id)         AS traces,
                  COALESCE(r.started_at,
                           (SELECT MIN(t.timestamp) FROM traces t WHERE t.tenant_id = ? AND t.run_id = i.run_id)) AS started_at,
                  (SELECT MAX(t.timestamp) FROM traces t WHERE t.tenant_id = ? AND t.run_id = i.run_id) AS last_trace_at
             FROM ids i
             LEFT JOIN runs r ON r.run_id = i.run_id AND r.tenant_id = ?
            ORDER BY started_at DESC, i.run_id DESC
            LIMIT ?`,
      )
      .all(tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, limit) as Array<Record<string, unknown>>;

    const out: RunSummaryRow[] = [];
    for (const row of rows) {
      const runId = String(row.run_id);
      // Counted through the same collapsed view a comparison uses, so a run's
      // listed `evaluated` can never disagree with what compare_runs read.
      const results = await this.getRunResults(tenantId, runId);
      const lastEval = results.reduce<string | null>((acc, r) => (acc === null || r.createdAt > acc ? r.createdAt : acc), null);
      const lastTrace = (row.last_trace_at as string | null) ?? null;
      out.push({
        runId,
        label: (row.label as string | null) ?? null,
        reevaluationOf: (row.reevaluation_of as string | null) ?? null,
        traces: Number(row.traces ?? 0),
        evaluated: results.length,
        passed: results.filter((r) => r.passed).length,
        agentNames: [...new Set(results.map((r) => r.agentName).filter((v): v is string => v !== null))].sort(),
        engineVersions: [...new Set(results.map((r) => r.engineVersion).filter((v): v is string => v !== null))].sort(),
        rulesetHashes: [...new Set(results.map((r) => r.rulesetHash).filter((v): v is string => v !== null))].sort(),
        startedAt: (row.started_at as string | null) ?? null,
        lastActivityAt: lastEval !== null && (lastTrace === null || lastEval > lastTrace) ? lastEval : lastTrace,
        baseline: Number(row.baseline ?? 0) === 1,
      });
    }
    return out;
  }

  async setRunBaseline(tenantId: TenantId, runId: string, baseline: boolean): Promise<void> {
    assertTenant(tenantId);
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    const write = this.db.transaction(() => {
      // A run that exists only because traces carried its id gets its row here; the label stays whatever it was.
      this.db.prepare('INSERT OR IGNORE INTO runs (run_id, tenant_id) VALUES (?, ?)').run(runId, tenantId);
      if (baseline) this.db.prepare('UPDATE runs SET baseline = 0 WHERE tenant_id = ? AND baseline = 1').run(tenantId);
      this.db.prepare('UPDATE runs SET baseline = ? WHERE tenant_id = ? AND run_id = ?').run(baseline ? 1 : 0, tenantId, runId);
    });
    write.immediate();
  }

  async getBaselineRun(tenantId: TenantId): Promise<string | null> {
    assertTenant(tenantId);
    const row = this.db.prepare('SELECT run_id FROM runs WHERE tenant_id = ? AND baseline = 1 LIMIT 1').get(tenantId) as { run_id: string } | undefined;
    return row ? String(row.run_id) : null;
  }

  /** One run, or null when no trace, evaluation or registration mentions it. */
  async getRun(tenantId: TenantId, runId: string): Promise<RunSummaryRow | null> {
    assertTenant(tenantId);
    const known = this.db
      .prepare(
        `SELECT 1 AS hit FROM runs WHERE tenant_id = ? AND run_id = ?
          UNION SELECT 1 FROM traces WHERE tenant_id = ? AND run_id = ?
          UNION SELECT 1 FROM eval_results WHERE tenant_id = ? AND run_id = ?
          LIMIT 1`,
      )
      .get(tenantId, runId, tenantId, runId, tenantId, runId);
    if (known === undefined) return null;
    const all = await this.listRuns(tenantId, 1000);
    return all.find((r) => r.runId === runId) ?? null;
  }

  /**
   * Every trace in a run, with whether its latest evaluation was produced
   * under a given ruleset. This is the question `evaluate_runs` asks:
   * re-evaluating a trace whose verdict already came from the current rules
   * would spend work to reproduce a row that exists.
   */
  async getRunTraceEvaluationState(
    tenantId: TenantId,
    runId: string,
    rulesetHash: string,
  ): Promise<Array<{ traceId: string; evaluatedUnderRuleset: boolean }>> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT t.trace_id AS trace_id,
                (SELECT e.ruleset_hash FROM eval_results e
                  WHERE e.tenant_id = t.tenant_id AND e.trace_id = t.trace_id
                  ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS latest_ruleset
           FROM traces t
          WHERE t.tenant_id = ? AND t.run_id = ?
          ORDER BY t.timestamp ASC`,
      )
      .all(tenantId, runId) as Array<{ trace_id: string; latest_ruleset: string | null }>;
    return rows.map((r) => ({ traceId: r.trace_id, evaluatedUnderRuleset: r.latest_ruleset === rulesetHash }));
  }

  async getRunResults(tenantId: TenantId, runId: string): Promise<RunResultRow[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT e.id, e.trace_id, e.passed, e.rule_results, e.engine_version, e.ruleset_hash, e.config_hash, e.created_at,
                t.case_key, t.agent_name
           FROM eval_results e
           LEFT JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
          WHERE e.tenant_id = ? AND COALESCE(e.run_id, t.run_id) = ?
          ORDER BY e.created_at DESC, e.id DESC`,
      )
      .all(tenantId, runId) as Array<Record<string, unknown>>;

    const seen = new Set<string>();
    const out: RunResultRow[] = [];
    let superseded = 0;
    for (const row of rows) {
      const traceId = (row.trace_id as string | null) ?? `eval:${String(row.id)}`;
      if (seen.has(traceId)) {
        superseded += 1;
        continue;
      }
      seen.add(traceId);
      const ruleResults = parseRuleResults<{ ruleName: string; passed: boolean; skipped?: boolean }>(row.rule_results);
      out.push({
        evalId: String(row.id),
        traceId: (row.trace_id as string | null) ?? null,
        caseKey: (row.case_key as string | null) ?? null,
        agentName: (row.agent_name as string | null) ?? null,
        passed: row.passed === 1 || row.passed === true,
        failedRules: ruleResults.filter((r) => r.skipped !== true && r.passed === false).map((r) => r.ruleName),
        engineVersion: (row.engine_version as string | null) ?? null,
        rulesetHash: (row.ruleset_hash as string | null) ?? null,
        configHash: (row.config_hash as string | null) ?? null,
        createdAt: String(row.created_at),
      });
    }
    if (superseded > 0) out.forEach((r) => (r.supersededInRun = superseded));
    return out;
  }

  /**
   * Every evaluation that carries a case key, optionally narrowed.
   *
   * Deliberately NOT collapsed to one row per trace, unlike getRunResults.
   * There the question is "how did this run do", and a trace evaluated
   * twice is one case that would otherwise be weighted twice. Here the
   * question is "how reliably does the agent answer this", and every
   * attempt is a real attempt — collapsing them would erase the very
   * repetition being measured.
   */
  async getCaseResults(tenantId: TenantId, filter: { run?: string; caseKey?: string; question?: QuestionId; session?: string; groupBy?: 'case_key' | 'session' } = {}): Promise<CaseResultRow[]> {
    assertTenant(tenantId);
    /*
     * The join order is pinned (#711). A case key or a session names its
     * traces, so the read starts from that index range; anything else reads
     * every evaluation of the tenant, and starts there. Left to the planner,
     * a read by case key walked every evaluation (290 ms at 100,000
     * evaluated traces, against 0.1 ms from the case index) — and it is the
     * read a webhook makes for each evaluation.
     */
    const fromTraces = filter.caseKey !== undefined ? 'idx_traces_tenant_case' : filter.session !== undefined ? 'idx_traces_tenant_session' : undefined;
    const from =
      fromTraces !== undefined
        ? `FROM traces t ${this.pinned(fromTraces)} CROSS JOIN eval_results e INDEXED BY idx_eval_results_tenant_trace ON e.trace_id = t.trace_id AND e.tenant_id = t.tenant_id`
        : 'FROM eval_results e INDEXED BY idx_eval_results_tenant_created CROSS JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id';
    // Grouped by session, a turn without a case key still counts; grouped by case, a turn without one never did.
    // Read from the evaluations, each trace is found by its id: the `+` keeps that test from becoming a range scan of an index per evaluation.
    const grouped = filter.groupBy === 'session' ? 'session_id IS NOT NULL' : 'case_key IS NOT NULL';
    const where: string[] = fromTraces !== undefined ? ['t.tenant_id = ?', `t.${grouped}`] : ['e.tenant_id = ?', `+t.${grouped}`];
    const params: unknown[] = [tenantId];
    if (filter.session !== undefined) {
      where.push('t.session_id = ?');
      params.push(filter.session);
    }
    if (filter.run !== undefined) {
      where.push('COALESCE(e.run_id, t.run_id) = ?');
      params.push(filter.run);
    }
    if (filter.caseKey !== undefined) {
      where.push('t.case_key = ?');
      params.push(filter.caseKey);
    }
    const rows = this.db
      .prepare(
        `SELECT e.id, e.trace_id, e.passed, e.created_at, e.rule_results, t.case_key, t.session_id, COALESCE(e.run_id, t.run_id) AS run_id
           ${from}
          WHERE ${where.join(' AND ')}
          ORDER BY e.created_at ASC, e.id ASC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const out: CaseResultRow[] = [];
    for (const row of rows) {
      let passed = row.passed === 1 || row.passed === true;
      if (filter.question !== undefined) {
        // The question's own answer, from the rules that answered it on this evaluation.
        const results = parseRuleResults<{ question?: string; passed: boolean; skipped?: boolean }>(row.rule_results);
        const answering = results.filter((r) => r.question === filter.question && !r.skipped);
        if (answering.length === 0) continue;
        passed = answering.every((r) => r.passed);
      }
      out.push({
        evalId: String(row.id),
        traceId: (row.trace_id as string | null) ?? null,
        caseKey: (row.case_key as string | null) ?? null,
        sessionId: (row.session_id as string | null) ?? null,
        runId: (row.run_id as string | null) ?? null,
        passed,
        createdAt: String(row.created_at),
      });
    }
    return out;
  }

  async getEvalById(tenantId: TenantId, id: string): Promise<EvalResult | null> {
    assertTenant(tenantId);
    const row = this.db
      .prepare('SELECT * FROM eval_results WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? this.rowToEvalResult(row) : null;
  }

  async queryEvalResults(
    tenantId: TenantId,
    options: EvalResultFilter & {
      limit?: number;
      offset?: number;
    },
  ): Promise<{ results: EvalResult[]; total: number }> {
    assertTenant(tenantId);
    const { whereClause, params } = this.evalWhere(tenantId, options);
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM eval_results ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM eval_results ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      results: rows.map((row) => this.rowToEvalResult(row)),
      total: countRow.count,
    };
  }

  /** Every evaluation a filter matches, newest first as the list pages them, a batch at a time: by keyset on (created_at, rowid), as exportTraces reads in time order. */
  async *exportEvalResults(tenantId: TenantId, filter: EvalResultFilter, batchSize = EXPORT_BATCH): AsyncGenerator<EvalResult[]> {
    assertTenant(tenantId);
    const { whereClause, params } = this.evalWhere(tenantId, filter);
    const pages = this.keysetIds('eval_results INDEXED BY idx_eval_results_tenant_created', 'eval_results', 'id', 'created_at', whereClause, params, 'desc', batchSize);
    for (;;) {
      await yieldToRequests();
      const next = pages.next();
      if (next.done) return;
      const chunk = next.value;
      /*
       * By primary key, named: with a few hundred ids bound, SQLite otherwise
       * picks a (tenant_id, ...) index and reads every evaluation of the
       * tenant for each batch (37 s instead of under 2 for 100k rows,
       * scripts/bench-export.ts). The tenant is still checked on every row.
       */
      const rows = this.db
        .prepare(`SELECT * FROM eval_results INDEXED BY sqlite_autoindex_eval_results_1 WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`)
        .all(tenantId, ...chunk) as Array<Record<string, unknown>>;
      const byId = new Map(rows.map((row) => [row.id as string, row]));
      const batch = chunk.flatMap((id) => {
        const row = byId.get(id);
        return row ? [this.rowToEvalResult(row)] : [];
      });
      if (batch.length > 0) yield batch;
    }
  }

  /** The evaluation list's filters as SQL — one builder for the page and the export. */
  private evalWhere(tenantId: TenantId, options: EvalResultFilter): { whereClause: string; params: unknown[] } {
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (options.eval_type) {
      conditions.push('eval_type = ?');
      params.push(options.eval_type);
    }
    if (options.passed !== undefined) {
      conditions.push('passed = ?');
      params.push(options.passed ? 1 : 0);
    }
    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }
    if (options.until) {
      conditions.push('created_at <= ?');
      params.push(options.until);
    }
    return { whereClause: `WHERE ${conditions.join(' AND ')}`, params };
  }

  async getDashboardSummary(tenantId: TenantId, sinceHours = 24): Promise<DashboardSummary> {
    assertTenant(tenantId);
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

    /*
     * Every trace read here comes from idx_traces_tenant_timestamp_cover,
     * named, which holds the window's agent, latency, cost and cost source: no trace row
     * is read (#711). Until 0.20.0 the window's rows were read three times
     * over, and with statistics the planner walked every trace of the
     * tenant for the top agents; a 30-day summary at 100,000 traces took
     * 0.3 to 0.8 s. The error rate reads the traces with a failed span once
     * from their own index, which holds nothing else, and counts the ones
     * in the window.
     */
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total_traces,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(CASE WHEN cost_source = 'estimated' THEN cost_usd END), 0) as estimated_cost_usd
      FROM traces ${this.pinned('idx_traces_tenant_timestamp_cover')} WHERE tenant_id = ? AND timestamp >= ?
    `).get(tenantId, since) as { total_traces: number; avg_latency_ms: number; total_cost_usd: number; estimated_cost_usd: number };

    const errorCount = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM traces t ${this.pinned('idx_traces_tenant_timestamp_cover')}
      WHERE t.tenant_id = ? AND t.timestamp >= ?
        AND t.trace_id IN (SELECT s.trace_id FROM spans s ${this.pinned('idx_spans_tenant_error')} WHERE s.tenant_id = ? AND s.status_code = 'ERROR')
    `).get(tenantId, since, tenantId) as { count: number };

    const evalStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed_count
      FROM eval_results INDEXED BY idx_eval_results_tenant_created WHERE tenant_id = ? AND created_at >= ?
    `).get(tenantId, since) as { total: number; passed_count: number };

    const tracesPerHour = this.db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) as hour, COUNT(*) as count
      FROM traces ${this.pinned('idx_traces_tenant_timestamp_cover')} WHERE tenant_id = ? AND timestamp >= ?
      GROUP BY hour ORDER BY hour
    `).all(tenantId, since) as Array<{ hour: string; count: number }>;

    const topAgents = this.db.prepare(`
      SELECT agent_name, COUNT(*) as count
      FROM traces ${this.pinned('idx_traces_tenant_timestamp_cover')} WHERE tenant_id = ? AND timestamp >= ?
      GROUP BY agent_name ORDER BY count DESC LIMIT 10
    `).all(tenantId, since) as Array<{ agent_name: string; count: number }>;

    return {
      total_traces: stats.total_traces,
      avg_latency_ms: Math.round(stats.avg_latency_ms * 100) / 100,
      total_cost_usd: Math.round(stats.total_cost_usd * 10000) / 10000,
      estimated_cost_usd: Math.round(stats.estimated_cost_usd * 10000) / 10000,
      error_rate: stats.total_traces > 0 ? errorCount.count / stats.total_traces : 0,
      eval_pass_rate: evalStats.total > 0 ? evalStats.passed_count / evalStats.total : 0,
      traces_per_hour: tracesPerHour,
      top_agents: topAgents,
    };
  }

  // ---------------------------------------------------------------------------
  // Eval-stats endpoints (v0.2.0 dashboard)
  // ---------------------------------------------------------------------------

  /*
   * Table-driven rather than a nested ternary: the old form silently fell
   * through to 720 hours for anything that wasn't '24h' or '7d', so a new
   * period value would have quietly returned 30d data rather than failing.
   */
  private static readonly PERIOD_HOURS: Record<Exclude<EvalStatsPeriod, 'all'>, number> = {
    '24h': 24,
    '2d': 48,
    '7d': 168,
    '14d': 336,
    '30d': 720,
    '60d': 1440,
    '90d': 2160,
    '180d': 4320,
  };

  private periodToSince(period: EvalStatsPeriod): string {
    if (period === 'all') return '1970-01-01T00:00:00.000Z';
    const hours = SqliteAdapter.PERIOD_HOURS[period];
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  }

  async getEvalStats(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStats> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    /*
     * No trace_id filter — deliberately. evaluate_output without a
     * trace_id is documented and normal, and every sibling scan (trend,
     * per-rule breakdown, failures) counts unlinked evals. Filtering only
     * this headline made totalEvals disagree with the trend's sum, and —
     * because eval_results.trace_id is ON DELETE SET NULL — deleting a
     * trace retroactively shrank the headline while the trend kept the
     * eval. One population everywhere: every eval in the window.
     *
     * Every read of an evaluation window names the (tenant, created) index
     * (#711): with statistics that said the window held most of the store,
     * SQLite read the whole table instead, and statistics from another day
     * would have done the same for a window of an hour.
     */
    const agg = this.db.prepare(`
      SELECT
        COUNT(*)                                     AS total_evals,
        COALESCE(AVG(score), 0)                      AS avg_score,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_count
      FROM eval_results INDEXED BY idx_eval_results_tenant_created
      WHERE tenant_id = ? AND created_at >= ?
    `).get(tenantId, since) as { total_evals: number; avg_score: number; passed_count: number };

    // The window's cost and agents come from the covering time index, named so statistics cannot trade it for a walk of every trace (#711).
    const cost = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
             COALESCE(SUM(CASE WHEN cost_source = 'estimated' THEN cost_usd END), 0) AS estimated_cost
      FROM traces ${this.pinned('idx_traces_tenant_timestamp_cover')}
      WHERE tenant_id = ? AND timestamp >= ?
    `).get(tenantId, since) as { total_cost: number; estimated_cost: number };

    const agents = this.db.prepare(`
      SELECT COUNT(DISTINCT agent_name) AS agent_count
      FROM traces ${this.pinned('idx_traces_tenant_timestamp_cover')}
      WHERE tenant_id = ? AND timestamp >= ?
    `).get(tenantId, since) as { agent_count: number };

    /*
     * No `AND passed = 0` here — deliberately.
     *
     * A safety eval's score is the average across its rules, so a single
     * violation is routinely outvoted: output containing "Your SSN is
     * 123-45-6789" fails no_pii (score 0) while the three other safety
     * rules pass, giving 0.733 overall — above the 0.7 threshold, so
     * passed = 1. Filtering to failed evals therefore reported
     * {pii: 0, injection: 0, hallucination: 0} for a trace that leaked a
     * social security number.
     *
     * For a product whose job is catching PII, injection and hallucination,
     * that error ran in the direction that HIDES problems. The count is
     * per-VIOLATION, not per-failed-eval; the per-rule loop below already
     * skips rules that passed, so scanning every safety eval in the window
     * is both correct and sufficient.
     */
    /*
     * eval_type IN ('safety', 'all'): an eval_type="all" run carries the
     * whole safety bundle inside its rule_results, and a PII leak caught
     * there is exactly as real as one caught by a safety-only run. The
     * per-rule loop below keys on rule NAMES, so the wider filter cannot
     * over-count.
     */
    const safetyRows = this.db.prepare(`
      SELECT rule_results
      FROM eval_results INDEXED BY idx_eval_results_tenant_created
      WHERE tenant_id = ? AND created_at >= ?
        AND eval_type IN ('safety', 'all')
    `).all(tenantId, since) as Array<{ rule_results: string }>;

    const violations = { pii: 0, injection: 0, hallucination: 0 };
    for (const row of safetyRows) {
      const rules = parseRuleResults<{ ruleName: string; passed: boolean }>(row.rule_results);
      for (const r of rules) {
        if (r.passed) continue;
        if (r.ruleName === 'no_pii') violations.pii++;
        if (r.ruleName === 'no_injection_patterns') violations.injection++;
        if (r.ruleName === 'no_hallucination_markers') violations.hallucination++;
      }
    }

    return {
      passRate: agg.total_evals > 0
        ? Math.round((agg.passed_count / agg.total_evals) * 1000) / 1000
        : 0,
      avgScore: Math.round(agg.avg_score * 1000) / 1000,
      totalEvals: agg.total_evals,
      safetyViolations: violations,
      totalCost: Math.round(cost.total_cost * 10000) / 10000,
      estimatedCost: Math.round(cost.estimated_cost * 10000) / 10000,
      agentCount: agents.agent_count,
      period,
    };
  }

  async getEvalStatsTrend(tenantId: TenantId, period: EvalStatsPeriod, cohortBy?: TrendCohort): Promise<EvalStatsTrendBucket[]> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    let bucketExpr: string;
    if (period === '24h') {
      bucketExpr = "strftime('%Y-%m-%dT%H:00:00Z', e.created_at)";
    } else if (period === '7d') {
      bucketExpr =
        "strftime('%Y-%m-%dT', e.created_at) || printf('%02d', (CAST(strftime('%H', e.created_at) AS INTEGER) / 6) * 6) || ':00:00Z'";
    } else {
      bucketExpr = "strftime('%Y-%m-%dT00:00:00Z', e.created_at)";
    }

    /*
     * The cohort of an evaluation is its own run when it has one, and its
     * trace's run otherwise — the same COALESCE every run read uses. A
     * re-evaluation carries its own run_id precisely so it lands in the new
     * cohort rather than back in the run whose traces it re-scored.
     *
     * 'run' is the only value the type admits, so this is a fixed string
     * chosen by a closed union rather than caller text reaching SQL.
     */
    const cohortExpr = cohortBy === 'run' ? 'COALESCE(e.run_id, t.run_id)' : 'NULL';

    const rows = this.db.prepare(`
      SELECT
        ${bucketExpr}                                  AS bucket,
        ${cohortExpr}                                  AS cohort,
        COALESCE(AVG(e.score), 0)                      AS avg_score,
        CASE WHEN COUNT(*) > 0
          THEN CAST(SUM(CASE WHEN e.passed = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
          ELSE 0 END                                   AS pass_rate,
        COUNT(*)                                       AS eval_count
      FROM eval_results e
      LEFT JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.created_at >= ?
      GROUP BY bucket, cohort
      ORDER BY bucket, cohort
    `).all(tenantId, since) as Array<{
      bucket: string;
      cohort: string | null;
      avg_score: number;
      pass_rate: number;
      eval_count: number;
    }>;

    return rows.map((r) => ({
      timestamp: r.bucket,
      avgScore: Math.round(r.avg_score * 1000) / 1000,
      passRate: Math.round(r.pass_rate * 1000) / 1000,
      evalCount: r.eval_count,
      ...(cohortBy === undefined ? {} : { cohort: r.cohort }),
    }));
  }

  /**
   * One window's pass counts, so a drift comparison has denominators.
   *
   * Counts EVALUATIONS, not traces: an evaluation is the unit that passed
   * or failed, which is what the rate is a rate of. A run filter joins the
   * traces table for the same COALESCE every run read uses, so a
   * re-evaluation lands in the cohort it was written into.
   */
  /**
   * This agent's recent evaluated traces and what failed in each.
   *
   * Returned as a LOG rather than a collapsed "has this ever failed" answer,
   * because the moments list needs the answer AS OF each of up to two hundred
   * traces. Collapsing in SQL would mean one query per trace — two hundred
   * scans on a page render, each parsing a JSON blob per row. One query per
   * distinct agent, filtered by timestamp in memory, is the same answer for a
   * fraction of the work.
   *
   * Bounded, and the bound is real rather than defensive: this runs on a page
   * render and an agent with a hundred thousand evaluations would otherwise
   * make the list slower the longer someone has used the product. The cost is
   * that a rule which last failed very long ago can read as a first failure.
   * That is the right trade for a ranking signal, and it is why this drives
   * presentation and never a verdict.
   */
  async getAgentFailureLog(tenantId: TenantId, agentName: string, limit = 500): Promise<AgentFailureLogEntry[]> {
    assertTenant(tenantId);
    const rows = this.agentLogRows(tenantId, agentName, limit);

    // A trace evaluated more than once contributes ONE entry, its newest —
    // the same collapse every run read performs, for the same reason: a
    // re-evaluated trace is one trace, not two.
    const seen = new Set<string>();
    const out: AgentFailureLogEntry[] = [];
    for (const row of rows) {
      if (seen.has(row.trace_id)) continue;
      seen.add(row.trace_id);
      const results = parseRuleResults<{ ruleName: string; passed: boolean; skipped?: boolean }>(row.rule_results);
      out.push({
        traceId: row.trace_id,
        timestamp: row.timestamp,
        failed: results.filter((r) => r.skipped !== true && r.passed === false).map((r) => r.ruleName).sort(),
        costUsd: typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) ? row.cost_usd : null,
        judged: results.filter((r) => r.skipped !== true).map((r) => r.ruleName).sort(),
        runId: row.run_id ?? null,
      });
    }
    return out;
  }

  /**
   * The rows behind getAgentFailureLog: the newest `limit` evaluations of
   * this agent's traces, by trace time.
   *
   * There are two ways to find them, and which one is cheap depends on
   * what the store holds, not on its schema:
   *
   *   by evaluation  read every evaluation of the tenant, keep this agent's,
   *                  sort. Costs the tenant's evaluation count.
   *   by trace       walk this agent's traces newest first and look up each
   *                  one's evaluations, stopping at `limit`. Costs how far
   *                  back the limit-th evaluated trace lies, at most the
   *                  agent's trace count.
   *
   * At 100,000 traces the first takes 160 ms when every trace is evaluated
   * and the second 240 ms when few are; the other way round, each takes
   * under 3 ms. Left to SQLite, the choice followed the indexes instead:
   * 0.19.0 always read by evaluation, and the covering search index of
   * 0.20.0 (#658) flipped it to always walking the traces (#711). The
   * planner has no statistics here, and with them it walked the store where
   * every trace is evaluated (177 ms). So neither is left to the planner:
   * both queries pin their join order and index, and this chooses between
   * them from counts, which read index entries only (about a twentieth of a
   * step of either walk).
   *
   * It walks a window of the agent's newest traces, first four times the
   * limit. A window that holds `limit` evaluations is the answer. One that
   * does not says how dense they are, and the next window is sized to
   * reach `limit` at that density, at least four times the last. As soon
   * as the tenant's evaluations or the agent's traces fit in the window,
   * the smaller of the two is read whole instead. Every step costs about
   * its window, so the whole costs a small multiple of the cheaper way.
   *
   * Reading by evaluation, each evaluation's trace is found by its id:
   * the `+` keeps SQLite from answering `agent_name = ?` from the agent
   * index instead, which scans the agent's traces once per evaluation
   * (20 s at 14,000 of each).
   *
   * The window is cut at a timestamp, not a count, so traces tied at its
   * edge are all in it: every row outside it is older than every row in
   * it, and a window that yields `limit` rows yields the same rows as the
   * whole walk.
   */
  private agentLogRows(tenantId: TenantId, agentName: string, limit: number): AgentLogRow[] {
    const byEvaluation = this.db.prepare(
      `SELECT e.rule_results AS rule_results, e.run_id AS run_id, t.trace_id AS trace_id, t.timestamp AS timestamp, t.cost_usd AS cost_usd
         FROM eval_results e INDEXED BY idx_eval_results_tenant_trace
         CROSS JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
        WHERE e.tenant_id = ? AND +t.agent_name = ?
        ORDER BY t.timestamp DESC, e.created_at DESC
        LIMIT ?`,
    );
    const byTrace = this.db.prepare(
      `SELECT e.rule_results AS rule_results, e.run_id AS run_id, t.trace_id AS trace_id, t.timestamp AS timestamp, t.cost_usd AS cost_usd
         FROM traces t ${this.pinned('idx_traces_tenant_agent_timestamp')}
         CROSS JOIN eval_results e INDEXED BY idx_eval_results_tenant_trace ON e.tenant_id = t.tenant_id AND e.trace_id = t.trace_id
        WHERE t.tenant_id = ? AND t.agent_name = ? AND t.timestamp >= ?
        ORDER BY t.timestamp DESC, e.created_at DESC
        LIMIT ?`,
    );
    const evaluations = this.db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM eval_results INDEXED BY idx_eval_results_tenant_trace WHERE tenant_id = ? LIMIT ?)');
    const windowEdge = this.db.prepare(
      `SELECT timestamp FROM traces ${this.pinned('idx_traces_tenant_agent_timestamp')} WHERE tenant_id = ? AND agent_name = ? ORDER BY timestamp DESC LIMIT 1 OFFSET ?`,
    );
    const agentTraces = this.db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM traces ${this.pinned('idx_traces_tenant_agent_timestamp')} WHERE tenant_id = ? AND agent_name = ? LIMIT ?)`,
    );
    let window = 4 * Math.max(limit, 1);
    for (;;) {
      const evaluated = Number((evaluations.get(tenantId, window) as { n: number }).n);
      const traced = Number((agentTraces.get(tenantId, agentName, window) as { n: number }).n);
      if (evaluated < window || traced < window) {
        // One side fits in the window whole: read the smaller side (the walk by trace may stop sooner still).
        return traced <= evaluated ? (byTrace.all(tenantId, agentName, '', limit) as AgentLogRow[]) : (byEvaluation.all(tenantId, agentName, limit) as AgentLogRow[]);
      }
      const edge = windowEdge.get(tenantId, agentName, window - 1) as { timestamp: string };
      const rows = byTrace.all(tenantId, agentName, edge.timestamp, limit) as AgentLogRow[];
      if (rows.length >= limit) return rows;
      // At the rate this window held evaluations, `limit` of them lie about limit × window ÷ found traces back.
      window = Math.max(4 * window, Math.ceil((limit * window) / Math.max(rows.length, 1)));
    }
  }

  /*
   * Labels on the user's own traffic.
   *
   * One opinion per (evaluation, rule): labelling a fire that already
   * carries a label REPLACES it. A reader who changes their mind has one
   * current judgement, and counting both would weigh one fire twice in the
   * precision every verdict then reads.
   */
  async insertVerdictLabel(tenantId: TenantId, label: Omit<VerdictLabel, 'labelledAt'> & { labelledAt?: string }): Promise<VerdictLabel> {
    assertTenant(tenantId);
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    const labelledAt = label.labelledAt ?? new Date().toISOString();
    const write = this.db.transaction(() => {
      this.db.prepare('DELETE FROM verdict_labels WHERE tenant_id = ? AND eval_id = ? AND rule_name IS ?').run(tenantId, label.evalId, label.ruleName);
      this.db
        .prepare('INSERT INTO verdict_labels (id, tenant_id, eval_id, rule_name, label, note, labelled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(label.id, tenantId, label.evalId, label.ruleName, label.label, label.note, labelledAt);
    });
    write();
    return { id: label.id, evalId: label.evalId, ruleName: label.ruleName, label: label.label, note: label.note, labelledAt };
  }

  async getLabelsForEval(tenantId: TenantId, evalId: string): Promise<VerdictLabel[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare('SELECT id, eval_id, rule_name, label, note, labelled_at FROM verdict_labels WHERE tenant_id = ? AND eval_id = ? ORDER BY labelled_at DESC')
      .all(tenantId, evalId) as Array<{ id: string; eval_id: string; rule_name: string | null; label: 'right' | 'wrong'; note: string | null; labelled_at: string }>;
    return rows.map((r) => ({ id: r.id, evalId: r.eval_id, ruleName: r.rule_name, label: r.label, note: r.note, labelledAt: r.labelled_at }));
  }

  async labelTallies(tenantId: TenantId): Promise<LabelTallyRow[]> {
    assertTenant(tenantId);
    const rows = this.db
      .prepare(
        `SELECT rule_name, SUM(CASE WHEN label = 'right' THEN 1 ELSE 0 END) AS right, SUM(CASE WHEN label = 'wrong' THEN 1 ELSE 0 END) AS wrong
           FROM verdict_labels
          WHERE tenant_id = ? AND rule_name IS NOT NULL
          GROUP BY rule_name
          ORDER BY rule_name`,
      )
      .all(tenantId) as Array<{ rule_name: string; right: number; wrong: number }>;
    return rows.map((r) => ({ ruleName: r.rule_name, right: Number(r.right), wrong: Number(r.wrong) }));
  }

  /** The newest `window` evaluations' rule results, each with its id, time and agent — the one scan the fire rate and the issues share. */
  private recentRuleResults(
    tenantId: TenantId,
    window: number,
  ): Array<{ id: string; traceId: string | null; createdAt: string; agent: string | null; results: Array<{ ruleName: string; passed: boolean; skipped?: boolean; evidence?: unknown[]; message?: string }> }> {
    const rows = this.db
      .prepare(
        `SELECT e.id AS id, e.trace_id AS trace_id, e.rule_results AS rule_results, e.created_at AS created_at, t.agent_name AS agent_name
           FROM eval_results e
           LEFT JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
          WHERE e.tenant_id = ?
          ORDER BY e.created_at DESC
          LIMIT ?`,
      )
      .all(tenantId, Math.max(1, Math.floor(window))) as Array<{ id: string; trace_id: string | null; rule_results: string | null; created_at: string; agent_name: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      createdAt: row.created_at,
      agent: row.agent_name,
      results: parseRuleResults<{ ruleName: string; passed: boolean; skipped?: boolean; evidence?: unknown[]; message?: string }>(row.rule_results),
    }));
  }

  async ruleFireStats(tenantId: TenantId, window: number): Promise<RuleFireStat[]> {
    assertTenant(tenantId);
    const stats = new Map<string, RuleFireStat>();
    for (const row of this.recentRuleResults(tenantId, window)) {
      for (const r of row.results) {
        if (r.skipped === true) continue;
        const s = stats.get(r.ruleName) ?? { ruleName: r.ruleName, judged: 0, fired: 0 };
        s.judged += 1;
        if (r.passed === false) s.fired += 1;
        stats.set(r.ruleName, s);
      }
    }
    return [...stats.values()].sort((a, b) => a.ruleName.localeCompare(b.ruleName));
  }

  async listIssues(tenantId: TenantId, window: number, options: { rule?: string; limit?: number } = {}): Promise<IssueGroup[]> {
    assertTenant(tenantId);
    const labels = new Map<string, 'right' | 'wrong'>();
    for (const l of this.db
      .prepare("SELECT eval_id, rule_name, label FROM verdict_labels WHERE tenant_id = ? AND rule_name IS NOT NULL")
      .all(tenantId) as Array<{ eval_id: string; rule_name: string; label: 'right' | 'wrong' }>) {
      labels.set(`${l.eval_id}|${l.rule_name}`, l.label);
    }
    const groups = new Map<string, IssueGroup>();
    // Rows arrive newest first, so the first sighting of a group is its lastSeen and every later one pushes firstSeen back.
    for (const row of this.recentRuleResults(tenantId, window)) {
      for (const r of row.results) {
        if (r.skipped === true || r.passed !== false) continue;
        if (options.rule !== undefined && r.ruleName !== options.rule) continue;
        const signature = evidenceSignature({ evidence: r.evidence as never, message: r.message ?? '' });
        const key = issueKey(r.ruleName, signature);
        const g: IssueGroup = groups.get(key) ?? { key, ruleName: r.ruleName, signature, count: 0, agents: [], firstSeen: row.createdAt, lastSeen: row.createdAt, exampleEvalIds: [], exampleTraceIds: [], labelled: { right: 0, wrong: 0 } };
        g.count += 1;
        g.firstSeen = row.createdAt;
        if (row.agent !== null && !g.agents.includes(row.agent)) g.agents.push(row.agent);
        if (g.exampleEvalIds.length < 5) {
          g.exampleEvalIds.push(row.id);
          g.exampleTraceIds.push(row.traceId);
        }
        const l = labels.get(`${row.id}|${r.ruleName}`);
        if (l === 'right') g.labelled.right += 1;
        else if (l === 'wrong') g.labelled.wrong += 1;
        groups.set(key, g);
      }
    }
    const out = [...groups.values()].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.key.localeCompare(b.key));
    return options.limit !== undefined ? out.slice(0, Math.max(0, options.limit)) : out;
  }

  async getDriftWindow(tenantId: TenantId, since: string, until: string | null, run?: string): Promise<DriftWindow> {
    assertTenant(tenantId);
    const where: string[] = ['e.tenant_id = ?', 'e.created_at >= ?'];
    const params: unknown[] = [tenantId, since];
    if (until !== null) {
      where.push('e.created_at < ?');
      params.push(until);
    }
    if (run !== undefined) {
      where.push('COALESCE(e.run_id, t.run_id) = ?');
      params.push(run);
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS evaluated,
                SUM(CASE WHEN e.passed = 1 THEN 1 ELSE 0 END) AS passed
           FROM eval_results e
           LEFT JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
          WHERE ${where.join(' AND ')}`,
      )
      .get(...params) as { evaluated: number; passed: number | null };

    const evaluated = Number(row.evaluated ?? 0);
    const passed = Number(row.passed ?? 0);
    return {
      since,
      until,
      evaluated,
      passed,
      // "0 of 0" is unknown, not zero. A window with nothing in it that
      // reported a rate of 0 would draw a cliff on the chart.
      passRate: evaluated > 0 ? passed / evaluated : null,
    };
  }

  async getEvalStatsRules(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStatsRuleBreakdown[]> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    const rows = this.db.prepare(`
      SELECT rule_results
      FROM eval_results INDEXED BY idx_eval_results_tenant_created
      WHERE tenant_id = ? AND created_at >= ?
    `).all(tenantId, since) as Array<{ rule_results: string }>;

    const ruleMap = new Map<string, { totalRun: number; failCount: number }>();

    for (const row of rows) {
      const rules = parseRuleResults<{ ruleName: string; passed: boolean; skipped?: boolean }>(row.rule_results);
      for (const r of rules) {
        if (r.skipped) continue;
        const entry = ruleMap.get(r.ruleName) ?? { totalRun: 0, failCount: 0 };
        entry.totalRun++;
        if (!r.passed) entry.failCount++;
        ruleMap.set(r.ruleName, entry);
      }
    }

    const result: EvalStatsRuleBreakdown[] = [];
    for (const [rule, stats] of ruleMap) {
      result.push({
        rule,
        passRate: stats.totalRun > 0
          ? Math.round(((stats.totalRun - stats.failCount) / stats.totalRun) * 1000) / 1000
          : 0,
        totalRun: stats.totalRun,
        failCount: stats.failCount,
      });
    }

    result.sort((a, b) => a.passRate - b.passRate);

    return result;
  }

  async getEvalStatsFailures(tenantId: TenantId, period: EvalStatsPeriod, limit: number): Promise<EvalStatsFailure[]> {
    assertTenant(tenantId);
    const since = this.periodToSince(period);

    const rows = this.db.prepare(`
      SELECT
        e.trace_id,
        COALESCE(t.agent_name, 'unknown') AS agent_name,
        e.rule_results,
        e.score,
        e.output_text,
        e.created_at
      FROM eval_results e
      LEFT JOIN traces t ON t.tenant_id = e.tenant_id AND t.trace_id = e.trace_id
      WHERE e.tenant_id = ? AND e.created_at >= ?
        AND e.passed = 0
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(tenantId, since, limit) as Array<{
      trace_id: string | null;
      agent_name: string;
      rule_results: string;
      score: number;
      output_text: string;
      created_at: string;
    }>;

    return rows.map((r) => {
      const rules = parseRuleResults<{ ruleName: string; passed: boolean }>(r.rule_results);
      const failingRule = rules.find((rule) => !rule.passed);

      return {
        traceId: r.trace_id ?? '',
        agent: r.agent_name,
        rule: failingRule?.ruleName ?? 'unknown',
        score: Math.round(r.score * 1000) / 1000,
        output: r.output_text.length > 200 ? r.output_text.slice(0, 200) + '...' : r.output_text,
        timestamp: r.created_at,
      };
    });
  }

  /** Run a sweep so close() can wait for it to stop at its next step. */
  private async tracked<T>(sweep: Promise<T>): Promise<T> {
    this.sweeps.add(sweep);
    try {
      return await sweep;
    } finally {
      this.sweeps.delete(sweep);
    }
  }

  /**
   * The retention sweep of traces, in steps: a few traces per transaction,
   * sized to stay under BUILD_STEP_MS from the last step's work and time, with the
   * event loop free between steps, so the server answers while it runs. It
   * was one transaction, and at 100,000 agent-loop traces a sweep of 3% held
   * the event loop for seconds (search-index.ts, the retention sweep, says
   * how each step erases the index). Resumable: a closing server stops it at
   * its next step, and the next sweep deletes what is still past the window.
   * Resolves when the swept traces are erased from the index too.
   */
  async deleteTracesOlderThan(tenantId: TenantId, days: number): Promise<number> {
    assertTenant(tenantId);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.tracked(this.sweepTraces(tenantId, cutoff));
  }

  private async sweepTraces(tid: TenantId, cut: string): Promise<number> {
    if (this.closing) return 0;
    this.ensureCheckpointer();
    if (this.filterIndex || this.readPaths) await this.indexesAfterStart();
    const indexing = this.indexKept;
    const mode = indexing
      ? sweepEraseMode(
          Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${SEARCH_DOCS_TABLE} d JOIN traces t ON t.trace_id = d.trace_id WHERE t.tenant_id = ? AND t.timestamp < ?`).get(tid, cut) as { n: number }).n),
          Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${SEARCH_DOCS_TABLE}`).get() as { n: number }).n),
        )
      : 'rows';
    const pick = this.db.prepare('SELECT rowid AS r, trace_id FROM traces WHERE tenant_id = ? AND timestamp < ? LIMIT ?');
    const remove = this.db.prepare('DELETE FROM traces WHERE rowid IN (SELECT value FROM json_each(?))');
    const step = this.db.transaction((max: number): number => {
      const rows = pick.all(tid, cut, max) as Array<{ r: number; trace_id: string }>;
      if (rows.length === 0) return 0;
      // Same erasure as deleteTrace: an evaluation younger than the window
      // whose trace is swept keeps its verdict and loses its text.
      this.eraseEvaluationsOfTraces(tid, rows.map((r) => r.trace_id));
      const run = () => remove.run(JSON.stringify(rows.map((r) => Number(r.r)))).changes;
      return indexing && mode === 'merge' ? deleteOwingMerge(this.db, run) : run();
    });
    let deleted = 0;
    let batch = SWEEP_BATCH;
    while (!this.closing) {
      await this.beforeWriteStep();
      const started = performance.now();
      const n = step.immediate(batch);
      if (n === 0) break;
      deleted += n;
      batch = nextStepSize(batch, performance.now() - started, SWEEP_BATCH_RANGE);
      await yieldToRequests();
    }
    if (indexing && mergeOwed(this.db)) await this.settleOwedMerge();
    return deleted;
  }

  async deleteEvalResultsOlderThan(tenantId: TenantId, days: number): Promise<number> {
    assertTenant(tenantId);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.tracked(this.sweepEvalResults(tenantId, cutoff));
  }

  /** The evaluation sweep, in steps like the trace sweep. */
  private async sweepEvalResults(tid: TenantId, cut: string): Promise<number> {
    /*
     * created_at, not the linked trace's timestamp: an unlinked eval has
     * no trace, and a linked one whose trace was already swept has a NULL
     * trace_id — either way the eval's own age is the only age it has.
     * Rows are ISO-8601 here (write path + migration 005), so the string
     * comparison against an ISO cutoff is exact.
     */
    const remove = this.db.prepare('DELETE FROM eval_results WHERE rowid IN (SELECT rowid FROM eval_results WHERE tenant_id = ? AND created_at < ? LIMIT ?)');
    let deleted = 0;
    let batch = EVAL_SWEEP_BATCH;
    while (!this.closing) {
      await this.beforeWriteStep();
      const started = performance.now();
      const n = remove.run(tid, cut, batch).changes;
      if (n === 0) break;
      deleted += n;
      batch = nextStepSize(batch, performance.now() - started, EVAL_SWEEP_BATCH_RANGE);
      await yieldToRequests();
    }
    return deleted;
  }

  async purge(tenantId: TenantId): Promise<{ traces: number; evalResults: number }> {
    assertTenant(tenantId);
    // After any TRUNCATE in flight (insertTraces says why).
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    const deleteAll = this.db.transaction(() => {
      const evalResults = this.db.prepare('DELETE FROM eval_results WHERE tenant_id = ?').run(tenantId).changes;
      // spans cascade (FK ON DELETE CASCADE).
      const remove = () => this.db.prepare('DELETE FROM traces WHERE tenant_id = ?').run(tenantId).changes;
      const indexed = this.indexKept ? Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${SEARCH_DOCS_TABLE} WHERE tenant_id = ?`).get(tenantId) as { n: number }).n) : 0;
      const traces = this.indexKept ? bulkIndexDelete(this.db, indexed, remove) : remove();
      return { traces, evalResults };
    });
    const counts = deleteAll();
    /*
     * VACUUM rebuilds the file from the live rows only — the freed pages
     * (already zeroed by secure_delete) are dropped rather than kept as
     * free-list slack — and the TRUNCATE checkpoint then folds the WAL into
     * the main file and cuts it to zero bytes, so neither iris.db nor
     * iris.db-wal keeps a copy of what was just deleted. Skipped for
     * :memory: (nothing on disk to clean).
     */
    if (this.dbPath !== ':memory:') {
      this.db.exec('VACUUM');
    }
    await this.checkpoint();
    return counts;
  }

  /**
   * Copy the WAL into iris.db and empty it, so deleted rows survive in
   * neither (the retention sweep and --purge call this after they delete).
   * The same route as delete_trace's, tried now and, while a reader holds
   * it off, again until nothing is reading (eraseFromFile); on the
   * checkpoint worker's connection when it runs, since after a sweep the
   * log can be large and copying it is not a delete's few pages.
   */
  async checkpoint(): Promise<void> {
    // What waits on the search index queue is written first (#729), so the indexer's next step does not refill the log this empties.
    if (this.indexKept && !this.closing) await this.drainQueue(Infinity);
    await this.eraseFromFile(true);
  }

  async deleteTrace(tenantId: TenantId, traceId: string): Promise<boolean> {
    assertTenant(tenantId);
    // Tenant-scoped: a trace id owned by a different tenant is
    // untouchable from this call. Cross-tenant deletions are not just
    // denied — they're invisible (no indication the id even exists).
    //
    // The right-to-erasure fix: eval_results.trace_id is ON DELETE SET
    // NULL, so the delete alone left every linked evaluation behind with
    // output_text verbatim — including what no_pii had flagged — orphaned
    // and readable. The text is erased in the same transaction, BEFORE the
    // FK can orphan the rows.
    const run = this.db.transaction((tid: TenantId, id: string): number => {
      const exists = this.db.prepare('SELECT 1 FROM traces WHERE tenant_id = ? AND trace_id = ?').get(tid, id);
      if (!exists) return 0;
      this.eraseEvaluationsOfTraces(tid, [id]);
      return this.db.prepare('DELETE FROM traces WHERE tenant_id = ? AND trace_id = ?').run(tid, id).changes;
    });
    /*
     * Read-then-write under IMMEDIATE, so the write lock is taken before the
     * read. Deferred, a TRUNCATE the checkpoint worker ran between the read
     * and the write (an erasure it was just asked for) moved the log under
     * the read's snapshot, and the delete failed with "database is locked"
     * at once, without waiting: the stress test hit it 3 times in 26
     * runs. A TRUNCATE already in flight is waited out here, off the event
     * loop, rather than in the busy handler, on it.
     */
    while (this.checkpointer?.truncateInProgress) await this.checkpointer.whenTruncated();
    const deleted = run.immediate(tenantId, traceId) > 0;
    /*
     * secure_delete zeroes the freed pages, but in WAL mode the zeroed
     * pages go to the WAL and iris.db keeps the old ones, with the trace's
     * text on them, until a checkpoint copies them back (#703). The
     * retention sweep and --purge checkpoint after they delete; so does
     * this, so the text is gone from the file when the call returns, not at
     * some later checkpoint. TRUNCATE also empties the WAL, which held the
     * text again if the trace was written since the last checkpoint.
     */
    if (deleted) await this.eraseFromFile();
    return deleted;
  }

  /**
   * Copy freed pages into iris.db and empty the WAL, now if nothing is
   * reading the file, else as soon as nothing is. A TRUNCATE checkpoint
   * waits for every reader that started before it, and the search worker
   * is one: waiting here held the event loop for the rest of that search
   * (500 to 600 ms for the costliest at 100,000 traces, measured on the
   * machine in the changelog). So it is tried without waiting, and while a
   * reader holds it off, tried again every ERASE_RETRY_MS, off the event
   * loop's back; close() makes the last try, after the worker has closed.
   */
  private async eraseFromFile(onWorker = false): Promise<void> {
    if (this.dbPath === ':memory:' || this.closing || (await this.truncateCheckpointNow(onWorker))) return;
    /*
     * Held off. The checkpoint worker's own work can do that: its
     * connection opening (it starts at the store's first write, so a delete
     * straight after that write meets it) or a copy in progress. Both are
     * short, and a TRUNCATE sent to the worker runs as soon as they end, so
     * the worker is waited for and asked before anything is treated as a
     * reader to wait out. On a Windows CI runner with the built-in driver,
     * two erasures met the worker still opening its connection.
     */
    const worker = this.checkpointer;
    if (worker && !this.closing && (await worker.whenStarted())) {
      /*
       * And for up to ERASE_WAIT_MS more, tried again on the worker every
       * ERASE_RETRY_MS, with the event loop free: under the stress test a
       * hold on the file that neither connection's attempt names outlasted
       * the first try by tens of milliseconds (both TRUNCATEs busy, 10 ms
       * apart, and the retry succeeding later), on Linux with the built-in
       * driver. A reader that holds the file longer, a search, is left to
       * the retry below, as before.
       */
      const until = performance.now() + ERASE_WAIT_MS;
      for (;;) {
        if (this.closing) break;
        if (await this.truncateCheckpointNow(true)) return;
        if (performance.now() + ERASE_RETRY_MS > until) break;
        await new Promise((r) => setTimeout(r, ERASE_RETRY_MS));
      }
    }
    let trying = false;
    this.eraseRetry ??= setInterval(() => {
      if (trying) return;
      trying = true;
      void this.truncateCheckpointNow(onWorker).then((done) => {
        trying = false;
        if (!done && !this.closing) return;
        clearInterval(this.eraseRetry);
        this.eraseRetry = undefined;
      });
    }, ERASE_RETRY_MS).unref();
  }

  /**
   * A TRUNCATE checkpoint that gives up at once rather than wait for a
   * reader; whether it emptied the WAL. `onWorker`: on the checkpoint
   * worker's connection when it runs (checkpointer.ts), so copying a large
   * log never holds the event loop. A delete's own erasure is tried on this
   * connection first: its log is a few pages, and it should not wait behind
   * the worker's periodic checkpoint for its answer unless this connection
   * was held off (eraseFromFile).
   */
  private async truncateCheckpointNow(onWorker = false): Promise<boolean> {
    if (onWorker && this.checkpointer?.active) {
      try {
        return await this.checkpointer.truncate();
      } catch {
        // The worker stopped mid-request: this connection takes over, below.
      }
    }
    return this.truncateCheckpointHere();
  }

  private truncateCheckpointHere(): boolean {
    this.db.pragma('busy_timeout = 0');
    try {
      const out = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number } | Array<{ busy: number }> | undefined;
      const row = Array.isArray(out) ? out[0] : out;
      return row !== undefined && Number(row.busy) === 0;
    } catch {
      return false;
    } finally {
      this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  /**
   * Blank every text field of the evaluations linked to these traces and
   * stamp erased_at (migration 007). Verdict, scores, criticality and the
   * evidence OFFSETS stay — they carry no text — so history and drift
   * analytics keep working over an erased row.
   */
  private eraseEvaluationsOfTraces(tenantId: TenantId, traceIds: readonly string[]): number {
    if (traceIds.length === 0) return 0;
    const now = new Date().toISOString();
    const select = this.db.prepare('SELECT id, rule_results FROM eval_results WHERE tenant_id = ? AND trace_id = ?');
    const update = this.db.prepare(
      'UPDATE eval_results SET output_text = ?, expected_text = NULL, suggestions = ?, rule_results = ?, erased_at = ? WHERE tenant_id = ? AND id = ?',
    );
    let erased = 0;
    for (const traceId of traceIds) {
      for (const row of select.all(tenantId, traceId) as Array<{ id: string; rule_results: string }>) {
        const rules = parseRuleResults<EvalRuleResult>(row.rule_results);
        const erasedRules = rules.map((r) => ({
          ...r,
          message: ERASED_MESSAGE,
          ...(r.skipReason ? { skipReason: ERASED_MESSAGE } : {}),
        }));
        update.run('', '[]', JSON.stringify(erasedRules), now, tenantId, row.id);
        erased += 1;
      }
    }
    return erased;
  }

  /**
   * storage.redact = 'critical_spans': the spans a critical detector fired
   * on are replaced in the STORED text by [REDACTED:<pattern>]. The
   * evidence offsets are left as computed — they index the text the caller
   * saw, which is what a reader of the evidence needs — and the option's
   * documentation says so.
   *
   * ONLY spans into the agent's own output, and from 0.11.0 that is a
   * decision rather than an accident. `no_injection_compliance` is the first
   * rule to report a span whose source is `tool_outputs[i]`, and those
   * offsets index a TOOL RESULT, not this text — splicing them here would
   * corrupt stored output at meaningless positions. The filter below is what
   * stops that, and the test in tests/unit/storage/redact.test.ts is what
   * keeps it stopped.
   *
   * The trace itself is deliberately NOT redacted, and this is a stated
   * non-goal rather than an omission: an injected payload inside a stored
   * tool result is the RECORD OF THE ATTACK. Stripping it would destroy the
   * evidence that the verdict points at, leaving a finding whose subject no
   * longer exists. A deployment that must not retain such text deletes the
   * trace, which erases it.
   */
  private storedOutputText(result: EvalResult): string | null {
    const text = result.output_text;
    if (this.redact !== 'critical_spans' || !text) return text ?? null;
    const spans = result.rule_results
      .filter((r) => r.critical === true && !r.passed && !r.skipped)
      // `source === 'output'` is load-bearing: see the note above.
      .flatMap((r) => (r.evidence ?? []).filter((e): e is Extract<Evidence, { type: 'span' }> => e.type === 'span' && e.source === 'output'));
    if (spans.length === 0) return text;
    const seen = new Set<string>();
    let out = text;
    for (const s of [...spans].sort((a, b) => b.start - a.start)) {
      const key = `${s.start}:${s.end}`;
      if (seen.has(key) || s.start >= s.end || s.end > out.length) continue;
      seen.add(key);
      out = `${out.slice(0, s.start)}[REDACTED:${s.label}]${out.slice(s.end)}`;
    }
    return out;
  }

  async getDistinctValues(tenantId: TenantId, column: string): Promise<string[]> {
    assertTenant(tenantId);
    /*
     * A skip scan of the (tenant, column) index: seek the smallest value,
     * then the smallest value above it, and so on — one index seek per
     * distinct value, however many traces carry each (#711). SELECT
     * DISTINCT read every trace of the tenant instead: 0.2 to 0.4 s at
     * 100,000 traces for seven agents and two frameworks, on every
     * dashboard load.
     */
    const indexes: Record<string, string> = {
      agent_name: 'idx_traces_tenant_agent_timestamp',
      framework: 'idx_traces_tenant_framework',
    };
    const index = indexes[column];
    if (!index) {
      throw new Error(`Column '${column}' is not queryable (allowed: ${Object.keys(indexes).join(', ')})`);
    }
    const rows = this.db
      .prepare(
        `WITH RECURSIVE v(value) AS (
           SELECT MIN(${column}) FROM traces ${this.pinned(index)} WHERE tenant_id = ? AND ${column} IS NOT NULL
           UNION ALL
           SELECT (SELECT MIN(${column}) FROM traces ${this.pinned(index)} WHERE tenant_id = ? AND ${column} > v.value) FROM v WHERE v.value IS NOT NULL
         )
         SELECT value FROM v WHERE value IS NOT NULL ORDER BY value`,
      )
      .all(tenantId, tenantId) as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }

  private rowToTrace(row: Record<string, unknown>): Trace {
    return {
      trace_id: row.trace_id as string,
      agent_name: row.agent_name as string,
      framework: row.framework as string | undefined,
      input: row.input as string | undefined,
      output: row.output as string | undefined,
      tool_calls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      latency_ms: row.latency_ms as number | undefined,
      token_usage: row.token_usage ? JSON.parse(row.token_usage as string) : undefined,
      cost_usd: row.cost_usd as number | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      timestamp: row.timestamp as string,
      created_at: row.created_at as string,
      tools: row.tools ? JSON.parse(row.tools as string) : undefined,
      run_id: (row.run_id as string | null) ?? undefined,
      case_key: (row.case_key as string | null) ?? undefined,
      ...(row.session_id != null ? { session_id: row.session_id as string } : {}),
      ...(row.source != null ? { source: row.source as Trace['source'] } : {}),
      /*
       * A cost stored before migration 016 has no source column value, and
       * was reported: no version before 0.20.0 estimated one. Read so,
       * rather than rewritten at upgrade (016 says why).
       */
      ...(row.cost_source != null ? { cost_source: row.cost_source as Trace['cost_source'] } : row.cost_usd != null ? { cost_source: 'reported' as const } : {}),
      ...(row.cost_estimate != null ? { cost_estimate: JSON.parse(row.cost_estimate as string) as Trace['cost_estimate'] } : {}),
    };
  }

  private rowToSpan(row: Record<string, unknown>): Span {
    return {
      span_id: row.span_id as string,
      trace_id: row.trace_id as string,
      parent_span_id: row.parent_span_id as string | undefined,
      name: row.name as string,
      kind: row.kind as Span['kind'],
      status_code: row.status_code as Span['status_code'],
      status_message: row.status_message as string | undefined,
      start_time: row.start_time as string,
      end_time: row.end_time as string | undefined,
      attributes: row.attributes ? JSON.parse(row.attributes as string) : undefined,
      events: row.events ? JSON.parse(row.events as string) : undefined,
    };
  }

  private rowToEvalResult(row: Record<string, unknown>): EvalResult {
    const result: EvalResult = {
      id: row.id as string,
      trace_id: row.trace_id as string | undefined,
      eval_type: row.eval_type as EvalResult['eval_type'],
      /*
       * `categories` is not a column: an eval_type="all" row carries a
       * `category` on every rule_results entry instead, so a reader can
       * regroup the per-bundle breakdown from what IS stored.
       */
      output_text: row.output_text as string,
      expected_text: (row.expected_text as string | null | undefined) ?? undefined,
      ...(row.erased_at ? { erased_at: row.erased_at as string } : {}),
      score: row.score as number,
      passed: (row.passed as number) === 1,
      rule_results: parseRuleResults(row.rule_results),
      created_at: row.created_at as string,
      rules_evaluated: row.rules_evaluated as number | undefined,
      rules_skipped: row.rules_skipped as number | undefined,
      insufficient_data: row.insufficient_data != null ? (row.insufficient_data as number) === 1 : undefined,
      /*
       * Absent, not [], when NULL. Rows written before migration 006 never
       * captured the field, and returning an empty array would assert "no
       * critical rule failed" about an evaluation that never recorded one.
       */
      ...(row.critical_failures != null
        ? { critical_failures: JSON.parse(row.critical_failures as string) as string[] }
        : {}),
      ...(row.eval_cost_usd != null ? { eval_cost_usd: row.eval_cost_usd as number } : {}),
      ...(row.eval_tokens != null ? { eval_tokens: row.eval_tokens as number } : {}),
      ...(row.provenance != null ? { provenance: JSON.parse(row.provenance as string) as Provenance } : {}),
    };
    /*
     * Derived on every read, never stored (0.9.0): the critical rules that
     * skipped (from the stamped flags — absent for rows older than those
     * flags, never []), the coverage by question, and the verdict with its
     * basis — the last only when the row carries the threshold it was judged
     * against, because a basis guessed against today's threshold would be a
     * fabrication about that day.
     */
    const criticalSkipped = deriveCriticalSkipped(result.rule_results);
    if (criticalSkipped) result.critical_skipped = criticalSkipped;
    if (result.rule_results.some((r) => r.question !== undefined)) result.coverage = deriveCoverage(result.rule_results);
    /*
     * Read back under the SAME composer facts that wrote it, or a stored row
     * would report a different verdict than the one the caller was given.
     * Until 0.13.0 the config was not stored (only its hash), so every read
     * re-composed under the shipped defaults — a deployment with its own
     * loss ratio saw one verdict on the tool and another on the dashboard.
     * provenance.composer now carries the three facts the composer needs;
     * a row written before it exists reads back under the defaults and
     * with an empty interpretations list — absent, never fabricated.
     *
     * Two facts joined them in 0.19.0. priorMode: without it a row judged
     * under eval.priorMode "per-class" read back under the per-output
     * default and could flip from fail to pass. calibration: the confidence
     * label is re-derived only under the calibration table it was given
     * with; a row stamped under another table, or before the stamp existed,
     * reads back with no label and a note saying why, instead of silently
     * taking the label today's table would give.
     */
    if (result.provenance) {
      const cfg = composeConfigOf(result.provenance);
      // The estimate stored with the row (migration 018): used only if this row's inputs give the key it was stored under.
      if (typeof row.risk_estimate === 'string') {
        try {
          rememberRiskEstimate(JSON.parse(row.risk_estimate));
        } catch {
          // Unreadable: the estimate is computed instead.
        }
      }
      result.verdict = compose(result, cfg);
      if (result.provenance.composer) {
        const notes = interpretations(result, result.verdict, cfg);
        if (notes.length > 0) result.interpretations = notes;
      }
    }
    return result;
  }
}
