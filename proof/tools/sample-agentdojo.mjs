#!/usr/bin/env node
/*
 * Draws the AgentDojo sample that `npm run proof -- --outside` measures,
 * and writes it to proof/outside/agentdojo/. Run once, by hand; the runner
 * itself never touches the network.
 *
 *   node proof/tools/sample-agentdojo.mjs
 *
 * The draw is a function of the pinned commit and the seed alone, so anyone
 * can repeat it and get the same files:
 *   1. List every run log under runs/ at the pinned commit (GitHub's tree API).
 *   2. Two pools of a user's tasks: runs under the benchmark's headline
 *      attack (`important_instructions`), and runs with no attack (`none`).
 *      AgentDojo's runs of an attacker's goal as the user's own request are
 *      left out: they check the goal can be done, and are not a user's task.
 *   3. Order each pipeline's runs by sha256(seed + path), then take runs from
 *      the pipelines in turn, so every agent contributes alike.
 *   4. Attacked runs are kept until there are ATTACKED_PER_LABEL whose attack
 *      succeeded (`security: true`) and as many where it failed. A run whose
 *      label is already full is read and passed over. Runs with no attack:
 *      the first BENIGN in the same order.
 *   5. Every file is checked against the git blob hash the tree lists, and
 *      written byte for byte.
 *
 * Each task, (suite, user task), is put in a `dev` or `test` half by the
 * seed. A change to a rule made after reading these runs may read the dev
 * half only; the test half stays held out.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'ethz-spylab/agentdojo';
export const COMMIT = '089ed468cf3ed0322acc66b0211f26d9d90dbf60';
export const SEED = 'iris-outside-agentdojo-v1';
export const ATTACK = 'important_instructions';
export const ATTACKED_PER_LABEL = 200;
export const BENIGN = 300;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'outside', 'agentdojo');

const order = (path) => createHash('sha256').update(`${SEED}\n${path}`).digest('hex');
/** The half a task belongs to: a fixed function of the seed and the task. */
export const splitOf = (suite, userTask) => (parseInt(createHash('sha256').update(`${SEED}\nsplit\n${suite}/${userTask}`).digest('hex').slice(0, 8), 16) % 2 === 0 ? 'dev' : 'test');
const blobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function get(url, accept) {
  const headers = { 'user-agent': 'iris-eval-proof', ...(accept ? { accept } : {}) };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, { headers });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (attempt === 4) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

/** Takes runs from each pipeline in turn, each pipeline's runs in seeded order. */
function roundRobin(entries) {
  const byPipeline = new Map();
  for (const e of entries) {
    const pipeline = e.path.split('/')[1];
    if (!byPipeline.has(pipeline)) byPipeline.set(pipeline, []);
    byPipeline.get(pipeline).push(e);
  }
  const lists = [...byPipeline.keys()].sort().map((k) => byPipeline.get(k).sort((a, b) => (order(a.path) < order(b.path) ? -1 : 1)));
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i += 1) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

async function fetchRun(entry) {
  const bytes = await get(`https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}/${entry.path}`);
  const sha = blobSha(bytes);
  if (sha !== entry.sha) throw new Error(`${entry.path}: blob ${sha} is not the ${entry.sha} the tree lists`);
  return bytes;
}

/** Reads candidates in order, a batch at a time, and keeps them in that same order whatever finishes first. */
async function draw(candidates, keep, done) {
  const kept = [];
  let read = 0;
  for (let i = 0; i < candidates.length && !done(); i += 16) {
    const batch = candidates.slice(i, i + 16);
    const bytes = await Promise.all(batch.map(fetchRun));
    for (const [j, entry] of batch.entries()) {
      if (done()) break;
      read += 1;
      const run = JSON.parse(bytes[j].toString('utf-8'));
      if (keep(run)) kept.push({ entry, bytes: bytes[j], run });
    }
  }
  return { kept, read };
}

async function main() {
  const tree = JSON.parse((await get(`https://api.github.com/repos/${REPOSITORY}/git/trees/${COMMIT}?recursive=1`, 'application/vnd.github+json')).toString('utf-8'));
  if (tree.truncated) throw new Error('the tree listing came back truncated');
  const runs = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith('runs/') && e.path.endsWith('.json') && e.path.split('/').length === 6);
  // A user's task, with or without an attack. AgentDojo also runs each attacker goal as a user's own request
  // (runs/<agent>/<suite>/injection_task_N/none/), to check the goal can be done; that is not a user's task.
  const userTask = (e) => e.path.split('/')[3].startsWith('user_task_');
  const attacked = runs.filter((e) => e.path.split('/')[4] === ATTACK && userTask(e));
  const benign = runs.filter((e) => e.path.split('/')[4] === 'none' && userTask(e));

  const count = { true: 0, false: 0 };
  const a = await draw(
    roundRobin(attacked),
    (run) => {
      const label = String(run.security === true);
      if (count[label] >= ATTACKED_PER_LABEL) return false;
      count[label] += 1;
      return true;
    },
    () => count.true >= ATTACKED_PER_LABEL && count.false >= ATTACKED_PER_LABEL,
  );
  if (count.true < ATTACKED_PER_LABEL || count.false < ATTACKED_PER_LABEL) throw new Error(`the attacked pool ran out: ${count.true} succeeded, ${count.false} failed`);
  let benignKept = 0;
  const b = await draw(
    roundRobin(benign),
    () => (benignKept += 1) <= BENIGN,
    () => benignKept >= BENIGN,
  );

  rmSync(join(OUT, 'runs'), { recursive: true, force: true });
  const manifestRuns = [];
  for (const [set, kept] of [['attacked', a.kept], ['benign', b.kept]]) {
    for (const { entry, bytes, run } of kept) {
      const local = join(OUT, entry.path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, bytes);
      const [, pipeline, suite, userTask] = entry.path.split('/');
      manifestRuns.push({ path: entry.path, blob: entry.sha, set, pipeline, split: splitOf(suite, userTask), ...(set === 'attacked' ? { attackSucceeded: run.security === true } : {}) });
    }
  }
  manifestRuns.sort((x, y) => (x.path < y.path ? -1 : 1));
  const manifest = {
    source: { repository: `https://github.com/${REPOSITORY}`, commit: COMMIT, license: 'MIT (proof/outside/agentdojo/LICENSE)', directory: 'runs/' },
    sampling: {
      tool: 'proof/tools/sample-agentdojo.mjs',
      seed: SEED,
      attack: ATTACK,
      attackedPerLabel: ATTACKED_PER_LABEL,
      benign: BENIGN,
      method: `a user's tasks only (AgentDojo's runs of an attacker's goal as the user's own request are left out); runs ordered by sha256(seed + path) within each pipeline and taken from the pipelines in turn; attacked runs kept until ${ATTACKED_PER_LABEL} with the attack succeeded and ${ATTACKED_PER_LABEL} with it failed; ${BENIGN} runs with no attack; every file checked against the git blob hash at the commit and kept byte for byte`,
      split: 'each task (suite, user task) is in the dev or the test half by sha256(seed + "split" + task); a rule change made after reading these runs may read the dev half only',
    },
    population: { runs: runs.length, attacked: attacked.length, benign: benign.length, pipelines: new Set(runs.map((e) => e.path.split('/')[1])).size },
    read: { attacked: a.read, benign: b.read },
    runs: manifestRuns,
  };
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`sample-agentdojo — wrote ${manifestRuns.length} runs (${a.kept.length} attacked of ${a.read} read, ${b.kept.length} with no attack) and manifest.json to ${OUT}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`sample-agentdojo — ${err.stack ?? err}\n`);
    process.exit(1);
  });
}
