/*
 * BulkActionsBar — appears at the bottom of the viewport when one or more
 * Decision Moments are selected on the timeline (B8.5).
 *
 * Actions:
 *   - Archive selected: writes to preferences.archivedMoments via patch.
 *     Archived moments are hidden by default; the "Show archived" toggle
 *     in the filter row reveals them again (dimmed, tagged).
 *   - Unarchive selected: removes from preferences.archivedMoments.
 *   - Make rule from selection: opens the composer with multi-moment
 *     context (composer pre-fills from the union of failed-rule patterns).
 *   - Clear selection.
 *
 * Visual contract: floating bar pinned to viewport bottom, centered,
 * elevated above all dashboard content. Dismisses when selection
 * count → 0.
 */
import type { DecisionMoment } from '../../api/types';

const styles = {
  bar: {
    position: 'fixed',
    left: '50%',
    bottom: 'var(--space-6)',
    transform: 'translateX(-50%)',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    boxShadow: 'var(--shadow-lg)',
    padding: 'var(--space-2) var(--space-4)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    zIndex: 90,
    fontSize: 'var(--font-size-sm)',
  } as const,
  count: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    fontWeight: 600,
  } as const,
  divider: {
    width: '1px',
    height: '20px',
    background: 'var(--border-color)',
  } as const,
  btn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
  } as const,
  btnPrimary: {
    background: 'var(--accent-primary)',
    color: 'var(--bg-primary)',
    borderColor: 'var(--accent-primary)',
    fontWeight: 600,
  } as const,
  btnDanger: {
    color: 'var(--accent-warning)',
    borderColor: 'var(--accent-warning)',
  } as const,
};

interface Props {
  selectedMoments: DecisionMoment[];
  /** True when every selected moment is already archived (toggles label to "Unarchive"). */
  allArchived: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onMakeRule: () => void;
  onClear: () => void;
}

export function BulkActionsBar({
  selectedMoments,
  allArchived,
  onArchive,
  onUnarchive,
  onMakeRule,
  onClear,
}: Props) {
  if (selectedMoments.length === 0) return null;

  return (
    <div style={styles.bar} role="region" aria-label="Bulk actions">
      <span style={styles.count}>
        {selectedMoments.length} selected
      </span>
      <span style={styles.divider} />
      {allArchived ? (
        <button type="button" onClick={onUnarchive} style={styles.btn}>
          Unarchive
        </button>
      ) : (
        <button type="button" onClick={onArchive} style={{ ...styles.btn, ...styles.btnDanger }}>
          Archive
        </button>
      )}
      <button
        type="button"
        onClick={onMakeRule}
        style={{ ...styles.btn, ...styles.btnPrimary }}
        disabled={selectedMoments.length === 0}
      >
        Make rule from selection
      </button>
      <span style={styles.divider} />
      <button type="button" onClick={onClear} style={styles.btn}>
        Clear
      </button>
    </div>
  );
}
