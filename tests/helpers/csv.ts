/**
 * An RFC 4180 reader for tests, written apart from the encoder so a test
 * checks the export against the standard rather than against itself:
 * quoted fields, doubled quotes, CR and LF inside quotes, CRLF or LF
 * between records. Returns the records as arrays of cells.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === ',') {
      record.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
      i += 1;
    } else if (c === '\n') {
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else {
      cell += c;
    }
    i += 1;
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}
