// Clients generator — reads clients.json at the repository root verbatim
// (the capability-map.mjs pattern: the file is the artifact, the truthbase
// carries it so the README, the site and llms.txt render the same rows) and
// adds the counts by status.
//
// One row per MCP client Iris names as a place it runs. `verified` means a
// test in this repository drives that client's real integration surface on
// every CI run; `claimed` means the installer writes the configuration shape
// the client's own documentation describes and that writer is tested on the
// shape — nobody on the Iris side has watched the client connect. Locked by
// tests/clients-contract.test.ts: the rows are exactly the installer's
// profiles, every evidence path exists, every source is a URL with the date
// it was last read, and the prose surfaces render their lists from here.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

export const STATUSES = ['verified', 'claimed'];
const REQUIRED = ['id', 'name', 'status', 'configMode', 'config', 'summary', 'source', 'lastChecked'];

export async function generate() {
  const file = JSON.parse(await readFile(resolve(root, 'clients.json'), 'utf-8'));
  if (!Array.isArray(file.rows) || !Array.isArray(file.statuses)) {
    throw new Error('clients.json must carry statuses and rows');
  }
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const seen = new Set();
  for (const row of file.rows) {
    for (const key of REQUIRED) {
      if (typeof row[key] !== 'string' || row[key].trim() === '') throw new Error(`clients.json: row ${row.id ?? '?'} lacks ${key}`);
    }
    if (!STATUSES.includes(row.status)) throw new Error(`clients.json: row ${row.id} has unknown status "${row.status}"`);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) throw new Error(`clients.json: row ${row.id} names no evidence`);
    if (seen.has(row.id)) throw new Error(`clients.json: row ${row.id} appears twice`);
    seen.add(row.id);
    counts[row.status] += 1;
  }
  return {
    version: file.version,
    about: file.about,
    statuses: file.statuses,
    rows: file.rows,
    counts,
    total: file.rows.length,
  };
}
