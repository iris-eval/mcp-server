/*
 * The relevance judge's spend guards.
 *
 * The relevance judge calls a provider on the user's own key once per
 * evaluation that carries an input, and evaluations arrive from every door:
 * evaluate_output, log_trace, an OTLP batch of up to 2,000 traces, an
 * evaluate_runs re-score of a whole run. The per-call cap
 * (IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL) bounds one call; nothing bounded
 * the sum. Two limits do now, and each one, when it stops a call, leaves
 * the evaluation to answers_the_ask's lexical reading with the reason on the
 * result — a verdict is never withheld for money, only the judge is:
 *
 *   IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD      what the judge may spend per
 *     UTC day, per tenant. Counted in the database beside the traces, so a
 *     restart, a second server or a CLI ingest on the same file all draw on
 *     one balance. A call is admitted only when its WORST case (the same
 *     pessimistic two-attempt estimate the per-call cap uses) fits in what
 *     is left, then the reservation is replaced by the provider's actual
 *     cost — so the budget is a ceiling, never a target to overshoot.
 *   IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST  judge calls one request may
 *     make, so one batch cannot spend the day's budget in one go.
 *
 * UTC days rather than a rolling window: the providers' usage pages report
 * by UTC day, so the number Iris shows is the number the bill shows, and
 * "resets at 00:00 UTC" is a promise a user can check.
 */
import type { TenantId } from '../../types/tenant.js';

export const DAILY_BUDGET_VAR = 'IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD';
export const MAX_CALLS_PER_REQUEST_VAR = 'IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST';

/**
 * 1 USD a day. Low on purpose: the judge is opted into by naming a model,
 * and a user who did that for a handful of evaluations must not find a
 * surprise on their bill because an SDK started sending every call. The
 * worst case of one relevance judgment on claude-haiku-4-5 is $0.0060 on
 * the proof cases (tests/unit/proof/relevance-judge-proof.test.ts), so a
 * dollar admits at least 165 judgments a day before any reservation is
 * settled down to its actual cost; a deployment that wants more raises it.
 */
export const DEFAULT_DAILY_BUDGET_USD = 1;

/**
 * 20 judge calls per request. The SDK flushes every 250 ms, so a batch
 * from a live agent is normally a few traces; 20 covers that and caps a
 * 2,000-trace OTLP request or a whole-run re-score at 20 calls.
 */
export const DEFAULT_MAX_CALLS_PER_REQUEST = 20;

/** Spend is kept in whole micro-dollars so a day's total never drifts with floating point. */
const MICRO = 1_000_000;
export const toMicroUsd = (usd: number): number => Math.ceil(usd * MICRO - 1e-6);
export const fromMicroUsd = (micro: number): number => micro / MICRO;

export interface Setting<T> {
  value: T;
  source: 'default' | 'env';
  /** Set when the variable held something unusable and the default stands in its place. */
  note?: string;
}

/** The daily budget from the environment: any number ≥ 0 (0 stops every judge call), else the default. */
export function dailyBudgetUsd(): Setting<number> {
  const raw = process.env.IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD?.trim();
  if (!raw) return { value: DEFAULT_DAILY_BUDGET_USD, source: 'default' };
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return { value: n, source: 'env' };
  return {
    value: DEFAULT_DAILY_BUDGET_USD,
    source: 'default',
    note: `${DAILY_BUDGET_VAR}="${raw.slice(0, 40)}" is not a number of dollars ≥ 0, so the default ${DEFAULT_DAILY_BUDGET_USD} USD applies`,
  };
}

/** The per-request call cap from the environment: a whole number ≥ 0 (0 stops every judge call), else the default. */
export function maxCallsPerRequest(): Setting<number> {
  const raw = process.env.IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST?.trim();
  if (!raw) return { value: DEFAULT_MAX_CALLS_PER_REQUEST, source: 'default' };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return { value: n, source: 'env' };
  return {
    value: DEFAULT_MAX_CALLS_PER_REQUEST,
    source: 'default',
    note: `${MAX_CALLS_PER_REQUEST_VAR}="${raw.slice(0, 40)}" is not a whole number ≥ 0, so the default ${DEFAULT_MAX_CALLS_PER_REQUEST} applies`,
  };
}

/** One tenant's spend on one UTC day. */
export interface DaySpend {
  spentMicroUsd: number;
  /** Judge calls settled that day. */
  calls: number;
  /** Calls refused because the worst case did not fit. */
  refused: number;
}

/**
 * Where the spend is kept. Every method is one atomic step: the SQLite
 * ledger does each in a single statement (src/storage/judge-spend.ts), so
 * two processes on one database cannot both spend the last dollar.
 */
export interface JudgeSpendLedger {
  /** Add `microUsd` to the day if the total stays within `limitMicroUsd`; true when added. A refusal is counted. */
  reserve(tenantId: TenantId, day: string, microUsd: number, limitMicroUsd: number): boolean;
  /** Correct a reservation by `deltaMicroUsd` (negative gives some back), counting a call when one was made. */
  settle(tenantId: TenantId, day: string, deltaMicroUsd: number, called: boolean): void;
  read(tenantId: TenantId, day: string): DaySpend;
}

