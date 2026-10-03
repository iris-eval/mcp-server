/*
 * The session reader as an instrument: Iris's verdicts on the agent turns
 * already on this machine.
 *
 *   npx tsx scripts/read-sessions.ts                         # the 20 latest sessions of every project
 *   npx tsx scripts/read-sessions.ts --project C--dev-repo   # one project's folder under ~/.claude/projects
 *   npx tsx scripts/read-sessions.ts --sessions 50 --origin all --exclude <session id>
 *   npx tsx scripts/read-sessions.ts --config ./iris-config.json --ndjson
 *
 * Reads Claude Code's session logs read only (src/sessions/claude-code.ts)
 * and judges each turn that ended with an answer through the engine, as a
 * trace sent to Iris is judged: the same declaration of what the log holds,
 * and the cost estimated from the tokens and the model. One difference: no
 * cost history, so `cost_anomaly` skips (it needs the agent's stored
 * history). Not judged, and counted: a turn that holds a line that could not
 * be read; one that took a prompt queued while it ran (a person's, a task
 * notification, another session's), since its answer may be to that one;
 * and one whose answer was cut to its head and tail.
 *
 * It prints counts only: turns by who sent the prompt and how they ended,
 * verdicts by state and basis, the rules that fired, the questions left
 * unjudged. None of the sessions' text. The rows, with the start of each ask
 * and the end of each answer, and with --ndjson every turn as a trace for
 * `iris-eval ingest --file` (each holds the whole prompt, answer and tool
 * calls), are written into a new folder of their own in the system's
 * temporary folder, created for this run (or under --out). Files are
 * created, never overwritten, readable by you alone where the system has
 * POSIX permissions; on Windows they are as private as your user's temporary
 * folder. Nothing is stored in Iris, and nothing is sent anywhere.
 */
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readClaudeCodeSession, traceBodyOfTurn, type SessionTurn } from '../src/sessions/claude-code.js';
import { EvalEngine } from '../src/eval/engine.js';
import { loadConfig } from '../src/config/index.js';
import { defaultConfig, PKG_VERSION } from '../src/config/defaults.js';
import { resolveTraceCost } from '../src/cost/trace-cost.js';
import { costContextOf } from '../src/eval/cost-basis.js';
import type { EvalResult } from '../src/types/eval.js';
import type { Trace } from '../src/types/trace.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: join(homedir(), '.claude', 'projects') },
    project: { type: 'string' },
    sessions: { type: 'string', default: '20' },
    origin: { type: 'string', default: 'human' },
    exclude: { type: 'string', multiple: true, default: [] },
    config: { type: 'string' },
    out: { type: 'string' },
    ndjson: { type: 'boolean', default: false },
  },
});

const origins = values.origin === 'all' ? null : new Set(values.origin.split(','));
const limit = Number(values.sessions);
if (!Number.isInteger(limit) || limit < 1) throw new Error(`--sessions takes a whole number above 0, not "${values.sessions}"`);
if (!existsSync(values.root)) throw new Error(`No session logs at ${values.root}. Claude Code keeps them under ~/.claude/projects; pass --root to read another folder.`);

