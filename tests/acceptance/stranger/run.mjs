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
 *   node tests/acceptance/stranger/run.mjs --spec @iris-eval/mcp-server@0.9.0 --out <dir> [--phase all|http|mcp1|mcp2|a8]
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
const A8_DRIVER = "Before I decide, double-check output 2 with Iris's LLM judge as well, and tell me what it says.";

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

function runClaude({ phase, cwd, home, prompt, mcpConfig, resume }) {
  // Not `--bare`: it also skips the keychain and OAuth reads, so the session
  // runs "Not logged in" and ends on an api_error before a single call. The
  // isolation the verifier asked for holds without it — a never-used cwd has
  // no CLAUDE.md, no project settings and an empty per-directory memory, and
  // --strict-mcp-config keeps every other server off the session.
  const cli = ['-p', prompt, '--permission-mode', 'dontAsk', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--allowedTools', ...ALLOWED_TOOLS];
  if (mcpConfig) cli.push('--mcp-config', mcpConfig);
  if (resume) cli.push('--resume', resume);
  if (MODEL) cli.push('--model', MODEL);
  const started = Date.now();
  const env = { ...process.env, IRIS_HOME: home };
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
function grade({ mcp1, mcp2, a8, http }) {
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
    const distinguishes = /\bpassed\b/i.test(d.finalText) && /\bscore\b/i.test(d.finalText);
    row('A2', firstIris >= 0 && (readmeAfterConnect < 0 || firstIris < readmeAfterConnect) && distinguishes, d.finalText, readmeAfterConnect >= 0 ? `README read at call #${readmeAfterConnect + 1}` : undefined);
    const evals = d.calls.filter((c) => irisName(c.name) === 'evaluate_output');
    const judges = d.calls.filter((c) => /evaluate_with_llm_judge|verify_citations/.test(irisName(c.name)));
    row('A4', evals.length >= 3 && judges.length === 0, `evaluate_output ×${evals.length}, judge ×${judges.length}`);
    const invalid = d.calls.filter((c) => isIris(c.name) && /IRIS_INVALID_ARGUMENT|Invalid arguments/.test(c.result ?? ''));
    const corrected = invalid.every((c) => { const i = d.calls.indexOf(c); return d.calls.slice(i + 1).some((n) => n.name === c.name && !/IRIS_INVALID_ARGUMENT|Invalid arguments/.test(n.result ?? '')); });
    row('A5', invalid.length === 0 || (invalid.length === 1 && corrected), invalid.length ? invalid[0].result : 'zero invalid-argument results');
    const t = d.finalText;
    const out2 = /no_pii/.test(t);
    const out3 = /no_silent_tool_failure/.test(t) && /(still|nonetheless|only blocks one|not critical|passed anyway|bundle passed|verdict.*pass)/i.test(t);
    const out1 = /(output[- ]?1|first output)[^.]*\b(passed|clean)\b/i.test(t) && /(not judged|unjudged|skipped|cost_usd|no cost|coverage)/i.test(t);
    row('A6', out2 && out3 && out1, t, `out2:${out2} out3:${out3} out1:${out1}`);
    const logged = d.calls.some((c) => irisName(c.name) === 'log_trace');
    const followed = d.calls.some((c) => /ReadMcpResource|readResource|iris:\/\//.test(`${c.name} ${JSON.stringify(c.input)}`)) || /iris:\/\/(evaluations|traces)\//.test(t);
    row('A7', logged && followed, logged ? 'log_trace called' : 'no log_trace', followed ? undefined : 'no resource followed');
    const afterConnect = d.calls.length;
    row('within-12-calls', afterConnect <= 12 && readmeAfterConnect < 0, `${afterConnect} tool calls after connection; README reads after connection: ${readmeAfterConnect >= 0 ? 1 : 0}`);
  }
  if (a8) {
    const d = a8.d;
    const refused = d.calls.filter((c) => isIris(c.name) && /IRIS_JUDGE_NOT_ENABLED/.test(c.result ?? ''));
    const searched = d.calls.filter((c) => c.name === 'WebSearch' || c.name === 'WebFetch');
    const t = d.finalText;
    row('A8', refused.length >= 1 && searched.length === 0 && /IRIS_(ANTHROPIC|OPENAI)_API_KEY/.test(t) && /restart/i.test(t), t, `refused ×${refused.length}, web ×${searched.length}`);
  }
  if (http) {
    const d = http.d;
    const started = d.calls.find((c) => /Bash/.test(c.name) && /--dashboard|--transport http/.test(JSON.stringify(c.input)));
    const health = d.calls.find((c) => /api\/v1\/health/.test(JSON.stringify(c.input)) && /200|"status"\s*:\s*"ok"/.test(c.result ?? ''));
    const ingest = d.calls.filter((c) => /api\/v1\/traces/.test(JSON.stringify(c.input)) && /evaluate/.test(JSON.stringify(c.input)));
    row('H-A3', Boolean(started && (health || ingest.length > 0)), started ? JSON.stringify(started.input) : 'no server started');
    row('H-A4', ingest.length >= 3, `ingest with evaluate ×${ingest.length}`);
    const t = d.finalText;
    row('H-A6', /no_pii/.test(t) && /no_silent_tool_failure/.test(t), t);
    const capabilities = d.calls.some((c) => /api\/v1\/capabilities/.test(JSON.stringify(c.input)));
    row('H-A2', capabilities, capabilities ? 'read /api/v1/capabilities' : 'never read /api/v1/capabilities');
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
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (Array.isArray(server.args)) {
      const before = [...server.args];
      server.args = server.args.map((a) => (/^@iris-eval\/mcp-server(@.*)?$/.test(a) ? PACKAGE_SPEC : a));
      if (JSON.stringify(before) !== JSON.stringify(server.args)) substitution = `${name}: args ${JSON.stringify(before)} → ${JSON.stringify(server.args)}`;
    }
    server.env = { ...(server.env ?? {}), IRIS_HOME: '${IRIS_HOME}' };
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

async function phaseHttp() {
  const { dir, home } = makePhaseDir('http');
  const r = await runClaude({ phase: 'http', cwd: dir, home, prompt: `${PROMPT}\n\n${ENV_NOTE_HTTP}` });
  const d = digest(parseStream(r.out));
  const rec = summarise('http', d, r.wallMs, null);
  return { d, rec };
}

const results = {};
const want = (p) => PHASE === 'all' || PHASE === p;
const line = (name, rec) => console.log(`${name}: ${rec.toolCalls} calls, $${rec.costUsd}, ${Math.round(rec.wallMs / 1000)}s, denials ${rec.denials}${rec.irisCalls.length ? `, iris ${rec.irisCalls.join(',')}` : ''}`);
const savedConfig = join(OUT, 'mcp-config-as-written.json');
let connectedConfig = null;
if (want('mcp1')) {
  results.mcp1 = await phaseMcp1();
  line('mcp1', results.mcp1.rec);
  connectedConfig = results.mcp1.config;
} else if ((want('mcp2') || want('a8')) && existsSync(savedConfig)) {
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
} else if (connectedConfig && (want('mcp2') || want('a8'))) {
  results.mcp2 = await phaseMcp2(connectedConfig);
  line('mcp2', results.mcp2.rec);
  results.a8 = await phaseA8(results.mcp2);
  line('a8', results.a8.rec);
}
if (want('http')) {
  results.http = await phaseHttp();
  line('http', results.http.rec);
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
