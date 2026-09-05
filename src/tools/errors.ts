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
 * is refused by the SDK before the handler runs (the text names
 * IRIS_INVALID_ARGUMENT and the valid arguments — see strict-input.ts), and
 * an HTTP rate limit answers 429 at the transport before any tool runs.
 */
import { ZodError } from 'zod';
import { LLMJudgeError } from '../eval/llm-judge/client.js';
import { CAPABILITIES_RESOURCE_URI } from '../resources/uris.js';

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

function isSqliteError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return true;
  const message = err instanceof Error ? err.message : '';
  return /SQLITE|database is locked|disk I\/O error|readonly database/i.test(message);
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
  const message = err instanceof Error ? err.message : String(err);

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

  if (name === 'CostCapError') {
    const e = err as { estimatedUsd?: number; capUsd?: number };
    return irisError('IRIS_BUDGET_EXCEEDED', message, {
      field: 'max_cost_usd',
      recovery: [
        `Raise max_cost_usd on the call (the worst case was ${e.estimatedUsd?.toFixed(4) ?? '?'} USD against a cap of ${e.capUsd?.toFixed(4) ?? '?'} USD).`,
        'Or trim the output, the input or max_output_tokens so the worst case fits.',
        'Nothing was spent.',
      ],
      see: CAPABILITIES,
    });
  }

  if (err instanceof LLMJudgeError) {
    const retryable = err.kind === 'rate_limit' || err.kind === 'timeout' || err.kind === 'server_error';
    const recovery: Record<ProviderErrorKind, string[]> = {
      auth: ['The provider refused the key. Check that the key in the env block of your MCP config is valid and live, then restart the session.'],
      rate_limit: ['The provider rate-limited the call. Wait and retry; Iris already retried once.'],
      bad_request: ['The provider rejected the request. Check the model name and the template inputs.'],
      server_error: ['The provider failed on its side. Retry later.'],
      timeout: ['The provider did not answer within timeout_ms. Retry, or raise timeout_ms.'],
      malformed_response: ['The judge did not return valid JSON on two attempts. Retry; if it recurs, pick another model.'],
      unknown: ['Retry once; if it recurs, report the message with the provider and model.'],
    };
    return irisError('IRIS_PROVIDER_ERROR', message, {
      kind: err.kind,
      retryable,
      recovery: recovery[err.kind],
      ...(err.retryAfterSeconds !== undefined ? { retryAfterMs: err.retryAfterSeconds * 1000 } : {}),
    });
  }

  if (err instanceof ZodError) {
    // The SDK validates tool input before the handler runs, so a ZodError
    // inside a handler is the rule store rejecting a definition.
    const first = err.issues[0];
    const field = first?.path?.length ? first.path.map(String).join('.') : undefined;
    return irisError('IRIS_INVALID_RULE_CONFIG', `The rule definition was rejected: ${err.issues.map((i) => `${i.path.map(String).join('.') || 'definition'}: ${i.message}`).join('; ')}`, {
      ...(field ? { field } : {}),
      recovery: ['Fix the named field and deploy again. Nothing was deployed.'],
    });
  }

  if (isSqliteError(err)) {
    const code = (err as { code?: string }).code ?? '';
    return irisError('IRIS_STORAGE_ERROR', `Iris storage failed: ${message}`, {
      retryable: code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED',
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
