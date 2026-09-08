#!/usr/bin/env node
/*
 * The stranger — the agent-native chain test, as code.
 *
 * A fresh headless Claude Code session, with no prior instruction about Iris,
 * is asked to evaluate three real agent outputs with Iris and say which must
 * not ship. The protocol comes from the arc-zero brief and the six
 * amendments its verifier forced:
 *
 *   - a never-used directory per phase holding ONLY outputs/ (the three
 *     transcripts with their answer keys stripped, generated here, never
 *     hand-copied); this script lives outside it
 *   - a scratch IRIS_HOME per phase, also outside the directory
 *   - `claude -p --permission-mode dontAsk --strict-mcp-config
 *     --output-format stream-json` with a scoped allowlist (not --bare: it skips
 *     the login too; a never-used cwd already has no memory, no CLAUDE.md)
 *   - the MCP path in two phases: phase 1 (A1–A3) discovers the install and
 *     writes the config it would use; phase 2 (A4–A7) starts from that exact
 *     config, with the package spec rewritten to the artefact under test and
 *     the substitution recorded
 *   - A8 is a driver turn on the resumed phase-2 session asking for the judge
 *     with no key
 *   - one HTTP run with no servers attached
 *
 * Grading is by fixed rules over the stream (see grade()), never by
 * re-reading the transcript with a model: A1, A3, A5, A7 on tool-call
 * evidence; A2, A4, A6, A8 on the agent's words with the matched line
 * quoted. Prose grading is brittle across model versions, so every record
 * pins the model id and A6 is the only row graded on wording alone.
 *
 * Usage:
 *   node tests/acceptance/stranger/run.mjs --spec @iris-eval/mcp-server@0.9.0 --out <dir> [--phase all|http|mcp1|mcp2|a8|a9]
 *   node tests/acceptance/stranger/run.mjs --tarball ./iris-eval-mcp-server-0.9.0.tgz --out <dir>
 *
 * The phases can be run separately against one record dir: `--phase mcp2`
 * reuses the config phase 1 wrote there and runs the A8 driver turn after
 * it; rows.json merges across runs. Each phase writes <out>/<phase>.jsonl
 * (the stream), <phase>.stderr.log, <phase>.json (model, cost, wall time,
 * tool calls, denials, README reads) and rows.json — A1–A8 and the HTTP
 * rows with the evidence line per row. The runs cost real money on the
 * account running them (about one to two dollars per phase); a judge key
 * is never required and never passed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(a.slice(2), next);
      i += 1;
    } else args.set(a.slice(2), 'true');
  }
}
const SPEC = args.get('spec') ?? '@iris-eval/mcp-server@latest';
const TARBALL = args.get('tarball') ? resolve(args.get('tarball')) : null;
const PHASE = args.get('phase') ?? 'all';
const OUT = resolve(args.get('out') ?? join(repo, 'stranger-records', new Date().toISOString().slice(0, 10)));
const MODEL = args.get('model'); // optional pin; otherwise the CLI default
/*
 * For the capture phases on a LOCAL build: a JSON argv the capture plugin's
 * Stop hook runs instead of `npx @iris-eval/mcp-server` (e.g.
 * '["node","/path/to/dist/index.js"]'). On the published package this is
 * omitted and the hook resolves the version the manifest pins.
 */
const INGEST_ARGV = args.get('ingest-argv');
mkdirSync(OUT, { recursive: true });

/** The artefact under test, as the agent should install it. */
const PACKAGE_SPEC = TARBALL ?? SPEC;

/* ── The fixed texts. Never edit between releases; a change is a new protocol version. ── */
const PROTOCOL_VERSION = '1';
const PROMPT =
  "Evaluate my agent's outputs with Iris. The three outputs are in ./outputs/ (each file has the prompt, the tool calls and the answer). Tell me which one must not ship and why. Start here: https://www.npmjs.com/package/@iris-eval/mcp-server";
const ENV_NOTE_COMMON =
  'Environment: this is a non-interactive session with no browser. You may run single commands (npx, npm, node, curl, ls, cat) and read or write files under the current directory; compound shell lines are not permitted.';
const ENV_NOTE_HTTP = `${ENV_NOTE_COMMON} No MCP servers are available to this session and none can be attached; if Iris has another way in, find it.`;
const ENV_NOTE_MCP1 = `${ENV_NOTE_COMMON} No MCP servers are attached to this session and none can be attached mid-run. Do the discovery and installation work now: find how Iris is installed and write, to ./mcp-config.json, the exact MCP server config you would attach for a client like Claude Code, then stop and say what you would do next once it is connected. Do not evaluate the outputs in this session.`;
const ENV_NOTE_MCP2 = `${ENV_NOTE_COMMON} Iris is connected to this session as an MCP server named iris-eval; use it.`;
/*
 * The capture phases (0.13.0, rows V1 and V2). A task that never names
 * Iris, in a session where the iris-eval-capture plugin is loaded from the
 * repository (`--plugin-dir`). V1: no MCP server attached — the only way a
 * trace can exist afterwards is the hook. V2: iris-eval attached as well,
 * under the when-clause — the model may log the turn itself, and then the
 * hook must stand down: exactly one trace for the turn, either way.
 */
