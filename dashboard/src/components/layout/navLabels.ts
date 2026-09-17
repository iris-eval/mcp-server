/*
 * The navigation's names, in one place (arc 7, D-5).
 *
 * Four entries for three concepts: what failed (Failures — the landing
 * page), the data (Runs, with traces and evaluations as its raw views),
 * and authoring (Rules, Audit). The NAMES are brand and the founder's
 * call: the proposed set is written beside the current one, and one edit
 * — the export at the bottom — flips every surface that names an entry
 * (sidebar, palette, page titles, the e2e specs). Nothing else in the tree
 * spells a navigation label.
 */
export interface NavLabelSet {
  failures: string;
  runs: string;
  rules: string;
  audit: string;
  moments: string;
}

export const NAV_LABEL_SETS = {
  current: { failures: 'Dashboard', runs: 'Runs', rules: 'Custom Rules', audit: 'Audit Log', moments: 'Decision Moments' },
  proposed: { failures: 'Failures', runs: 'Runs', rules: 'Rules', audit: 'Audit', moments: 'Moments' },
} as const satisfies Record<string, NavLabelSet>;

/** Founder-gated: switch to `NAV_LABEL_SETS.proposed` when the names are approved. One edit. */
export const NAV_LABELS: NavLabelSet = NAV_LABEL_SETS.current;
