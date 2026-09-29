/*
 * axe-core for the e2e accessibility checks (a11y.spec.ts).
 *
 * Loaded from the copy the dashboard's own jsdom accessibility tests run
 * (jest-axe pins axe-core to an exact version), so the two suites judge
 * with the same engine and there is no second copy to keep in step. The
 * browser run exists because jsdom cannot lay out a page: colour contrast,
 * focus visibility and whether an element can be reached at all are only
 * measurable in a real browser.
 *
 * The source is injected with page.evaluate rather than a <script> tag:
 * the dashboard's Content-Security-Policy (script-src 'self') refuses an
 * inline script, and the check must run against the policy that ships.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const fromDashboard = createRequire(join(process.cwd(), 'dashboard', 'package.json'));
const fromJestAxe = createRequire(fromDashboard.resolve('jest-axe'));

export const AXE_VERSION: string = JSON.parse(readFileSync(fromJestAxe.resolve('axe-core/package.json'), 'utf8')).version;
const AXE_SOURCE = readFileSync(fromJestAxe.resolve('axe-core/axe.min.js'), 'utf8');

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA, and axe's best-practice rules. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] as const;

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string; summary: string }>;
}

/** Run axe over the whole document as it is now. */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (tags) => {
    type AxeResult = {
      violations: Array<{
        id: string;
        impact: string | null;
        help: string;
        nodes: Array<{ target: unknown[]; failureSummary?: string }>;
      }>;
    };
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<AxeResult> } }).axe;
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target.map(String).join(' '), summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').trim() })),
    }));
  }, [...AXE_TAGS]);
}

/** One line per failing node, for an assertion message a reader can act on. */
export function describeViolations(violations: AxeViolation[]): string {
  return violations
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${v.help}\n    at ${n.target}\n    ${n.summary}`))
    .join('\n');
}
