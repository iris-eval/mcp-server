/*
 * Structured tool errors.
 *
 * A thrown Error reaches an MCP client as one line of text with isError
 * set (the SDK flattens it), so the only thing an agent could do with
 * "Anthropic judge requires IRIS_ANTHROPIC_API_KEY" was guess. Every
 * failure a tool can produce is now a code from ONE catalogue with a
 * message, the steps that clear it, whether a retry can help, and — when
 * the failure is about one argument — the field and the valid values.
 * Tools return these (src/tools/respond.ts wraps the handler); they never
 * throw past the handler.
 *
 * The catalogue is exhaustive on purpose: tests/unit/tools/error-codes.test.ts
 * provokes every code over a real transport and asserts the provoked set
 * EQUALS this list, so a code nothing can raise cannot linger here and a
 * new throw site cannot ship without a code.
 *
 * Two errors are not this module's: an argument the input schema rejects
 * is refused by the SDK before the handler runs, as plain text (for an
 * unknown argument the text names IRIS_INVALID_ARGUMENT and the valid
 * arguments — see strict-input.ts; for a wrong type or a missing argument
 * it is the SDK's own sentence, with no code), and an HTTP rate limit
 * answers 429 at the transport before any tool runs. The same code is also
 * an envelope's, where a tool refuses an argument its schema let in.
 */
import { ZodError } from 'zod';
import { LLMJudgeError } from '../eval/llm-judge/client.js';
import { CAPABILITIES_RESOURCE_URI } from '../resources/uris.js';
import { JUDGE_COST_CAP_VAR } from '../judge-enablement.js';
import { DAILY_BUDGET_VAR } from '../eval/llm-judge/budget.js';
import { issuesText, MAX_LISTED_ISSUES } from '../utils/validation-errors.js';

export const ERROR_CODE_CATALOGUE = [
  'IRIS_INVALID_ARGUMENT',
  'IRIS_UNKNOWN_TRACE',
  'IRIS_DUPLICATE_RULE',
  'IRIS_INVALID_RULE_CONFIG',
  'IRIS_JUDGE_NOT_ENABLED',
  'IRIS_JUDGE_UNKNOWN_MODEL',
  'IRIS_BUDGET_EXCEEDED',
  'IRIS_PROVIDER_ERROR',
  'IRIS_JUDGE_FAILED',
  'IRIS_STORAGE_ERROR',
  'IRIS_INTERNAL_ERROR',
] as const;
export type IrisErrorCode = (typeof ERROR_CODE_CATALOGUE)[number];

/**
 * Codes a tool attaches to a SUCCESSFUL response under `warnings[]` — the
 * call did what was asked, and something about the answer should be read
 * with care. Kept beside the error catalogue so every IRIS_* name a
 * document may use is enumerated in one file (tests/docs-contract.test.ts
 * holds prose to this list and the error list).
 */
export const WARNING_CODE_CATALOGUE = [
  /** The LLM judge shares a model family with the agent it judged. */
  'IRIS_JUDGE_SAME_FAMILY',
  /** An argument asked for more than the operator allows (fetching, domains, cost); the operator's setting applied (operator-ceilings.ts). */
  'IRIS_ARGUMENT_NARROWED',
  /** An argument the model does not take (a temperature, for Claude 4.7 and later and OpenAI's reasoning models) was not sent; the model's own default applied. */
  'IRIS_ARGUMENT_NOT_SENT',
] as const;
export type IrisWarningCode = (typeof WARNING_CODE_CATALOGUE)[number];

export type ProviderErrorKind = LLMJudgeError['kind'];

export interface IrisErrorEnvelope {
  code: IrisErrorCode;
  /** One sentence a person can act on. */
  message: string;
  /** What to do, in order, before retrying. */
  recovery: string[];
  /** True when the same call can succeed later without a change from the caller. */
  retryable: boolean;
  /** The argument or environment variable at fault, when the failure is about one. */
  field?: string;
  /** The values the field accepts, when there is a closed list. */
  valid?: string[];
  /** A resource that explains the limit or the state. */
  see?: string;
  /** IRIS_PROVIDER_ERROR only: the provider failure class. */
  kind?: ProviderErrorKind;
  /** When the provider said how long to wait. */
  retryAfterMs?: number;
}

export class IrisError extends Error {
  readonly envelope: IrisErrorEnvelope;

  constructor(envelope: Omit<IrisErrorEnvelope, 'recovery' | 'retryable'> & Partial<Pick<IrisErrorEnvelope, 'recovery' | 'retryable'>>) {
    super(envelope.message);
    this.name = 'IrisError';
    this.envelope = { retryable: false, recovery: [], ...envelope };
  }
}

