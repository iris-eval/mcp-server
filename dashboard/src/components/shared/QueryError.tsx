/*
 * The one way a failed query is shown, inside the widget that asked (D-1).
 *
 * A query's error used to be a string rendered by whichever page thought
 * to render it, and a page that did not blanked. Every widget that owns a
 * query renders this beside its own heading, so one failing chart never
 * takes the page with it, and the sentence is the error's kind, not a
 * status code.
 */
import type { ApiError } from '../../api/errors';
import { RateLimitBanner } from './RateLimitBanner';

export interface QueryErrorProps {
  error: ApiError;
  /** What the widget was loading, in the reader's words: "failures", "the audit log". */
  what: string;
  onRetry?: () => void;
  /** Epoch-ms when a rate limit lifts; when set with a rate-limited error the countdown banner is shown instead. */
  rateLimitedUntil?: number | null;
}

/** A short label per kind, for a heading a reader can scan. */
export const KIND_LABEL: Record<ApiError['kind'], string> = {
  unreachable: 'Iris did not answer',
  unauthorized: 'Sign in needed',
  'not-found': 'Not found',
  'rate-limited': 'Rate limited',
  'server-error': 'The server failed',
  'bad-request': 'Request refused',
};

export function QueryError({ error, what, onRetry, rateLimitedUntil }: QueryErrorProps) {
  if (error.kind === 'rate-limited' && rateLimitedUntil) {
    return <RateLimitBanner until={rateLimitedUntil} onRetry={onRetry} />;
  }
  return (
    <div className="iris-error-box" role="alert" data-error-kind={error.kind}>
      <strong>
        Could not load {what} — {KIND_LABEL[error.kind]}
      </strong>
      <span>{error.message}</span>
      {error.kind === 'unauthorized' ? (
        <a href={`/?key=`} style={{ color: 'inherit', width: 'fit-content' }}>
          Sign in
        </a>
      ) : null}
      {onRetry && error.kind !== 'unauthorized' ? (
        <button type="button" className="iris-btn iris-btn--danger" style={{ width: 'fit-content' }} onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