/** A ledger in this process only: for an embedder with no database. The server and the CLI never use it. */
export function memoryJudgeSpendLedger(): JudgeSpendLedger {
  const days = new Map<string, DaySpend>();
  const row = (tenantId: TenantId, day: string): DaySpend => {
    const key = `${tenantId}\u0000${day}`;
    let r = days.get(key);
    if (!r) {
      r = { spentMicroUsd: 0, calls: 0, refused: 0 };
      days.set(key, r);
    }
    return r;
  };
  return {
    reserve(tenantId, day, microUsd, limitMicroUsd) {
      const r = row(tenantId, day);
      if (r.spentMicroUsd + microUsd > limitMicroUsd) {
        r.refused += 1;
        return false;
      }
      r.spentMicroUsd += microUsd;
      return true;
    },
    settle(tenantId, day, deltaMicroUsd, called) {
      const r = row(tenantId, day);
      r.spentMicroUsd = Math.max(0, r.spentMicroUsd + deltaMicroUsd);
      if (called) r.calls += 1;
    },
    read(tenantId, day) {
      return { ...row(tenantId, day) };
    },
  };
}

/** The UTC day a moment falls on, as the ledger keys it. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** When that UTC day ends. */
export function nextUtcMidnight(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** A reservation the judge holds while its call is in flight. */
export interface BudgetTicket {
  tenantId: TenantId;
  day: string;
  reservedMicroUsd: number;
}

export interface BudgetToday {
  day: string;
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  calls: number;
  refused: number;
  /** Nothing is left, or the budget has refused a call today: the judge is, or has been, off for this tenant today. */
  exhausted: boolean;
  resetsAt: string;
}

export interface JudgeBudgetOptions {
  dailyUsd: number;
  ledger: JudgeSpendLedger;
  now?: () => Date;
  /** One line when a tenant's budget first refuses a call on a given day. */
  log?: (line: string) => void;
}

export class JudgeBudget {
  readonly dailyUsd: number;
  private readonly limitMicroUsd: number;
  private readonly ledger: JudgeSpendLedger;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  /** tenant + day pairs this process has already logged a refusal for. */
  private readonly announced = new Set<string>();

  constructor(options: JudgeBudgetOptions) {
    this.dailyUsd = options.dailyUsd;
    this.limitMicroUsd = Math.floor(options.dailyUsd * MICRO + 1e-6);
    this.ledger = options.ledger;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /**
   * Reserve a call's worst case against today's budget. On refusal the
   * reason is a sentence for the judge record: what was left, what the
   * call could cost, when the budget resets and how to raise it.
   */
  reserve(tenantId: TenantId, worstCaseUsd: number): { ok: true; ticket: BudgetTicket } | { ok: false; reason: string } {
    const now = this.now();
    const day = utcDay(now);
    const micro = toMicroUsd(worstCaseUsd);
    if (this.ledger.reserve(tenantId, day, micro, this.limitMicroUsd)) {
      return { ok: true, ticket: { tenantId, day, reservedMicroUsd: micro } };
    }
    const spent = this.ledger.read(tenantId, day).spentMicroUsd;
    const left = Math.max(0, this.limitMicroUsd - spent);
    const reason =
      `the relevance judge's daily budget has ${fromMicroUsd(left).toFixed(4)} of ${this.dailyUsd} USD left today (UTC), ` +
      `and this call could cost up to ${worstCaseUsd.toFixed(4)} USD, so it was not made; the budget resets at ${nextUtcMidnight(now)} ` +
      `(${DAILY_BUDGET_VAR} raises it)`;
    const key = `${tenantId}\u0000${day}`;
    if (!this.announced.has(key)) {
      this.announced.add(key);
      this.log(
        `Relevance judge: the daily budget (${this.dailyUsd} USD, ${DAILY_BUDGET_VAR}) is spent for tenant ${tenantId} on ${day} UTC; ` +
          `answers_the_ask reads the ask lexically until ${nextUtcMidnight(now)}, and each result says so.`,
      );
    }
    return { ok: false, reason };
  }

  /**
   * Replace a reservation with the call's actual cost. `null` means the
   * call failed after the provider may have billed it, and the cost is not
   * known: the worst case stays counted, since under-counting is the one
   * error a spend limit must not make.
   */
  settle(ticket: BudgetTicket, actualUsd: number | null): void {
    const delta = actualUsd === null ? 0 : toMicroUsd(actualUsd) - ticket.reservedMicroUsd;
    this.ledger.settle(ticket.tenantId, ticket.day, delta, true);
  }

  /** Release a reservation for a call that was never made (a refusal before any spend). */
  release(ticket: BudgetTicket): void {
    this.ledger.settle(ticket.tenantId, ticket.day, -ticket.reservedMicroUsd, false);
  }

  today(tenantId: TenantId): BudgetToday {
    const now = this.now();
    const day = utcDay(now);
    const r = this.ledger.read(tenantId, day);
    const spent = fromMicroUsd(r.spentMicroUsd);
    const remaining = fromMicroUsd(Math.max(0, this.limitMicroUsd - r.spentMicroUsd));
    return {
      day,
      limitUsd: this.dailyUsd,
      spentUsd: spent,
      remainingUsd: remaining,
      calls: r.calls,
      refused: r.refused,
      exhausted: r.refused > 0 || r.spentMicroUsd >= this.limitMicroUsd,
      resetsAt: nextUtcMidnight(now),
    };
  }
}

/**
 * The calls one request may still make. A door that scores many traces in
 * one request (an OTLP batch, evaluate_runs) creates one and passes it on
 * every evaluation; a door that scores one trace passes none, and the
 * judge treats that evaluation as a request of its own.
 */
export interface JudgeRequest {
  /** Judge calls this request has made. */
  calls: number;
  /** Evaluations this request left to the lexical reading because the cap was reached. */
  withheld: number;
}

export function newJudgeRequest(): JudgeRequest {
  return { calls: 0, withheld: 0 };
}