export function irisError(
  code: IrisErrorCode,
  message: string,
  extra: Partial<Omit<IrisErrorEnvelope, 'code' | 'message'>> = {},
): IrisError {
  return new IrisError({ code, message, ...extra });
}

const CAPABILITIES = CAPABILITIES_RESOURCE_URI;

/**
 * What a thrown value says for itself, always as text. A promise can reject
 * with anything: with nothing at all (null, undefined), with an object that
 * cannot be made a string, with an error whose message is not text. Those
 * say nothing, and a sentence of Iris's own stands for them: the store's
 * where the value carries a SQLite code, the internal error's otherwise
 * (toIrisError, below; an envelope always carries a message, respond.ts).
 */
function messageOf(err: unknown): string {
  if (err === null || err === undefined) return '';
  try {
    const said: unknown = err instanceof Error ? err.message : String(err);
    return typeof said === 'string' ? said : '';
  } catch {
    return '';
  }
}

/** One field of a thrown value, or undefined where it has none or reading it throws. */
function fieldOf(err: unknown, key: 'code' | 'errcode'): unknown {
  try {
    // Reading a field of null here threw inside the catch that was building the envelope, and the caller got that throw's one line.
    return (err as Record<string, unknown> | null | undefined)?.[key];
  } catch {
    return undefined;
  }
}

/** Node's built-in SQLite names a failure SQLite reports by a code of its own, with SQLite's number beside it (`errcode`); better-sqlite3 names it by SQLite's code. (A connection already closed is another code, the runtime's, and is not the store's failure under either.) */
const NODE_SQLITE_CODE = 'ERR_SQLITE_ERROR';

function isSqliteError(err: unknown): boolean {
  const code = fieldOf(err, 'code');
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return true;
  if (code === NODE_SQLITE_CODE) return true;
  // Only an error's own message is read for the driver's words, as before: a thrown string that happens to hold them is not the store's.
  return /SQLITE|database is locked|disk I\/O error|readonly database/i.test(err instanceof Error ? messageOf(err) : '');
}

/** The store was busy or locked: SQLITE_BUSY and SQLITE_LOCKED, as better-sqlite3 names them and as Node's built-in SQLite numbers them (5 and 6). */
function isSqliteBusy(err: unknown): boolean {
  const code = fieldOf(err, 'code');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const errcode = fieldOf(err, 'errcode');
  return code === NODE_SQLITE_CODE && (errcode === 5 || errcode === 6);
}

/**
 * Every error a handler can throw, mapped to its code. Typed errors are
 * matched by class or by name (the name check avoids importing the tool
 * that defines the class, which would be a cycle); anything unrecognised
 * is an internal error — reported as such, never dressed up as a caller
 * mistake.
 */
