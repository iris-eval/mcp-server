/*
 * There is one rule-result renderer. Both pages that show rule results
 * import it, and neither carries a renderer of its own: the old ones were
 * `EvalDetailCard`'s inline map (mark, name, message, badge) and
 * `MomentDetailPage`'s `styles.ruleRow` block. This reads the two sources
 * and holds that neither shape is back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest runs with the dashboard package as its working directory.
const src = (rel: string) => readFileSync(resolve(process.cwd(), 'src/components', rel), 'utf8');

describe('one rule-result renderer', () => {
  const card = src('evals/EvalDetailCard.tsx');
  const moment = src('moments/MomentDetailPage.tsx');

  it('both pages render RuleResultRow', () => {
    expect(card).toMatch(/import \{ RuleResultRow \} from '\.\/RuleResultRow'/);
    expect(moment).toMatch(/import \{ RuleResultRow \} from '\.\.\/evals\/RuleResultRow'/);
    expect(card).toMatch(/<RuleResultRow\b/);
    expect(moment).toMatch(/<RuleResultRow\b/);
  });

  it('neither page carries a renderer of its own', () => {
    // The eval card's old inline row: its mark and its own state attribute.
    expect(card).not.toMatch(/eval-card__rule-mark/);
    expect(card).not.toMatch(/data-rule-state=/);
    // The moment page's old block.
    expect(moment).not.toMatch(/styles\.ruleRow\b/);
    expect(moment).not.toMatch(/styles\.ruleStatus\b/);
    expect(moment).not.toMatch(/r\.skipped \? 'Skipped: '/);
  });

  it('the row itself is the only file that sets data-rule-state', () => {
    const row = src('evals/RuleResultRow.tsx');
    expect(row).toMatch(/data-rule-state=\{state\}/);
  });
});