const CAPTURE_PROMPT = 'Read ./outputs/output-1.json and tell me in two sentences what the agent was asked and what it answered.';
const ENV_NOTE_CAPTURE = `${ENV_NOTE_COMMON} No MCP servers are attached to this session.`;
const A8_DRIVER = "Before I decide, double-check output 2 with Iris's LLM judge as well, and tell me what it says.";
/*
 * A9 (0.12.0). The question a single verdict cannot answer, asked the way a
 * user would ask it — no tool named, no run ids supplied, no hint that runs
 * exist. The agent has to find that comparison is possible, tag the two
 * cohorts, and read back a result that includes an interval.
 *
 * Graded on the interval, not on the direction: with three outputs a side
 * the honest answer is "not enough evidence", and an agent that reports a
 * confident regression from six cases has failed the row rather than passed
 * it. This is the one acceptance row where the RIGHT answer is a refusal.
 *
 * FIXTURE FIDELITY, found by the 0.12.0 run and fixed after it. The cohort
 * was byte-identical to the first, and the prompt called it "the new
 * answers" — so the prompt asserted something false, and the stranger
 * caught it on md5 and on latency_ms matching to the millisecond. It still
 * passed the row, and its reasoning was better for having caught it, but an
 * acceptance instrument must not lie to the agent it is measuring. The
 * cohort is now genuinely re-answered: the same three prompts, with the
 * answers perturbed so pairing still works on the input-derived case key.
 */
const A9_DRIVER =
  "I re-ran the same three prompts after a prompt change — the new answers are in ./outputs-v2/. Has my agent regressed since yesterday? Log both sets so you can compare them properly, and tell me how confident the answer is.";

/*
 * A10 — the loop lands untold. A task that never mentions Iris, on the
 * connected session: the instructions' WHEN paragraph is the only thing
 * that could make the agent log and evaluate what it produced. Graded on
 * tool-call evidence: a log_trace with evaluate: true, or a log_trace
 * followed by an evaluate_output, after the driver.
 */
const A10_DRIVER =
  'Read ./outputs/output-1.json and tell me in two sentences what the agent was asked and what it answered.';

const ALLOWED_TOOLS = [
  'Bash(npx:*)',
  'Bash(npm:*)',
  'Bash(node:*)',
  'Bash(curl:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Read',
  'Write',
  'Edit',
  'WebFetch',
  'WebSearch',
  'mcp__iris-eval__*',
];

/* ── outputs/: the three transcripts, answer keys stripped, generated here ── */
const FIXTURES = [
  ['t-01-readme-install.json', 'output-1.json'],
  ['t-07-support-ticket-ssn.json', 'output-2.json'],
  ['t-13-grep-no-match.json', 'output-3.json'],
];
/*
 * The A9 cohort: the same three PROMPTS answered again, so "did it regress?"
 * has two sets to compare and the pairing key (derived from the input) still
 * matches. The answers are perturbed rather than copied — a re-run that
 * reproduces its own wall-clock latency to the millisecond is not a re-run,
 * and the 0.12.0 stranger said so.
 *
 * The perturbation is deliberately SMALL and not a planted regression: the
 * row measures whether the agent can compare at all and whether it carries
 * the confidence through, not whether it can spot a difference the fixture
 * author chose. A planted regression would grade the fixture.
 */
function makeA9Cohort(dir) {
  const outputs = join(dir, 'outputs-v2');
  mkdirSync(outputs, { recursive: true });
  FIXTURES.forEach(([src, dst], i) => {
    const fixture = JSON.parse(readFileSync(join(repo, 'tests', 'fixtures', 'real-transcripts', src), 'utf8'));
    delete fixture.metadata;
    // A second run of the same prompt: same question, a differently-worded
    // answer, and timings that are not the first run's to the millisecond.
    if (typeof fixture.output === 'string') {
      fixture.output = `${fixture.output}

(Re-run after the prompt change.)`;
    }
    if (typeof fixture.latency_ms === 'number') fixture.latency_ms = Math.round(fixture.latency_ms * (0.82 + i * 0.11));
    if (typeof fixture.cost_usd === 'number') fixture.cost_usd = Number((fixture.cost_usd * (0.94 + i * 0.05)).toFixed(6));
    writeFileSync(join(outputs, dst), JSON.stringify(fixture, null, 2));
  });
  return outputs;
}

function makePhaseDir(phase) {
  const dir = mkdtempSync(join(tmpdir(), `iris-stranger-${phase}-`));
  const outputs = join(dir, 'outputs');
  mkdirSync(outputs);
  for (const [src, dst] of FIXTURES) {
    const raw = JSON.parse(readFileSync(join(repo, 'tests', 'fixtures', 'real-transcripts', src), 'utf8'));
    delete raw.metadata;
    writeFileSync(join(outputs, dst), JSON.stringify(raw, null, 2));
  }
  const home = mkdtempSync(join(tmpdir(), `iris-stranger-home-${phase}-`));
  return { dir, home };
}

/* ── running claude -p and capturing the stream ── */
/** The Claude Code executable: the npm shim's target on Windows, `claude` on a PATH elsewhere. */
function claudeBinary() {
  if (process.platform === 'win32') {
    const shimTarget = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(shimTarget)) return shimTarget;
  }
  return 'claude';
}

function runClaude({ phase, cwd, home, prompt, mcpConfig, resume, pluginDir, extraEnv }) {
  // Not `--bare`: it also skips the keychain and OAuth reads, so the session
  // runs "Not logged in" and ends on an api_error before a single call. The
  // isolation the verifier asked for holds without it — a never-used cwd has
  // no CLAUDE.md, no project settings and an empty per-directory memory, and
  // --strict-mcp-config keeps every other server off the session.
  const cli = ['-p', prompt, '--permission-mode', 'dontAsk', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--allowedTools', ...ALLOWED_TOOLS];
  if (mcpConfig) cli.push('--mcp-config', mcpConfig);
  if (pluginDir) cli.push('--plugin-dir', pluginDir);
  if (resume) cli.push('--resume', resume);
  if (MODEL) cli.push('--model', MODEL);
  const started = Date.now();
  const env = { ...process.env, IRIS_HOME: home, ...(extraEnv ?? {}) };
  for (const k of Object.keys(env)) if (/^IRIS_(ANTHROPIC|OPENAI)_API_KEY$/.test(k)) delete env[k];
  return new Promise((resolveRun, reject) => {
    // Never through a shell: on Windows the npm `claude` shim is a .cmd that
    // hands cmd.exe the whole line, and a multi-line prompt argument comes
    // apart there (the first run captured plain text and zero tool calls).
    // Spawn the executable the shim wraps, with an argument array, and give
    // it no stdin so it never waits three seconds for a prompt on a pipe.
    const child = spawn(claudeBinary(), cli, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      writeFileSync(join(OUT, `${phase}.jsonl`), out);
      writeFileSync(join(OUT, `${phase}.stderr.log`), err);
      resolveRun({ code, out, err, wallMs: Date.now() - started });
    });
  });
}

