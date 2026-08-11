/*
 * FailuresView — the landing view (?view=failures, and the `/` default).
 *
 * Research finding: not one tool in this category lands the user on the
 * failure — every one opens on a picker or an aggregate. The category's
 * single stated job ("something is wrong → show me the bad output") is
 * left to manual filtering everywhere. This view does that job directly:
 *
 *   - Ranked failure list from GET /failures — recent failed/flagged
 *     moments, severity × recency (server-side; see failure-rank.ts).
 *   - Each row: which rules failed, on which agent, the offending
 *     output, and when. Click-through to the moment detail view.
 *   - Seen/unseen per failure (localStorage) — a returning user sees
 *     what is NEW since they last looked.
 *
 * Health/Drift/Stream stay one click away on the ViewTabs strip.
 */
import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useFailures } from '../../api/hooks';
import { useSeenFailures } from '../../hooks/useSeenFailures';
import { MomentCard } from '../moments/MomentCard';
import { SectionHeader } from './SectionHeader';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { PageEmptyState } from '../layout/PageEmptyState';
import { RateLimitBanner } from '../shared/RateLimitBanner';

const FAILURE_LIST_LIMIT = '50';

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  newStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
  } as const,
  markAllBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
  } as const,
  errorBox: {
    background: 'oklch(28% 0.10 25 / 0.18)',
    border: '1px solid var(--accent-error)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-4)',
    color: 'var(--accent-error)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as const,
  retryBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--accent-error)',
    color: 'var(--accent-error)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    width: 'fit-content',
  } as const,
  quickstartLink: {
    color: 'var(--iris-400)',
  } as const,
};

export function FailuresView() {
  const { data, loading, error, rateLimitedUntil, refetch } = useFailures({
    limit: FAILURE_LIST_LIMIT,
  });
  const { isSeen, markSeen, markAllSeen } = useSeenFailures();

  const failures = useMemo(() => data?.failures ?? [], [data]);
  const unseenIds = useMemo(
    () => failures.filter((f) => !isSeen(f.id)).map((f) => f.id),
    [failures, isSeen],
  );

  return (
    <div style={styles.view} role="tabpanel" id="view-panel-failures" aria-labelledby="failures-tab">
      {rateLimitedUntil && <RateLimitBanner until={rateLimitedUntil} onRetry={refetch} />}

      <SectionHeader
        title="What failed"
        question="Recent failed and flagged runs, worst and newest first. Click one to see why."
        trailing={
          data && failures.length > 0 ? (
            <span style={styles.newStrip}>
              <span>
                {unseenIds.length > 0
                  ? `${unseenIds.length} new since you last looked`
                  : 'nothing new since you last looked'}
              </span>
              {unseenIds.length > 0 && (
                <button
                  type="button"
                  style={styles.markAllBtn}
                  onClick={() => markAllSeen(unseenIds)}
                >
                  Mark all seen
                </button>
              )}
            </span>
          ) : undefined
        }
      />

      {error && (
        <div style={styles.errorBox} role="alert">
          <strong>Could not load failures</strong>
          <span>{error}</span>
          <button type="button" style={styles.retryBtn} onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {loading && !data && <LoadingSpinner />}

      {data && failures.length === 0 && (
        data.total === 0 ? (
          /*
           * Nothing has ever run. Written at builder scale — one person,
           * one agent, first session — not "your fleet is idle."
           */
          <PageEmptyState
            icon={AlertTriangle}
            title="Nothing has run yet"
            body={
              <>
                When an agent runs through Iris, anything that fails a rule lands
                right here — worst and newest first. The{' '}
                <a
                  href="https://github.com/iris-eval/mcp-server#quickstart"
                  target="_blank"
                  rel="noreferrer"
                  style={styles.quickstartLink}
                >
                  quickstart
                </a>{' '}
                wires up your agent, or see a real failure on screen right now
                with demo mode:
              </>
            }
            command="npx @iris-eval/mcp-server --demo"
          />
        ) : (
          <PageEmptyState
            icon={AlertTriangle}
            title="No failures in your recent runs"
            body={`Scanned your last ${data.scanned} runs — every fired rule passed and nothing was flagged. Health (one tab over) has the aggregates.`}
          />
        )
      )}

      {data && failures.length > 0 && (
        <div style={styles.list}>
          {failures.map((f) => (
            <MomentCard
              key={f.id}
              moment={f}
              unseen={!isSeen(f.id)}
              onOpen={markSeen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
