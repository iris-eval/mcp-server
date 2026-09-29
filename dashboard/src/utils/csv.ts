/*
 * CSV for the downloads the dashboard builds itself (the audit log).
 *
 * The same rules as the server's exports (src/export/format.ts), which the
 * dashboard cannot import: UTF-8 with a byte-order mark so Excel reads it
 * as UTF-8, CRLF between records, quoting when a field holds a comma, a
 * quote, CR or LF, and a single quote before any text cell a spreadsheet
 * would run as a formula (= + - @ tab CR). tests/export-csv-parity.test.ts
 * holds the two copies to the same output.
 */
export const CSV_BOM = '\uFEFF';

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** A whole CSV document: the BOM, the header, the rows. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): string {
  return CSV_BOM + csvRow(header) + rows.map(csvRow).join('');
}
