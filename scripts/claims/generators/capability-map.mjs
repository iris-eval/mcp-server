// Capability map generator — reads capability-map.json at the repository
// root verbatim (the proof.mjs pattern: the file is the artifact, the
// truthbase carries it so every surface renders from one copy) and adds the
// counts by status the summaries quote.
//
// The map is cut by hand, cell by cell, and locked by
// tests/capability-map-contract.test.ts: every `has` / `partial` cell names
// evidence that resolves to something registered, every registered rule,
// tool, template and resource appears somewhere, and no cell names a
// private path or a lens id.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

export const STATUSES = ['has', 'partial', 'gap', 'n/a'];

export async function generate() {
  const map = JSON.parse(await readFile(resolve(root, 'capability-map.json'), 'utf-8'));
  if (!Array.isArray(map.cells) || !Array.isArray(map.questions) || !Array.isArray(map.subjects)) {
    throw new Error('capability-map.json must carry questions, subjects and cells');
  }
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const cell of map.cells) {
    if (!STATUSES.includes(cell.status)) throw new Error(`capability-map.json: cell ${cell.id} has unknown status "${cell.status}"`);
    counts[cell.status] += 1;
  }
  return {
    version: map.version,
    about: map.about,
    questions: map.questions,
    subjects: map.subjects,
    cells: map.cells,
    counts,
    total: map.cells.length,
  };
}
