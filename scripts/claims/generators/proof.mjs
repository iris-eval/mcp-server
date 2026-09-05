// Proof generator — copies the measured evaluator accuracy into the truthbase.
//
// `proof/results.json` is written by `npm run proof` (every built-in rule
// run on its labelled family: precision / recall / F1 with 95% intervals)
// and CI proves the committed file matches the code (`npm run proof --
// --check`). This generator reads it VERBATIM into `.claims.json → proof`,
// so the website's /proof page, llms.txt and any other surface take the
// numbers from the one file the runner produced and never restate them.
//
// `proof/judge-results.json` (the LLM-judge and citation-verifier
// measurement, `npm run proof:judge`) is copied verbatim into `proof.judge`.
// Until a keyed run replaces the committed placeholder it carries
// `status: "pending"`, and consumers must render that honestly.
//
// Nothing here is computed: a number that is not in the runner's output is
// not a claim.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const RESULTS_PATH = resolve(root, 'proof/results.json');
const JUDGE_PATH = resolve(root, 'proof/judge-results.json');
// `npm run proof -- --composite` writes proof/composite-results.json: the
// verdict a gate keys on, scored on the composite corpus under the legacy
// composer and the risk composer. Carried without its per-case list (the
// file holds it); absent until the first run lands.
const COMPOSITE_PATH = resolve(root, 'proof/composite-results.json');

export async function generate() {
  const results = JSON.parse(await readFile(RESULTS_PATH, 'utf-8'));
  if (results.schemaVersion !== 2 || !Array.isArray(results.rules)) {
    throw new Error(`proof/results.json is not a schemaVersion-2 results file (run npm run proof)`);
  }
  const judge = JSON.parse(await readFile(JUDGE_PATH, 'utf-8'));
  let composite = null;
  try {
    const raw = JSON.parse(await readFile(COMPOSITE_PATH, 'utf-8'));
    if (raw.schemaVersion !== 1) throw new Error(`proof/composite-results.json is schemaVersion ${raw.schemaVersion}, expected 1`);
    const { cases: _cases, generatedAt: _g, commit: _c, ...summary } = raw;
    composite = summary;
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  return { ...results, judge, ...(composite ? { composite } : {}) };
}
