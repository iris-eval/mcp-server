/*
 * The CSV the dashboard builds itself (the audit log download): a rule name
 * is text whoever deployed the rule chose, so a formula in it must reach a
 * spreadsheet as text. Same rules as the server's exports; the root suite's
 * tests/export-csv-parity.test.ts holds the two copies together.
 */
import { describe, it, expect } from 'vitest';
import { CSV_BOM, toCsv } from '../../src/utils/csv';

describe('toCsv', () => {
  it('starts with a BOM, ends records in CRLF, quotes what needs it, and neutralises formulas', () => {
    const csv = toCsv(['ts', 'ruleName', 'details'], [
      ['2026-09-28T10:00:00.000Z', '=HYPERLINK("http://x","y")', 'a, b'],
      ['2026-09-28T10:01:00.000Z', undefined, 'line 1\nline 2'],
    ]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(CSV_BOM.length)).toBe(
      'ts,ruleName,details\r\n' +
        `2026-09-28T10:00:00.000Z,"'=HYPERLINK(""http://x"",""y"")","a, b"\r\n` +
        '2026-09-28T10:01:00.000Z,,"line 1\nline 2"\r\n',
    );
  });
});