// The latest logs, newest first, across every project or within one.
const folders = values.project ? [join(values.root, values.project)] : readdirSync(values.root).map((d) => join(values.root, d)).filter((d) => statSync(d).isDirectory());
const logs = folders
  .flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => join(d, f)))
  .filter((p) => !values.exclude.some((id) => p.endsWith(`${id}.jsonl`)))
  .map((p) => ({ p, m: statSync(p).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, limit)
  .map((x) => x.p);

const config = values.config ? loadConfig({ config: values.config }) : defaultConfig;
const engine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);

// A folder of this run's own, so no file it writes can be one that was there before.
const base = values.out ?? tmpdir();
mkdirSync(base, { recursive: true });
const outDir = mkdtempSync(join(base, 'iris-sessions-'));
const ndjson = values.ndjson ? createWriteStream(join(outDir, 'turns.ndjson'), { encoding: 'utf8', flags: 'wx', mode: 0o600 }) : null;

const counts = { turns: new Map<string, number>(), skipped: new Map<string, number>(), state: new Map<string, number>(), basis: new Map<string, number>(), fired: new Map<string, number>(), unjudged: new Map<string, number>() };
const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
const rows: Array<Record<string, unknown>> = [];
const stats = { lostLines: 0 };
const started = Date.now();
let read = 0;
let judged = 0;

const judge = async (turn: SessionTurn): Promise<EvalResult> => {
  const body = traceBodyOfTurn(turn, PKG_VERSION);
  // Priced as ingest prices it: the tokens at the model's list price (src/cost/trace-cost.ts).
  const priced = resolveTraceCost({ trace_id: `${turn.session}-${turn.index}`, agent_name: body.agent_name, ...(body.token_usage ? { token_usage: body.token_usage } : {}), metadata: body.metadata, timestamp: body.timestamp } as Trace);
  return engine.evaluateAll({
    input: body.input,
    output: body.output,
    ...(body.tool_calls ? { toolCalls: body.tool_calls } : {}),
    ...(body.token_usage ? { tokenUsage: body.token_usage } : {}),
    ...costContextOf(priced),
    metadata: body.metadata,
    recordedBy: 'harness',
    capture: body.capture,
  });
};

for (const log of logs) {
  for await (const turn of readClaudeCodeSession(log, { stats })) {
    read += 1;
    bump(counts.turns, `${turn.origin} · ${turn.ended}`);
    if (origins && !origins.has(turn.origin)) continue;
    if (ndjson) ndjson.write(`${JSON.stringify(traceBodyOfTurn(turn, PKG_VERSION))}\n`);
    if (turn.ended !== 'answered') continue;
    // A line that could not be read may have been a prompt, so the answer may be to another ask.
    if (turn.lost) {
      bump(counts.skipped, 'holds a line that could not be read');
      continue;
    }
    // A prompt queued mid-turn: the answer may be to that one, so it is not judged against the first.
    if (turn.queued.length > 0) {
      bump(counts.skipped, turn.queued.some((q) => q.origin === 'human') ? 'took a second prompt the person queued mid-turn' : 'took a notification or a message queued mid-turn');
      continue;
    }
    // The answer was cut to its head and tail: the cut is not what the agent wrote.
    if (turn.outputCut) {
      bump(counts.skipped, 'answer cut to its head and tail');
      continue;
    }
    const r = await judge(turn);
    judged += 1;
    const v = r.verdict!;
    bump(counts.state, v.state);
    bump(counts.basis, v.basis);
    const fired = r.rule_results.filter((x) => !x.skipped && !x.passed).map((x) => `${x.ruleName} (${x.role ?? '-'})`);
    for (const f of fired) bump(counts.fired, f);
    for (const q of r.coverage?.questions ?? []) if (q.status === 'unjudged') bump(counts.unjudged, q.id);
    rows.push({
      session: turn.session,
      turn: turn.index,
      origin: turn.origin,
      calls: turn.toolCalls.length,
      failedCalls: turn.toolCalls.filter((c) => c.error !== undefined).length,
      verdict: { state: v.state, basis: v.basis, by: v.by, ...(v.also ? { also: v.also } : {}), ...(v.risk ? { risk: v.risk.pBad } : {}) },
      fired,
      ask: turn.input.slice(0, 300),
      answer: turn.output.slice(-600),
    });
  }
}
ndjson?.end();

const rowsFile = join(outDir, 'rows.json');
writeFileSync(rowsFile, JSON.stringify({ irisVersion: PKG_VERSION, readAt: new Date().toISOString(), sessions: logs.length, rows }, null, 1), { flag: 'wx', mode: 0o600 });

const table = (title: string, m: Map<string, number>): void => {
  console.log(`\n${title}`);
  for (const [k, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
};
console.log(`Iris ${PKG_VERSION}: ${logs.length} session log(s), ${read} turns read, ${judged} judged in ${((Date.now() - started) / 1000).toFixed(1)} s (${values.config ? `config ${values.config}` : 'shipped configuration'}; prompts from ${origins ? [...origins].join(', ') : 'anyone'}).`);
if (stats.lostLines > 0) console.log(`${stats.lostLines} line(s) could not be read; a turn one fell in is not held in full and is not judged.`);
table('Turns, by who sent the prompt and how the turn ended', counts.turns);
if (counts.skipped.size > 0) table('Answered, and not judged', counts.skipped);
table('Verdicts', counts.state);
table('Decided by', counts.basis);
table('Rules that fired (role)', counts.fired);
table('Questions left unjudged', counts.unjudged);
console.log(`\nRows, with the start of each ask and the end of each answer: ${rowsFile}`);
if (values.ndjson) console.log(`Traces for iris-eval ingest --file (the whole of every turn): ${join(outDir, 'turns.ndjson')}`);
