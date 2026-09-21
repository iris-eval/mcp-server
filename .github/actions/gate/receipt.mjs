/*
 * The receipt (arc 9, N-17): what `iris-eval ingest` printed, as one
 * Markdown block — for the job summary and for the pull-request comment.
 *
 * `ingest` prints one JSON line per trace on stdout and one summary
 * sentence on stderr; it has no aggregate object, so the counts are made
 * here from the lines. Nothing the receipt carries is the agent's text:
 * trace ids, verdict bases, rule names and span labels only, the way the
 * receipt lines themselves are built.
 *
 * Env: GATE_WORK (the directory with receipts.ndjson and ingest.log),
 * GATE_EXIT_CODE, GATE_TRACES, GATE_FAIL_ON, GATE_DATASET; GITHUB_OUTPUT and
 * GITHUB_STEP_SUMMARY as the runner sets them. Exit 0 always — the verdict
 * step reads the exit code; this one only describes.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const work = process.env.GATE_WORK ?? '';
const exitCode = Number(process.env.GATE_EXIT_CODE ?? '2');
const tracesPath = process.env.GATE_TRACES ?? '';
const failOn = process.env.GATE_FAIL_ON ?? '';
const dataset = process.env.GATE_DATASET ?? '';

const read = (name) => {
  const p = join(work, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

/** The JSON lines `ingest` printed; anything else on stdout is kept aside. */
export function parseReceipts(stdout) {
  const receipts = [];
  const other = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && typeof v.trace_id === 'string') {
        receipts.push(v);
        continue;
      }
    } catch {
      /* not a receipt */
    }
    other.push(t);
  }
  return { receipts, other };
}

/** The counts and the Markdown. Pure, so a test can hand it strings. */
export function buildReceipt({ stdout, stderr, exitCode, tracesPath, failOn, dataset }) {
  const { receipts } = parseReceipts(stdout);
  const stored = receipts.length;
  const evaluated = receipts.filter((r) => typeof r.evaluation_id === 'string').length;
  const tripped = receipts.filter((r) => r.tripped !== undefined);
  const gated = dataset ? receipts.filter((r) => r.gated === true).length : evaluated;
  const bases = new Map();
  for (const r of receipts) {
    const basis = r.verdict && typeof r.verdict.basis === 'string' ? r.verdict.basis : 'stored only';
    bases.set(basis, (bases.get(basis) ?? 0) + 1);
  }
  const sentence = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\bingest: \d+ stored\b/.test(l))
    .pop();

  const lines = [];
  const title =
    exitCode === 0
      ? `### Iris gate — ${stored} stored, nothing tripped \`--fail-on ${failOn}\``
      : exitCode === 1
        ? `### Iris gate — ${tripped.length} of ${gated} tripped \`--fail-on ${failOn}\``
        : `### Iris gate — \`iris-eval ingest\` exited ${exitCode}`;
  lines.push(title, '');
  if (sentence) lines.push(`\`${sentence}\``, '');
  if (stored === 0) {
    lines.push(
      exitCode === 0
        ? `**No trace was read from \`${tracesPath}\`.** An empty file gates nothing — the job is failed here so an unwritten traces file cannot pass as green.`
        : `No trace was stored. The log above names the refusal.`,
      '',
    );
  }
  if (tripped.length > 0) {
    lines.push('| Trace | Basis | Rules | Evidence |', '|---|---|---|---|');
    for (const r of tripped) {
      const by = Array.isArray(r.verdict?.by) ? r.verdict.by.join(', ') : '';
      const spans = Array.isArray(r.spans) ? [...new Set(r.spans.map((s) => `${s.rule}: ${s.label} (${s.source} ${s.start}–${s.end})`))].join('; ') : '';
      lines.push(`| \`${r.trace_id}\` | \`${r.verdict?.basis ?? ''}\` | ${by} | ${spans || '—'} |`);
    }
    lines.push('');
  }
  if (bases.size > 0) {
    lines.push('| Verdict basis | Traces |', '|---|---|');
    for (const [basis, n] of [...bases.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`| \`${basis}\` | ${n} |`);
    lines.push('');
  }
  const unjudged = new Map();
  for (const r of receipts) if (Array.isArray(r.unjudged)) for (const q of r.unjudged) unjudged.set(q, (unjudged.get(q) ?? 0) + 1);
  if (unjudged.size > 0) {
    lines.push(`Unjudged questions: ${[...unjudged.entries()].map(([q, n]) => `\`${q}\` (${n})`).join(', ')} — a trace that did not carry what a rule needs.`, '');
  }
  lines.push(
    `<sub>\`${tracesPath}\` · ${evaluated} evaluated${dataset ? ` · dataset \`${dataset}\`: ${gated} in the gate` : ''} · exit ${exitCode} · [what the bases mean](https://github.com/iris-eval/mcp-server/blob/main/docs/ci-gate.md#--fail-on)</sub>`,
  );
  return { stored, evaluated, tripped: tripped.length, gated, markdown: lines.join('\n') + '\n', emptyGreen: stored === 0 && exitCode === 0 };
}

function main() {
  const out = buildReceipt({ stdout: read('receipts.ndjson'), stderr: read('ingest.log'), exitCode, tracesPath, failOn, dataset });
  const summaryFile = join(work, 'summary.md');
  writeFileSync(summaryFile, out.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.markdown + '\n');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [`stored=${out.stored}`, `evaluated=${out.evaluated}`, `tripped=${out.tripped}`, `gated=${out.gated}`, `summary-file=${summaryFile}`, ''].join('\n'),
    );
  }
  process.stdout.write(out.markdown);
  if (out.emptyGreen) {
    process.stdout.write('::error::Iris gate: no trace was read; an empty traces file gates nothing\n');
    process.exitCode = 1;
  }
}

if (process.env.GATE_RECEIPT_IMPORTED !== '1') main();
