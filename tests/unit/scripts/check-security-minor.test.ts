/*
 * The support-policy guard states the policy.
 *
 * The policy: the current minor receives every fix; the previous minor
 * receives security fixes for 90 days after the current minor's first
 * release; older minors receive none. The guard reads SECURITY.md's table
 * as text and refuses a release whose table says otherwise — including
 * the pre-0.15.0 table that named only the current minor.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { previousMinor, securityTableProblems } from '../../../scripts/check-security-minor.mjs';

const root = resolve(__dirname, '..', '..', '..');

function policy(rows: string, currentLine = '0.14.x'): string {
  return [
    '## Supported Versions',
    '',
    `The current minor receives every fix. Older minors receive none — upgrade to the current \`${currentLine}\` line.`,
    '',
    '| Version          | Supported                                   |',
    '|------------------|---------------------------------------------|',
    rows,
    '',
  ].join('\n');
}

describe('securityTableProblems', () => {
  it('the checked-in SECURITY.md states the policy for the version in package.json', () => {
    const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
    expect(securityTableProblems(readFileSync(resolve(root, 'SECURITY.md'), 'utf8'), version)).toEqual([]);
  });

  it('accepts the current minor, the previous minor with its end date, and no older line', () => {
    const text = policy('| 0.14.x           | Yes                                         |\n| 0.13.x           | Yes, security fixes until 2026-12-19        |\n| 0.12.x and lower | No                                          |');
    expect(securityTableProblems(text, '0.14.3')).toEqual([]);
  });

  it('the pre-0.15.0 table — only the current minor — is now a mismatch naming the previous minor', () => {
    const text = policy('| 0.14.x           | Yes       |\n| 0.13.x and lower | No        |');
    const problems = securityTableProblems(text, '0.14.0');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not mark the previous minor 0\.13\.x as supported \(security fixes for 90 days after 0\.14\.0\)/);
  });

  it('a previous-minor row without the window end date is named', () => {
    const text = policy('| 0.14.x | Yes |\n| 0.13.x | Yes |\n| 0.12.x and lower | No |');
    expect(securityTableProblems(text, '0.14.0')).toEqual([
      'SECURITY.md row for 0.13.x does not name the window\'s end date ("Yes, security fixes until YYYY-MM-DD")',
    ]);
  });

  it('an older minor still marked supported is named', () => {
    const text = policy('| 0.14.x | Yes |\n| 0.13.x | Yes, security fixes until 2026-12-19 |\n| 0.12.x | Yes, security fixes until 2026-10-01 |\n| 0.11.x and lower | No |');
    expect(securityTableProblems(text, '0.14.0')).toEqual(['SECURITY.md still marks 0.12.x as supported (current minor is 0.14; the previous minor is 0.13)']);
  });

  it('a table that never names the current minor, and prose that points at the old line, are both named', () => {
    const text = policy('| 0.13.x | Yes |\n| 0.12.x | Yes, security fixes until 2026-10-01 |\n| 0.11.x and lower | No |', '0.13.x');
    const problems = securityTableProblems(text, '0.14.0');
    expect(problems).toContain('SECURITY.md table does not mark 0.14.x as Supported: Yes');
    expect(problems).toContain('SECURITY.md prose does not point at the current `0.14.x` line');
    expect(problems.some((p) => p.includes('still marks 0.12.x'))).toBe(true);
  });

  it('previousMinor steps one minor back and stops at x.0', () => {
    expect(previousMinor('0.14')).toBe('0.13');
    expect(previousMinor('1.2')).toBe('1.1');
    expect(previousMinor('1.0')).toBeNull();
    expect(previousMinor('0.0')).toBeNull();
  });

  it('at a x.0 release only the current minor is required', () => {
    const text = policy('| 1.0.x | Yes |\n| 0.14.x and lower | No |', '1.0.x');
    expect(securityTableProblems(text, '1.0.0')).toEqual([]);
  });
});
