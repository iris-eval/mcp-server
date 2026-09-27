/*
 * The regex sandbox under CPU load (#677).
 *
 * Starts N busy-loop processes (default: one per core), then runs a
 * trivial pattern through the sandbox M times and counts how many it
 * reported as a budget timeout, which for `forbidden` on a short string can
 * only be the host's scheduling, never the pattern. It then runs a real
 * catastrophic-backtracking pattern and reports how long the kill took.
 *
 *   npx tsx scripts/sandbox-load-harness.ts [busy=cores] [calls=2000] [hot|idle|fresh]
 *
 * Prints one JSON line. Exit code 0 always: the caller judges the numbers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { sandboxedRegexTest, shutdownRegexSandbox, REGEX_MATCH_BUDGET_MS } from '../src/eval/rules/regex-sandbox.js';

const busy = Number(process.argv[2] ?? cpus().length);
const calls = Number(process.argv[3] ?? 2000);
/*
 * How the calls are spaced. `hot`: back to back, the worker never idles.
 * `idle`: 5 ms apart, so the worker thread is asleep when each match
 * arrives, as it is between evaluations on a server. `fresh`: the worker
 * is shut down before each call, so every match pays a spawn under load.
 */
const mode = (process.argv[4] ?? 'idle') as 'hot' | 'idle' | 'fresh';

function burn(n: number): ChildProcess[] {
  return Array.from({ length: n }, () =>
    spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }),
  );
}

const burners = burn(busy);
// Let the burners reach full speed before measuring.
await new Promise((r) => setTimeout(r, 1500));

let trivialTimeouts = 0;
let trivialErrors = 0;
let trivialMatches = 0;
const text = 'this response contains a forbidden token';
const started = performance.now();
for (let i = 0; i < calls; i++) {
  if (mode === 'fresh') shutdownRegexSandbox();
  if (mode === 'idle') await new Promise((r) => setTimeout(r, 5));
  const outcome = sandboxedRegexTest('forbidden', '', text);
  if (outcome.kind === 'timeout') trivialTimeouts += 1;
  else if (outcome.kind === 'error') trivialErrors += 1;
  else if (outcome.matched) trivialMatches += 1;
}
const trivialWallMs = Math.round(performance.now() - started);

// A real catastrophic pattern: 2^40 steps if it were allowed to finish.
const kills: number[] = [];
let hostileOutcomes = new Set<string>();
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  const outcome = sandboxedRegexTest('^(a|a)*$', '', 'a'.repeat(40) + 'b');
  kills.push(Math.round(performance.now() - t));
  hostileOutcomes.add(outcome.kind);
}
hostileOutcomes = new Set([...hostileOutcomes]);

for (const b of burners) b.kill();
shutdownRegexSandbox();

kills.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    busy,
    calls,
    mode,
    budgetMs: REGEX_MATCH_BUDGET_MS,
    trivialTimeouts,
    trivialErrors,
    trivialMatches,
    trivialWallMs,
    hostileOutcomes: [...hostileOutcomes],
    hostileKillMs: { min: kills[0], median: kills[kills.length >> 1], max: kills[kills.length - 1] },
  }),
);
process.exit(0);
