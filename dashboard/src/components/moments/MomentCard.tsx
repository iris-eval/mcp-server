import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import type { DecisionMoment } from '../../api/types';
import { formatCost, formatLatency, formatTimeAgo } from '../../utils/formatters';
import { getSignificanceVisual, getVerdictVisual } from './significance';
import { Tooltip } from '../shared/Tooltip';
import { TT } from '../shared/tooltipText';

/* Map verdict → tooltip text. Keeps the card lean. */
const VERDICT_TOOLTIP: Record<string, string> = {
  PASS: TT.verdictPass,
  FAIL: TT.verdictFail,
  PARTIAL: TT.verdictPartial,
  UNEVALUATED: TT.verdictUnevaluated,
};

/* Map significance kind → tooltip text. */
const SIG_TOOLTIP: Record<string, string> = {
  'safety-violation': TT.sigSafetyViolation,
  'cost-spike': TT.sigCostSpike,
  'rule-collision': TT.sigRuleCollision,
  'normal-fail': TT.sigNormalFail,
  'normal-pass': TT.sigNormalPass,
  'first-failure': TT.sigFirstFailure,
  'novel-pattern': TT.sigNovelPattern,
};

/*
 * Static styling lives in utilities.css (.moment-card block) so the row
 * gets real :hover / :focus-within states. Only the data-driven colors
 * (significance rail + verdict) stay inline — CSS can't know them.
 */

interface Props {
  moment: DecisionMoment;
  /** True when the moment is in preferences.archivedMoments. Renders dimmed + tagged. */
  archived?: boolean;
  /** Selection state (B8.5). Undefined = not selectable; boolean = selectable. */
  selected?: boolean;
  onToggleSelected?: (id: string) => void;
  /** True when the user hasn't looked at this failure yet. Renders a NEW tag. */
  unseen?: boolean;
  /** Fires when the user clicks through to the detail view. */
  onOpen?: (id: string) => void;
}

export function MomentCard({
  moment,
  archived = false,
  selected,
  onToggleSelected,
  unseen = false,
  onOpen,
}: Props) {
  const sig = getSignificanceVisual(moment.significance.kind);
  const verdict = getVerdictVisual(moment.verdict);
  const outputPreview = moment.output?.slice(0, 140) ?? '';
  const selectable = onToggleSelected !== undefined;

  const cardClass = [
    'iris-card',
    'iris-card--hover',
    'moment-card',
    archived ? 'moment-card--archived' : '',
    selected ? 'moment-card--selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cardClass}
      style={{ '--moment-sig-color': sig.color } as CSSProperties}
      title={moment.significance.reason}
    >
      <div className="moment-card__checkbox-wrap">
        {selectable && (
          <input
            type="checkbox"
            className="moment-card__checkbox"
            checked={Boolean(selected)}
            onChange={() => onToggleSelected!(moment.id)}
            aria-label={`Select moment ${moment.id.slice(0, 12)}`}
          />
        )}
      </div>

      <div className="moment-card__rail">
        <Tooltip content={SIG_TOOLTIP[moment.significance.kind] ?? sig.name}>
          <span
            className="moment-card__glyph"
            style={{ background: sig.color }}
            aria-label={sig.name}
            tabIndex={0}
          >
            {sig.glyph}
          </span>
        </Tooltip>
      </div>

      <Link
        to={`/moments/${moment.id}`}
        className="moment-card__body-link"
        onClick={onOpen ? () => onOpen(moment.id) : undefined}
      >
        <div className="moment-card__header">
          {unseen && <span className="moment-card__tag moment-card__tag--new">NEW</span>}
          <span className="moment-card__agent">{moment.agentName}</span>
          <Tooltip content={VERDICT_TOOLTIP[verdict.label] ?? ''}>
            <span className="moment-card__verdict" style={{ color: verdict.color }} tabIndex={0}>
              {verdict.label}
            </span>
          </Tooltip>
          <span className="moment-card__sig">· {moment.significance.label}</span>
          {archived && <span className="moment-card__tag">archived</span>}
        </div>
        {moment.ruleSnapshot.failed.length > 0 && (
          <div className="moment-card__chips">
            {moment.ruleSnapshot.failed.slice(0, 6).map((name) => (
              <span key={name} className="moment-card__chip">{name}</span>
            ))}
            {moment.ruleSnapshot.failed.length > 6 && (
              <span className="moment-card__chip">+{moment.ruleSnapshot.failed.length - 6}</span>
            )}
          </div>
        )}
        {outputPreview && (
          <div className="moment-card__preview" aria-label="Output preview">
            {outputPreview}
            {moment.output && moment.output.length > 140 ? '…' : ''}
          </div>
        )}
      </Link>

      <div className="moment-card__meta iris-num iris-num--right">
        <span>{formatTimeAgo(moment.timestamp)}</span>
        {moment.costUsd != null && (
          <Tooltip content={TT.costPerTrace}>
            <span tabIndex={0}>{formatCost(moment.costUsd)}</span>
          </Tooltip>
        )}
        {moment.latencyMs != null && (
          <Tooltip content={TT.latencyMs}>
            <span tabIndex={0}>{formatLatency(moment.latencyMs)}</span>
          </Tooltip>
        )}
        <Tooltip content={`${moment.ruleSnapshot.passedCount} of ${moment.ruleSnapshot.totalCount - moment.ruleSnapshot.skipped.length} fired rules passed.${moment.ruleSnapshot.skipped.length > 0 ? ` ${moment.ruleSnapshot.skipped.length} skipped.` : ''}`}>
          <span tabIndex={0}>
            {moment.ruleSnapshot.passedCount}/
            {moment.ruleSnapshot.totalCount - moment.ruleSnapshot.skipped.length} pass
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