function parseStream(out) {
  const events = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { events.push(JSON.parse(t)); } catch { /* partial line */ }
  }
  return events;
}

/** Tool calls, results, assistant text and the final result, in stream order. */
function digest(events) {
  const calls = [];
  const byId = new Map();
  const texts = [];
  let init = null;
  let result = null;
  for (const ev of events) {
    if (ev.type === 'system' && ev.subtype === 'init') init = ev;
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'tool_use') {
          const call = { id: block.id, name: block.name, input: block.input, result: null, isError: false };
          calls.push(call);
          byId.set(block.id, call);
        } else if (block.type === 'text' && block.text) texts.push(block.text);
      }
    }
    if (ev.type === 'user') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const call = byId.get(block.tool_use_id);
          const content = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join('\n') : String(block.content ?? '');
          if (call) {
            call.result = content;
            call.isError = Boolean(block.is_error);
          }
        }
      }
    }
    if (ev.type === 'result') result = ev;
  }
  return { init, calls, texts, result, finalText: result?.result ?? texts[texts.length - 1] ?? '' };
}

const isIris = (name) => /^mcp__iris-eval__/.test(name ?? '');
const irisName = (name) => name.replace(/^mcp__iris-eval__/, '');
const denied = (c) => c.isError && /denied|not allowed|permission/i.test(c.result ?? '');
const readmeRead = (c) => /README/i.test(JSON.stringify(c.input ?? '')) && (c.name === 'WebFetch' || c.name === 'Read' || /Bash/.test(c.name));
const quote = (s, n = 220) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function summarise(phase, d, wallMs, substitution) {
  const rec = {
    phase,
    protocol: PROTOCOL_VERSION,
    spec: PACKAGE_SPEC,
    substitution,
    model: d.init?.model ?? d.result?.model ?? null,
    sessionId: d.init?.session_id ?? d.result?.session_id ?? null,
    mcpServers: d.init?.mcp_servers ?? [],
    toolCalls: d.calls.length,
    irisCalls: d.calls.filter((c) => isIris(c.name)).map((c) => irisName(c.name)),
    denials: d.calls.filter(denied).length,
    readmeReads: d.calls.filter(readmeRead).length,
    costUsd: d.result?.total_cost_usd ?? null,
    wallMs,
    turns: d.result?.num_turns ?? null,
    finalText: d.finalText,
  };
  writeFileSync(join(OUT, `${phase}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

/* ── grading ── */
/*
 * A10 (0.13.0): the untold task must be a fresh session. Resumed on the
 * connected phase, the agent already had the file in context, used no tool,
 * and — exactly as the when-clause says ("not every line") — logged nothing:
 * 0 calls. The same prompt in a fresh session with iris-eval attached (the
 * capture-both phase) produced a self-initiated log_trace with evaluate. So
 * A10 grades that session when it exists, and the resumed driver otherwise.
 */
function grade({ mcp1, mcp2, a8, a9, a10, http, capture, captureBoth }) {
  const rows = {};
  const row = (id, pass, evidence, note) => { rows[id] = { pass, evidence: quote(evidence), ...(note ? { note } : {}) }; };

  if (mcp1) {
    const d = mcp1.d;
    const discovery = d.calls.find((c) => (c.name === 'WebFetch' && /npmjs|registry|github|iris-eval/i.test(JSON.stringify(c.input))) || (/Bash/.test(c.name) && /npx .*iris-eval/.test(JSON.stringify(c.input))));
    const wrote = d.calls.find((c) => (c.name === 'Write' || c.name === 'Edit') && /mcp-config\.json/.test(JSON.stringify(c.input)));
    row('A1', Boolean(discovery && wrote), discovery ? `${discovery.name} ${JSON.stringify(discovery.input)}` : 'no discovery fetch', wrote ? undefined : 'no mcp-config.json written');
    row('A3', Boolean(mcp1.config?.mcpServers && Object.keys(mcp1.config.mcpServers).length === 1), JSON.stringify(mcp1.config ?? null), mcp1.substitution);
  }
  if (mcp2) {
    const d = mcp2.d;
    const connected = (d.init?.mcp_servers ?? []).some((s) => /iris/.test(s.name) && /connect/i.test(s.status));
    row('A3-connected', connected, JSON.stringify(d.init?.mcp_servers ?? []));
    const firstIris = d.calls.findIndex((c) => isIris(c.name));
    const readmeAfterConnect = d.calls.findIndex((c) => readmeRead(c));
    /*
     * "Distinguishes" (re-derived 0.13.0): the answer names a verdict per
     * output in the composer's words — ship / must not ship, passed / failed,
     * veto, basis — not the score era's "passed" AND "score". The 0.13.0
     * stranger wrote "Output 2 must not ship. Iris vetoed it on the critical
     * no_pii rule" and the old regex, wanting the word "score", failed it.
     */
    const distinguishes =
      /(must not ship|should not ship|don't ship|do not ship)/i.test(d.finalText) &&
      /\b(pass|passed|passes|clean|ship)\b/i.test(d.finalText) &&
      /(output[- ]?[123]|first|second|third)/i.test(d.finalText);
    row('A2', firstIris >= 0 && (readmeAfterConnect < 0 || firstIris < readmeAfterConnect) && distinguishes, d.finalText, readmeAfterConnect >= 0 ? `README read at call #${readmeAfterConnect + 1}` : undefined);
    /*
     * A4 counts EVALUATIONS, not one tool (0.13.0). `log_trace` with
     * `evaluate: true` scores the trace in the same call — the path the
     * instructions now recommend — and the 0.13.0 stranger used it three
     * times; a row that counted `evaluate_output` alone graded the route.
     */
    const evalOutputs = d.calls.filter((c) => irisName(c.name) === 'evaluate_output');
    const logEvals = d.calls.filter((c) => irisName(c.name) === 'log_trace' && c.input?.evaluate === true);
    const judges = d.calls.filter((c) => /evaluate_with_llm_judge|verify_citations/.test(irisName(c.name)));
    row('A4', evalOutputs.length + logEvals.length >= 3 && judges.length === 0, `evaluate_output ×${evalOutputs.length}, log_trace with evaluate ×${logEvals.length}, judge ×${judges.length}`);
    const invalid = d.calls.filter((c) => isIris(c.name) && /IRIS_INVALID_ARGUMENT|Invalid arguments/.test(c.result ?? ''));
    const corrected = invalid.every((c) => { const i = d.calls.indexOf(c); return d.calls.slice(i + 1).some((n) => n.name === c.name && !/IRIS_INVALID_ARGUMENT|Invalid arguments/.test(n.result ?? '')); });
    row('A5', invalid.length === 0 || (invalid.length === 1 && corrected), invalid.length ? invalid[0].result : 'zero invalid-argument results');
    const t = d.finalText;
    const out2 = /no_pii/.test(t);
    /*
     * 0.10.0 changed what an agent can quote here, and this row is graded
     * on wording, so the rule has to change with it.
     *
     * The verdict's `by` used to name the RULE. When the basis is
     * risk_over_loss it names the failure CLASS, so an agent reading the
     * verdict writes "silent_tool_failure" and not
     * "no_silent_tool_failure". Both are correct; either counts.
     *
     * The old rule also required the agent to say the output "still
     * passed", which was true while a silent tool failure could not move
     * the verdict. It now FAILS, which is the point of the arc. What the
     * row asks for is that the agent names the failure and says what the
     * verdict was — not that the verdict came out a particular way.
     *
     * And the output-1 probe demanded that "output 1" precede "passed" or
     * "clean" in the same sentence. An agent that writes "the clean
     * verdict for output-1" said the same thing in the other order.
     */
    const out3 =
      /\bno_silent_tool_failure\b|\bsilent_tool_failure\b/.test(t) &&
      /(still|nonetheless|only blocks one|not critical|passed anyway|bundle passed|verdict.*pass|risk_over_loss|also fails|fails the gate|don't ship)/i.test(t);
    const out1 =
      /(output[- ]?1|first output)/i.test(t) &&
      /\b(passed|clean)\b/i.test(t) &&
      /(not judged|unjudged|skipped|cost_usd|no cost|coverage)/i.test(t);
    row('A6', out2 && out3 && out1, t, `out2:${out2} out3:${out3} out1:${out1}`);
    /*
     * A7 (0.13.0): with `evaluate: true` the evaluation comes back inline and
     * there is no link to follow — the row's proposition ("the agent logged
     * and read the evaluation") is met by the inline result as much as by a
     * resource read. Either counts; a log with neither still fails.
     */
    const logged = d.calls.some((c) => irisName(c.name) === 'log_trace');
    const followed = d.calls.some((c) => /ReadMcpResource|readResource|iris:\/\//.test(`${c.name} ${JSON.stringify(c.input)}`)) || /iris:\/\/(evaluations|traces)\//.test(t);
    const inline = logEvals.length > 0;
    row('A7', logged && (followed || inline), logged ? `log_trace called (${inline ? 'evaluated inline' : 'no inline evaluation'})` : 'no log_trace', followed || inline ? undefined : 'no resource followed and no inline evaluation');
    /*
     * The ceiling is a measurement, not a wish (A6-9). 0.9.0 measured 14
     * calls after connection (3 logs, 3 evaluations, 8 reads); 0.10.0
     * measured 12 for the same work with fewer reads, because the verdict
     * had started to carry its basis. Twelve is the 0.10.0 measurement held
     * as the bar: a run above it means the surfaces made the agent read more
     * than the verdict should require. With `log_trace` evaluating in the
     * same call (0.13.0) the same work is six calls; the bar stays at twelve
     * until a release measures under it, and then moves to that number.
     */
    /*
     * Host mechanics do not count (0.13.0): Claude Code now defers MCP tools
     * behind ToolSearch, keeps an auto-memory the agent writes to, and spills
     * long tool results to files it then reads back. None of those calls is
     * the product making the agent read more; the 0.13.0 run had 7 of them
     * in 20. They are named in the evidence and excluded from the count.
     */
    const hostCall = (c) =>
      c.name === 'ToolSearch' ||
      ((c.name === 'Write' || c.name === 'Edit' || c.name === 'Read') && /[\\/]memory[\\/]|MEMORY\.md|[\\/]tool-results[\\/]/.test(JSON.stringify(c.input ?? {})));
    const hostCalls = d.calls.filter(hostCall).length;
    const afterConnect = d.calls.length - hostCalls;
    row('within-12-calls', afterConnect <= 12 && readmeAfterConnect < 0, `${afterConnect} tool calls after connection (${d.calls.length} including ${hostCalls} host-side: ToolSearch, auto-memory, spilled results); README reads after connection: ${readmeAfterConnect >= 0 ? 1 : 0}`);
  }
  if (a8) {
    const d = a8.d;
    const refused = d.calls.filter((c) => isIris(c.name) && /IRIS_JUDGE_NOT_ENABLED/.test(c.result ?? ''));
    const searched = d.calls.filter((c) => c.name === 'WebSearch' || c.name === 'WebFetch');
    const t = d.finalText;
    row('A8', refused.length >= 1 && searched.length === 0 && /IRIS_(ANTHROPIC|OPENAI)_API_KEY/.test(t) && /restart/i.test(t), t, `refused ×${refused.length}, web ×${searched.length}`);
  }
  if (a9) {
    const d = a9.d;
    const compared = d.calls.filter((c) => /compare_(runs|traces)/.test(irisName(c.name) ?? ''));
    const t = d.finalText;
    /*
     * An interval in the answer, in any of the forms the tool prints it —
     * a bracketed pair, a ± , or the words. Graded on the CONFIDENCE being
     * carried through to the user, because a comparison quoted without one
     * is the failure mode this arc exists to prevent.
     */
    const carriesInterval = /\[\s*-?\d|±|\binterval\b|not enough evidence|cannot tell|too few|smallest detectable/i.test(t);
    row('A9', compared.length >= 1 && carriesInterval, t, `compare calls ×${compared.length}`);
  }
  if (captureBoth) a10 = { d: captureBoth.d, rec: captureBoth.rec, fresh: true };
  if (a10) {
    const d = a10.d;
    const logs = d.calls.filter((c) => irisName(c.name) === 'log_trace');
    const inline = logs.some((c) => c.input?.evaluate === true);
    const after = logs.length > 0 && d.calls.some((c, i) => irisName(c.name) === 'evaluate_output' && i > d.calls.indexOf(logs[0]));
    row('A10', logs.length >= 1 && (inline || after), logs.length ? JSON.stringify(logs[0].input).slice(0, 400) : 'no log_trace after an untold task', `log_trace ×${logs.length}, inline evaluate: ${inline}, evaluate_output after: ${after}`);
  }
  if (capture) {
    /*
     * V1 (F8): capture needs no cooperation. The session never named Iris
     * and had no Iris tools; a trace with the prompt, the answer and the
     * tool calls exists afterwards, with a verdict, because the hook sent
     * it. Graded on the stored row, not on the transcript.
     */
    const t = capture.traces;
    const hooked = t.filter((x) => x.source === 'hook');
    const one = hooked[0];
    const ok = Boolean(one) && one.input.length > 0 && one.output.length > 0 && one.tool_calls.length > 0 && one.evaluations > 0 && !capture.d.calls.some((c) => isIris(c.name));
    row('V1', ok, one ? `trace ${one.trace_id.slice(0, 8)} source=${one.source} input=${one.input.length} chars output=${one.output.length} chars tool_calls=${one.tool_calls.length} evaluations=${one.evaluations}; ${t.length} trace(s) in the home` : `no hook trace (${t.length} trace(s) in the home)`, capture.log ? `capture.log: ${capture.log.slice(-400)}` : undefined);
  }
  if (captureBoth) {
    /*
     * V2 (F15): the hook and the model must not both log one turn. With
     * iris-eval attached and the when-clause in force the model may call
     * log_trace itself; the hook then stands down. Exactly one trace for
     * the turn, its source stated, and no Iris call inside its trajectory.
     */
    const t = captureBoth.traces;
    const one = t[0];
    const irisInside = one ? one.tool_calls.some((c) => /iris-eval|iris_eval/.test(String(c.tool_name ?? c.name ?? ''))) : false;
    const ok = t.length === 1 && Boolean(one.source) && one.evaluations > 0 && !irisInside;
    row('V2', ok, one ? `${t.length} trace(s); source=${one.source} evaluations=${one.evaluations} tool_calls=${one.tool_calls.length} iris-call-inside=${irisInside}; model logged itself: ${captureBoth.d.calls.some((c) => irisName(c.name) === 'log_trace')}` : `${t.length} trace(s) in the home`, captureBoth.log ? `capture.log: ${captureBoth.log.slice(-400)}` : undefined);
  }
  if (http) {
    const d = http.d;
    /*
     * The H rows grade the OUTCOME on any of the three routes (A6-9).
     *
     * The 0.12.0 run started Iris over HTTP, evaluated the three outputs
     * through MCP-over-HTTP, and wrote the right answer in the right words
     * ("Must not ship: output-3 … basis risk_over_loss, silent_tool_failure")
     * — and every H row failed, because each was written for the REST route
     * alone: a POST to /api/v1/traces, a read of /api/v1/capabilities, the
     * rule spelled `no_silent_tool_failure`. The routes are REST ingest,
     * MCP over HTTP, and the CLI (`iris-eval ingest`, 0.13.0); the same
     * substantive answer grades identically on all three.
     */
    const inputOf = (c) => JSON.stringify(c.input ?? {});
    const bash = (c) => /Bash/.test(c.name);
    const started = d.calls.find((c) => bash(c) && /--dashboard|--transport http|\bingest\b/.test(inputOf(c)));
    const health = d.calls.some((c) => /api\/v1\/health/.test(inputOf(c)) && /200|"status"\s*:\s*"ok"/.test(c.result ?? ''));
    const restIngest = d.calls.filter((c) => /api\/v1\/traces/.test(inputOf(c)) && /evaluate/.test(inputOf(c)) && /evaluation_id|"passed"|verdict/.test(c.result ?? ''));
    const mcpOverHttp = d.calls.filter((c) => /\/mcp\b/.test(inputOf(c)) && /evaluate_output|log_trace/.test(inputOf(c)) && /verdict|"passed"/.test(c.result ?? ''));
    const cliIngest = d.calls.filter((c) => bash(c) && /\bingest\b/.test(inputOf(c)) && /--evaluate/.test(inputOf(c)));
    // One CLI call can carry three traces (NDJSON): count the verdict lines it printed, not the calls.
    const cliEvaluations = cliIngest.reduce((n, c) => n + ((c.result ?? '').match(/"evaluation_id"/g) ?? []).length, 0);
    const evaluations = restIngest.length + mcpOverHttp.length + cliEvaluations;
    const route = restIngest.length ? 'REST ingest' : mcpOverHttp.length ? 'MCP over HTTP' : cliEvaluations ? 'CLI ingest' : 'none';
    row('H-A3', Boolean(started) && (health || evaluations > 0), started ? `${route}: ${inputOf(started).slice(0, 240)}` : 'no server started and no ingest run');
    row('H-A4', evaluations >= 3, `evaluations evidenced: ${evaluations} (REST ${restIngest.length}, MCP-over-HTTP ${mcpOverHttp.length}, CLI ${cliEvaluations})`);
    const t = d.finalText;
    const out3 = /\bno_silent_tool_failure\b|\bsilent_tool_failure\b/.test(t) && /(output[- ]?3|third output|telemetry)/i.test(t);
    const out2 = /\bno_pii\b|\bPII\b/.test(t) && /(output[- ]?2|second output)/i.test(t);
    const basis = /\b(policy_gate|detector_veto|critical_unknown|required_evidence_missing|risk_over_loss|clean|no_rules)\b/.test(t);
    row('H-A6', out3 && out2 && basis, t, `out3:${out3} out2:${out2} basis:${basis}`);
    const capabilities = d.calls.some((c) => /api\/v1\/capabilities|iris:\/\/capabilities|--self-test|--help/.test(inputOf(c)));
    row('H-A2', capabilities, capabilities ? 'read what this server can judge (the route, the resource, --self-test or --help)' : 'never read what this server can judge');
  }
  return rows;
}

/**
 * The config the stranger wrote, made runnable: the package spec rewritten to
 * the artefact under test (a pre-release tarball, or the exact version) with
 * the substitution recorded, and an IRIS_HOME placeholder injected per phase.
 */
function prepareConfig(written) {
  const config = JSON.parse(JSON.stringify(written));
  let substitution = null;
  const keyRemovals = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (Array.isArray(server.args)) {
      const before = [...server.args];
      server.args = server.args.map((a) => (/^@iris-eval\/mcp-server(@.*)?$/.test(a) ? PACKAGE_SPEC : a));
      if (JSON.stringify(before) !== JSON.stringify(server.args)) substitution = `${name}: args ${JSON.stringify(before)} → ${JSON.stringify(server.args)}`;
    }
    /*
     * A judge key the stranger wrote into its own config is REMOVED, and the
     * removal is recorded.
     *
     * A8's entire premise is "ask for the judge with no key". The process
     * environment is already scrubbed before spawning, but the MCP config's
     * own env block is passed by the client to the server process and was
     * not — so on the 0.12.0 run the stranger's phase-1 config carried
     * "IRIS_ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}", the judge came up
     * enabled with a value that was not a key, and A8 was graded against an
     * IRIS_PROVIDER_ERROR it was never written for. The row measured the
     * harness rather than the product.
     *
     * Writing that env line is CORRECT behaviour by the stranger — it is
     * what the docs tell a user to do — so the fix belongs here, not in the
     * prompt. Recorded rather than silent, because a run whose config was
     * altered must say so.
     */
    for (const key of Object.keys(server.env ?? {})) {
      if (/^IRIS_(ANTHROPIC|OPENAI)_API_KEY$/.test(key)) {
        delete server.env[key];
        keyRemovals.push(`${name}.env.${key}`);
      }
    }
    server.env = { ...(server.env ?? {}), IRIS_HOME: '${IRIS_HOME}' };
  }
  if (keyRemovals.length > 0) {
    substitution = [substitution, `judge key removed so A8 asks with none: ${keyRemovals.join(', ')}`].filter(Boolean).join('; ');
  }
  return { config, substitution };
}

/* ── the phases ── */
async function phaseMcp1() {
  const { dir, home } = makePhaseDir('mcp1');
  const r = await runClaude({ phase: 'mcp1', cwd: dir, home, prompt: `${PROMPT}\n\n${ENV_NOTE_MCP1}` });
  const d = digest(parseStream(r.out));
  let config = null;
  let substitution = null;
  const cfgPath = join(dir, 'mcp-config.json');
  if (existsSync(cfgPath)) {
    writeFileSync(join(OUT, 'mcp-config-as-written.json'), readFileSync(cfgPath, 'utf8'));
    ({ config, substitution } = prepareConfig(JSON.parse(readFileSync(cfgPath, 'utf8'))));
  }
  const rec = summarise('mcp1', d, r.wallMs, substitution);
  return { d, rec, config, substitution };
}

async function phaseMcp2(config) {
  const { dir, home } = makePhaseDir('mcp2');
  const resolved = JSON.parse(JSON.stringify(config));
  for (const server of Object.values(resolved.mcpServers ?? {})) server.env = { ...(server.env ?? {}), IRIS_HOME: home };
  const cfgPath = join(dirname(dir), `iris-stranger-mcp2-config-${Date.now()}.json`);
  writeFileSync(cfgPath, JSON.stringify(resolved));
  writeFileSync(join(OUT, 'mcp-config-as-run.json'), JSON.stringify(resolved, null, 2));
  const r = await runClaude({ phase: 'mcp2', cwd: dir, home, prompt: `${PROMPT}\n\n${ENV_NOTE_MCP2}`, mcpConfig: cfgPath });
  const d = digest(parseStream(r.out));
  const rec = summarise('mcp2', d, r.wallMs, null);
  return { d, rec, dir, home, cfgPath };
}

async function phaseA8(mcp2) {
  const r = await runClaude({ phase: 'a8', cwd: mcp2.dir, home: mcp2.home, prompt: A8_DRIVER, mcpConfig: mcp2.cfgPath, resume: mcp2.rec.sessionId });
  const d = digest(parseStream(r.out));
  const rec = summarise('a8', d, r.wallMs, null);
  return { d, rec };
}

async function phaseA9(mcp2) {
  makeA9Cohort(mcp2.dir);
  const r = await runClaude({ phase: 'a9', cwd: mcp2.dir, home: mcp2.home, prompt: A9_DRIVER, mcpConfig: mcp2.cfgPath, resume: mcp2.rec.sessionId });
  const d = digest(parseStream(r.out));
  const rec = summarise('a9', d, r.wallMs, null);
  return { d, rec };
}

async function phaseA10(mcp2) {
  const r = await runClaude({ phase: 'a10', cwd: mcp2.dir, home: mcp2.home, prompt: A10_DRIVER, mcpConfig: mcp2.cfgPath, resume: mcp2.rec.sessionId });
  const d = digest(parseStream(r.out));
  const rec = summarise('a10', d, r.wallMs, null);
  return { d, rec };
}

async function phaseHttp() {
  const { dir, home } = makePhaseDir('http');
  const r = await runClaude({ phase: 'http', cwd: dir, home, prompt: `${PROMPT}\n\n${ENV_NOTE_HTTP}` });
  const d = digest(parseStream(r.out));
  const rec = summarise('http', d, r.wallMs, null);
  return { d, rec };
}

/** The traces in a scratch home, read straight off the file, with how many evaluations each carries. */
function readTraces(home) {
  const file = join(home, 'iris.db');
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT trace_id, source, input, output, tool_calls FROM traces ORDER BY created_at').all();
    const count = db.prepare('SELECT count(*) AS n FROM eval_results WHERE trace_id = ?');
    return rows.map((t) => ({
      trace_id: t.trace_id,
      source: t.source,
      input: t.input ?? '',
      output: t.output ?? '',
      tool_calls: t.tool_calls ? JSON.parse(t.tool_calls) : [],
      evaluations: count.get(t.trace_id).n,
    }));
  } finally {
    db.close();
  }
}

/** The hook's ingest runs detached and outlives the session; wait for its row and verdict. */
async function waitForTraces(home, ms) {
  const until = Date.now() + ms;
  let traces = [];
  while (Date.now() < until) {
    try {
      traces = readTraces(home);
    } catch {
      traces = [];
    }
    if (traces.length > 0 && traces.every((t) => t.evaluations > 0)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return traces;
}

/** Whatever the capture plugin logged: under CLAUDE_PLUGIN_DATA if the host set it, else its tmpdir fallback. */
function captureLog(pluginData) {
  // Claude Code sets CLAUDE_PLUGIN_DATA itself (…/.claude/plugins/data/<plugin>-inline for --plugin-dir);
  // the harness's own dir and the plugin's tmpdir fallback are read as well.
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const dir of [join(home, '.claude', 'plugins', 'data', 'iris-eval-capture-inline'), join(home, '.claude', 'plugins', 'data', 'iris-eval-capture'), pluginData, join(tmpdir(), 'iris-eval-capture')]) {
    const f = join(dir, 'capture.log');
    if (existsSync(f)) return readFileSync(f, 'utf8').split('\n').slice(-12).join('\n');
  }
  return '';
}

async function phaseCapture(kind, connectedConfig) {
  const { dir, home } = makePhaseDir(kind);
  const pluginData = mkdtempSync(join(tmpdir(), `iris-stranger-plugin-data-${kind}-`));
  let mcpConfig = null;
  if (kind === 'capture-both') {
    const resolved = JSON.parse(JSON.stringify(connectedConfig));
    for (const server of Object.values(resolved.mcpServers ?? {})) server.env = { ...(server.env ?? {}), IRIS_HOME: home };
    mcpConfig = join(dirname(dir), `iris-stranger-${kind}-config-${Date.now()}.json`);
    writeFileSync(mcpConfig, JSON.stringify(resolved));
  }
  const extraEnv = { CLAUDE_PLUGIN_DATA: pluginData, ...(INGEST_ARGV ? { IRIS_CAPTURE_INGEST_ARGV: INGEST_ARGV } : {}) };
  const r = await runClaude({
    phase: kind,
    cwd: dir,
    home,
    prompt: `${CAPTURE_PROMPT}\n\n${kind === 'capture-both' ? ENV_NOTE_MCP2 : ENV_NOTE_CAPTURE}`,
    mcpConfig,
    pluginDir: join(repo, 'claude-plugin-capture'),
    extraEnv,
  });
  const d = digest(parseStream(r.out));
  const traces = await waitForTraces(home, 90_000);
  const log = captureLog(pluginData);
  writeFileSync(join(OUT, `${kind}-traces.json`), JSON.stringify(traces, null, 2));
  writeFileSync(join(OUT, `${kind}-capture.log`), log);
  const rec = summarise(kind, d, r.wallMs, null);
  return { d, rec, traces, log };
}

const results = {};
const want = (p) => PHASE === 'all' || PHASE === p;
/*
 * --regrade: re-read every phase transcript already in --out and grade it
 * under the CURRENT rules, running nothing. A grading fix (A4, A7, A10 and
 * the H rows have each been re-derived after a run) is proven against the
 * transcript that exposed it, not against a fresh run that may differ.
 */
if (args.get('regrade') === 'true') {
  const load = (phase) => (existsSync(join(OUT, `${phase}.jsonl`)) ? { d: digest(parseStream(readFileSync(join(OUT, `${phase}.jsonl`), 'utf8'))), rec: {} } : null);
  const re = {};
  const m1 = load('mcp1');
  if (m1) re.mcp1 = { ...m1, config: existsSync(join(OUT, 'mcp-config-as-written.json')) ? JSON.parse(readFileSync(join(OUT, 'mcp-config-as-written.json'), 'utf8')) : null, substitution: null };
  for (const phase of ['mcp2', 'a8', 'a9', 'a10', 'http']) { const r = load(phase); if (r) re[phase] = r; }
  for (const [phase, key] of [['capture', 'capture'], ['capture-both', 'captureBoth']]) {
    const r = load(phase);
    if (!r) continue;
    const traces = existsSync(join(OUT, `${phase}-traces.json`)) ? JSON.parse(readFileSync(join(OUT, `${phase}-traces.json`), 'utf8')) : [];
    const log = existsSync(join(OUT, `${phase}-capture.log`)) ? readFileSync(join(OUT, `${phase}-capture.log`), 'utf8') : '';
    re[key] = { ...r, traces, log };
  }
  const rows = grade(re);
  const previous = existsSync(join(OUT, 'rows.json')) ? JSON.parse(readFileSync(join(OUT, 'rows.json'), 'utf8')) : {};
  const record = { ...previous, regradedAt: new Date().toISOString(), rows: { ...(previous.rows ?? {}), ...rows } };
  writeFileSync(join(OUT, 'rows.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}
const line = (name, rec) => console.log(`${name}: ${rec.toolCalls} calls, $${rec.costUsd}, ${Math.round(rec.wallMs / 1000)}s, denials ${rec.denials}${rec.irisCalls.length ? `, iris ${rec.irisCalls.join(',')}` : ''}`);
const savedConfig = join(OUT, 'mcp-config-as-written.json');
let connectedConfig = null;
if (want('mcp1')) {
  results.mcp1 = await phaseMcp1();
  line('mcp1', results.mcp1.rec);
  connectedConfig = results.mcp1.config;
} else if ((want('mcp2') || want('a8') || want('a9') || want('a10') || want('capture-both')) && existsSync(savedConfig)) {
  // Reuse the config phase 1 wrote on an earlier run of this record dir.
  connectedConfig = prepareConfig(JSON.parse(readFileSync(savedConfig, 'utf8'))).config;
}
if (PHASE === 'a8' && existsSync(join(OUT, 'mcp2.jsonl')) && existsSync(join(OUT, 'mcp-config-as-run.json'))) {
  // The driver turn alone, resumed on the connected phase already in this
  // record dir: its cwd and session id from the stream's init event, its
  // config (with the scratch home) from the as-run copy.
  const d2 = digest(parseStream(readFileSync(join(OUT, 'mcp2.jsonl'), 'utf8')));
  const asRun = JSON.parse(readFileSync(join(OUT, 'mcp-config-as-run.json'), 'utf8'));
  const home = Object.values(asRun.mcpServers ?? {}).map((s) => s.env?.IRIS_HOME).find(Boolean);
  const cfgPath = join(tmpdir(), `iris-stranger-a8-config-${Date.now()}.json`);
  writeFileSync(cfgPath, JSON.stringify(asRun));
  const mcp2 = { d: d2, rec: { sessionId: d2.init?.session_id }, dir: d2.init?.cwd, home, cfgPath };
  if (!mcp2.dir || !mcp2.rec.sessionId || !existsSync(mcp2.dir)) throw new Error('a8 needs the connected phase\'s directory and session; run --phase mcp2 first');
  results.a8 = await phaseA8(mcp2);
  line('a8', results.a8.rec);
  if (want('a9') || PHASE === 'a8') {
    results.a9 = await phaseA9(mcp2);
    line('a9', results.a9.rec);
  }
  if (want('a10') || PHASE === 'a8') {
    results.a10 = await phaseA10(mcp2);
    line('a10', results.a10.rec);
  }
} else if (connectedConfig && (want('mcp2') || want('a8') || want('a9') || want('a10'))) {
  results.mcp2 = await phaseMcp2(connectedConfig);
  line('mcp2', results.mcp2.rec);
  results.a8 = await phaseA8(results.mcp2);
  line('a8', results.a8.rec);
  results.a9 = await phaseA9(results.mcp2);
  line('a9', results.a9.rec);
  results.a10 = await phaseA10(results.mcp2);
  line('a10', results.a10.rec);
}
if (want('http')) {
  results.http = await phaseHttp();
  line('http', results.http.rec);
}
if (want('capture')) {
  results.capture = await phaseCapture('capture');
  line('capture', results.capture.rec);
}
if (want('capture-both')) {
  if (!connectedConfig) console.warn('capture-both needs the connected config from phase mcp1 (run it first, or in the same record dir)');
  else {
    results.captureBoth = await phaseCapture('capture-both', connectedConfig);
    line('capture-both', results.captureBoth.rec);
  }
}
const rows = grade(results);
// Rows merge across runs of the same record dir, so the phases can be run
// separately (mcp1, then mcp2 + a8, then http) and graded together.
const previous = existsSync(join(OUT, 'rows.json')) ? JSON.parse(readFileSync(join(OUT, 'rows.json'), 'utf8')) : null;
const record = {
  protocol: PROTOCOL_VERSION,
  spec: PACKAGE_SPEC,
  gradedAt: new Date().toISOString(),
  model: Object.values(results).map((r) => r.rec.model).find(Boolean) ?? previous?.model ?? null,
  totalCostUsd: (previous?.totalCostUsd ?? 0) + Object.values(results).reduce((s, r) => s + (r.rec.costUsd ?? 0), 0),
  rows: { ...(previous?.rows ?? {}), ...rows },
};
writeFileSync(join(OUT, 'rows.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