export function toIrisError(err: unknown): IrisError {
  if (err instanceof IrisError) return err;

  const name = (err as { name?: unknown })?.name;
  const message = messageOf(err);

  if (name === 'DuplicateRuleNameError') {
    return irisError('IRIS_DUPLICATE_RULE', message, {
      field: 'name',
      recovery: [
        'Pass replace: true to retire the rule(s) with this name and deploy this one in their place.',
        'Or call delete_rule with the existing rule id first.',
        'Or choose a different name.',
      ],
    });
  }

  // The engine refused an input nested deeper than it reads (a stored trace from before the limit: a call's own arguments are refused at the door). Its limit is a constant, so the recovery names no setting.
  if (name === 'InputTooDeepError') {
    return irisError('IRIS_INVALID_ARGUMENT', message, {
      recovery: ['Send the nested value flatter, or as text; a trace stored with a value this deep can be logged again without it.'],
    });
  }

  if (name === 'DailyBudgetError') {
    return irisError('IRIS_BUDGET_EXCEEDED', message, {
      field: DAILY_BUDGET_VAR,
      retryable: true,
      recovery: [
        `Every judge call Iris makes on this key draws on one daily budget, the operator's ${DAILY_BUDGET_VAR}. Retry after it resets (the time is in the message), or the operator raises it.`,
        'Nothing was spent.',
      ],
      see: CAPABILITIES,
    });
  }

  if (name === 'CostCapError') {
    const e = err as { estimatedUsd?: number; capUsd?: number };
    return irisError('IRIS_BUDGET_EXCEEDED', message, {
      field: 'max_cost_usd',
      recovery: [
        `The worst case was ${e.estimatedUsd?.toFixed(4) ?? '?'} USD against a cap of ${e.capUsd?.toFixed(4) ?? '?'} USD. Raise max_cost_usd on the call, up to the operator's ${JUDGE_COST_CAP_VAR}; above that, only the operator can raise ${JUDGE_COST_CAP_VAR}.`,
        'Or trim the output, the input or max_output_tokens so the worst case fits.',
        'Nothing was spent.',
      ],
      see: CAPABILITIES,
    });
  }

  if (err instanceof LLMJudgeError) {
    const retryable = err.kind === 'rate_limit' || err.kind === 'timeout' || err.kind === 'server_error' || err.kind === 'unreachable';
    const recovery: Record<ProviderErrorKind, string[]> = {
      auth: ['The key was refused: by the provider, or before any request where it holds a line break or another control character, or a character past one byte such as a curly quote or a zero-width space. Check that the key in the env block of your MCP config is valid, live and copied whole, then restart the session.'],
      rate_limit: ["The provider rate-limited the call. Wait (retryAfterMs, where the provider named a wait) and retry. Iris asks once more itself only where the provider's wait ends before the call's deadline."],
      bad_request: ['The provider rejected the request. Check the model name and the template inputs.'],
      server_error: ['The provider failed on its side. Retry later.'],
      timeout: ['The provider did not answer within timeout_ms, which every request, its reply and the wait after a rate limit share. Retry, or raise timeout_ms within your client\'s own request timeout.'],
      unreachable: ['Iris could not reach the provider, or its reply was cut off before its end. Check that this server can reach it (its network, a proxy), then retry.'],
      malformed_response: ['The judge answered, and not with the JSON object it was asked for: the message shows what stood in its place, or the start of it. Retry; if it recurs, pick another model.'],
      unknown: ['Retry once; if it recurs, report the message with the provider and model.'],
    };
    /*
     * How long the provider asked the caller to wait, when that is a number
     * JSON can carry. A provider's Retry-After can be any number above
     * zero, and a thousand times a large enough one is not a number: the
     * delay is then left out, and the rate limit is still told.
     */
    const retryAfterMs = typeof err.retryAfterSeconds === 'number' ? err.retryAfterSeconds * 1000 : Number.NaN;
    return irisError('IRIS_PROVIDER_ERROR', message, {
      kind: err.kind,
      retryable,
      recovery: recovery[err.kind],
      ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
    });
  }

  if (err instanceof ZodError) {
    // The SDK validates tool input before the handler runs, so a ZodError
    // inside a handler is the rule store rejecting a definition.
    const first = err.issues[0];
    const field = first?.path?.length ? first.path.map(String).join('.') : undefined;
    // At most 20 issues, then how many more (utils/validation-errors.ts).
    return irisError('IRIS_INVALID_RULE_CONFIG', `The rule definition was rejected: ${issuesText(err.issues, { max: MAX_LISTED_ISSUES, root: 'definition' })}`, {
      ...(field ? { field } : {}),
      recovery: ['Fix the named field and deploy again. Nothing was deployed.'],
    });
  }

  if (name === 'StoreNotReadyError') {
    // The store was being upgraded (storage/ready.ts): its sentence says what it was doing.
    const retryable = (err as { retryable?: boolean }).retryable === true;
    return irisError('IRIS_STORAGE_ERROR', message, {
      retryable,
      recovery: retryable
        ? ['Retry the same call in a few seconds; nothing was read or stored.']
        : ['Nothing was read or stored. Restart the server to try the upgrade again, and see its log for the reason.', 'Run `npx @iris-eval/mcp-server --self-test` to probe the configured home and database.'],
    });
  }

  if (name === 'AuditWriteError') {
    // The audit log could not be written, so the change it would have recorded was not made (custom-rule-store.ts).
    return irisError('IRIS_STORAGE_ERROR', message, {
      recovery: ['Nothing was changed. Make the audit log writable (the Iris home exists, is yours, and has free space), then retry.'],
    });
  }

  if (isSqliteError(err)) {
    return irisError('IRIS_STORAGE_ERROR', message === '' ? 'Iris storage failed.' : `Iris storage failed: ${message}`, {
      retryable: isSqliteBusy(err),
      recovery: [
        'Retry once. If it recurs, check that the database path is writable and the disk is not full.',
        'Run `npx @iris-eval/mcp-server --self-test` to probe the configured home and database.',
      ],
    });
  }

  return irisError('IRIS_INTERNAL_ERROR', message || 'Iris hit an unexpected error.', {
    recovery: ['Retry once. If it recurs, report the message with the Iris version from iris://capabilities.'],
    see: CAPABILITIES,
  });
}
