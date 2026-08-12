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
    <div className="iris-stack" role="tabpanel" id="view-panel-failures" aria-labelledby="failures-tab">
      {rateLimitedUntil && <RateLimitBanner until={rateLimitedUntil} onRetry={refetch} />}

      <SectionHeader
        title="What failed"
        question="Recent failed and flagged runs, worst and newest first. Click one to see why."
        trailing={
          data && failures.length > 0 ? (
            <span className="iris-row">
              <span>
                {unseenIds.length > 0
                  ? `${unseenIds.length} new since you last looked`
                  : 'nothing new since you last looked'}
              </span>
              {unseenIds.length > 0 && (
                <button
                  type="button"
                  className="iris-btn iris-btn--ghost iris-btn--sm iris-btn--mono"
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
        <div className="iris-error-box" role="alert">
          <strong>Could not load failures</strong>
          <span>{error}</span>
          <button
            type="button"
            className="iris-btn iris-btn--danger"
            style={{ width: 'fit-content' }}
            onClick={refetch}
          >
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
                >
                  quickstart
                </a>{' '}
                wires up your agent in about a minute.
              </>
            }
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
        <div className="iris-stack">
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
