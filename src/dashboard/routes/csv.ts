export function escapeCsvValue(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const headerLine = headers.map(escapeCsvValue).join(',');
  const bodyLines = rows.map((row) => row.map(escapeCsvValue).join(','));
  return [headerLine, ...bodyLines].join('\n');
}
