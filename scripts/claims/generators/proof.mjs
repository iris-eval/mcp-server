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

export async function generate() {
  const results = JSON.parse(await readFile(RESULTS_PATH, 'utf-8'));
  if (results.schemaVersion !== 1 || !Array.isArray(results.rules)) {
    throw new Error(`proof/results.json is not a schemaVersion-1 results file (run npm run proof)`);
  }
  const judge = JSON.parse(await readFile(JUDGE_PATH, 'utf-8'));
  return { ...results, judge };
}
