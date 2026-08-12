# Dashboard style-system migration notes

**State as of the elite-feel pass (2026-08-11, `feat/dashboard-builder-first`).**

The dashboard now has a shared style system in `src/styles/utilities.css`
(imported by `globals.css`, on top of the `tokens.css` palette): primitives
(`iris-btn`, `iris-card`, `iris-kbd`, `iris-stack`, `iris-grid-*`,
`iris-num`, `iris-backdrop`/`iris-modal`, `iris-error-box`) plus
component recipe blocks (`moment-card`, `view-tabs`, `cmdk`, `stat-tile`,
`section-header`, `detail-*`, `eval-card`, `rule-card`,
`confirm-dialog`). The point of the migration: inline `style={{}}` cannot
express `:hover` / `:focus-visible` / `:active`, and the absence of those
states was most of the app's flat feeling.

## Conventions (follow these when migrating further files)

- Static styling → a class in `utilities.css`. Reusable primitives get an
  `iris-` prefix; single-component recipes are named after their owner
  (`moment-card__chip`) so class → component is one grep.
- Data-driven values (significance colors, verdict colors, accents) stay
  inline, or arrive as an inline CSS custom property
  (`--moment-sig-color` on MomentCard) when CSS needs them in a state rule.
- State styling keys off real DOM state where one exists
  (`[aria-selected='true']` on tabs/palette items) so accessibility state
  and visual state cannot drift.
- Every interactive element needs its microstates: default, hover,
  focus-visible (global ring in `globals.css`), active, disabled.
- Destructive prompts use `shared/ConfirmDialog` — `window.confirm` /
  `window.alert` are banned.
- Numerics: `tabular-nums` is global on `body`; add `iris-num--right` on
  columns/metas where magnitudes should compare visually.

## Migrated (off inline styles, full state coverage)

- `dashboard/FailuresView.tsx` (landing view)
- `moments/MomentCard.tsx` (the landing view's row — hover/focus-within)
- `dashboard/HealthView.tsx` (grids now reflow via auto-fit)
- `dashboard/StatTile.tsx`, `dashboard/SectionHeader.tsx`, `dashboard/ViewTabs.tsx`
- `traces/TraceDetailPage.tsx`, `evals/EvalDetailCard.tsx`
- `rules/RulesPage.tsx` (+ ConfirmDialog replacing native prompts)
- `command/CommandPalette.tsx` (+ ⌘K data search via `useCommandSearch`)
- `shared/ConfirmDialog.tsx` (new)

## Still on inline styles (migrate on touch, in rough priority order)

1. `dashboard/DriftView.tsx`, `dashboard/StreamView.tsx` — the two
   remaining ViewTabs views. Their rows/cards need hover states most.
2. `moments/MomentsTimelinePage.tsx`, `moments/MomentDetailPage.tsx`,
   `moments/MakeRuleModal.tsx` (large; should adopt `iris-modal` +
   `iris-btn`), `moments/BulkActionsBar.tsx`.
3. `traces/TraceListPage.tsx`, `traces/TraceTable.tsx`,
   `traces/TraceFilters.tsx`, `traces/SpanTree.tsx`, `traces/SpanRow.tsx`,
   `traces/SpanDetail.tsx`, `traces/ToolCallCard.tsx`.
4. `evals/EvalListPage.tsx`, `evals/EvalTable.tsx`, `evals/EvalFilters.tsx`.
5. Layout chrome: `layout/Shell.tsx`, `layout/Sidebar.tsx`,
   `layout/Header.tsx`, `layout/NavItem.tsx` (hover exists via JS state —
   should become CSS), `layout/AccountMenu.tsx`,
   `layout/NotificationsPopover.tsx`, `layout/PageHeader.tsx`,
   `layout/PageToolbar.tsx`, `layout/PageEmptyState.tsx`,
   `layout/WelcomeBanner.tsx`, `layout/MobileBanner.tsx`.
6. Shared: `shared/DataTable.tsx`, `shared/Pagination.tsx`,
   `shared/Badge.tsx`, `shared/ScoreBadge.tsx`, `shared/Tooltip.tsx`,
   `shared/JsonViewer.tsx`, `shared/CopyableId.tsx`,
   `shared/RateLimitBanner.tsx`, `shared/EmptyState.tsx`,
   `shared/LoadingSpinner.tsx`, `shared/EvalSparkline.tsx`.
7. `dashboard/charts/*` — chart internals are mostly fine inline (heavy
   d3 math), but their card shells should adopt `iris-card`.
8. `audit/AuditPage.tsx`, `command/KeyboardShortcutsOverlay.tsx`,
   `onboarding/WelcomeTour.tsx`.

## Known debts this pass did NOT take on

- `PeriodSelector` buttons still style hover via JS props — works, but
  should move to `.iris-btn--ghost` when touched.
- The dashboard bundle still ships recharts for one sparkline
  (`shared/EvalSparkline.tsx`) while every other chart is d3 — replacing
  it is a dependency change, out of scope for a no-new-deps pass.
- Persona leftovers flagged in the direction doc (notifications bell,
  Account avatar, rate-limit banner on localhost) are product decisions,
  not styling — left untouched here.
