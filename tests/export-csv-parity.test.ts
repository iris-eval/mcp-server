/*
 * The dashboard builds one CSV itself (the audit log) and cannot import the
 * server's encoder, so it carries a copy of the cell rules. The two copies
 * must write the same bytes for the same value, or the formula guard could
 * quietly differ between the downloads.
 */
import { describe, expect, it } from 'vitest';
import * as server from '../src/export/format.js';
import * as dashboard from '../dashboard/src/utils/csv.js';

const CORPUS: Array<string | number | boolean | null | undefined> = [
  '', 'plain', 'a,b', 'say "hi"', 'line\nbreak', 'cr\rlf\r\n', '=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', ' =not a formula', 'a=b',
  '返金', '🎉', '\uFEFFbom', 0, -1.5, 1e21, Number.NaN, Number.POSITIVE_INFINITY, true, false, null, undefined,
];

describe('CSV cell rules: server and dashboard', () => {
  it('write the same cell for every value in the corpus', () => {
    for (const value of CORPUS) expect(dashboard.csvCell(value), JSON.stringify(value)).toBe(server.csvCell(value));
  });

  it('write the same record and the same byte-order mark', () => {
    expect(dashboard.csvRow(CORPUS)).toBe(server.csvRow(CORPUS));
    expect(dashboard.CSV_BOM).toBe(server.CSV_BOM);
    expect(server.CSV_BOM).toBe('\uFEFF');
  });
});
