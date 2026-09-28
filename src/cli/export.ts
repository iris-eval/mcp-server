/*
 * `iris-eval export` — every trace or evaluation a filter admits, as CSV or
 * JSON Lines, to stdout or a file (#4).
 *
 * The dashboard's export needs the dashboard running, and it is off by
 * default; this is the same export with no server, for a script, a cron
 * job or a CI step that archives what it stored. It is not a second
 * implementation: the flags are the query parameters of
 * GET /api/v1/{traces,evaluations}/export, validated by the same schemas,
 * read by the same storage method and written by the same encoder, so the
 * bytes match the download's.
 *
 * Exit codes: 0 written, 1 the export failed part-way (a partial --out
 * file is deleted, never left looking complete), 2 usage.
 */
import { createWriteStream, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { createStorage } from '../storage/index.js';
import { traceExportQuerySchema, evalExportQuerySchema } from '../dashboard/validation.js';
import { searchOf } from '../tools/get-traces.js';
import { evalEncoder, traceEncoder } from '../export/format.js';
import { writeExport } from '../export/stream.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { COMMAND } from '../identity.js';

/** The filter flags of each kind: the export endpoint's query parameters, hyphenated. */
const FILTERS = {
  traces: ['agent-name', 'framework', 'session', 'q', 'since', 'until', 'min-score', 'max-score', 'sort-by', 'sort-order'],
  evaluations: ['eval-type', 'passed', 'since', 'until'],
} as const;

export const EXPORT_USAGE = `Usage: ${COMMAND} export traces|evaluations --format csv|jsonl [--out <file>] [filters]

Writes every trace or evaluation the filters admit, in the order the dashboard
lists them, to stdout or --out. The same export as the dashboard's Export button
and GET /api/v1/traces/export: CSV (UTF-8 with a byte-order mark, for
spreadsheets) or JSON Lines (one record per line, for programs).

  --format <csv|jsonl>   Required
  --out <file>           Write here instead of stdout; deleted if the export fails part-way
  --config <path>        Config file (default: ~/.iris/config.json)
  --db-path <path>       SQLite database (default: ~/.iris/iris.db)

Trace filters:       --agent-name --framework --session --q <search text> --since --until
                     --min-score --max-score --sort-by --sort-order
Evaluation filters:  --eval-type --passed true|false --since --until

Exit codes: 0 written, 1 the export failed part-way, 2 usage.
`;

export interface ExportCliIo {
  stdout: Writable;
  stderr: Writable;
}

export async function runExport(argv: string[], io: ExportCliIo): Promise<number> {
  const usage = (message: string): number => {
    io.stderr.write(`${COMMAND} export: ${message}\nRun \`${COMMAND} export --help\` for usage.\n`);
    return 2;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        format: { type: 'string' },
        out: { type: 'string' },
        config: { type: 'string' },
        'db-path': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        ...Object.fromEntries([...new Set([...FILTERS.traces, ...FILTERS.evaluations])].map((f) => [f, { type: 'string' as const }])),
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    return usage((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(EXPORT_USAGE);
    return 0;
  }
  const kind = positionals[0];
  if (positionals.length !== 1 || (kind !== 'traces' && kind !== 'evaluations')) {
    return usage('say what to export: traces or evaluations.');
  }
  const foreign = Object.keys(values).filter((k) => (FILTERS[kind === 'traces' ? 'evaluations' : 'traces'] as readonly string[]).includes(k) && !(FILTERS[kind] as readonly string[]).includes(k));
  if (foreign.length > 0) {
    return usage(`${foreign.map((f) => `--${f}`).join(', ')} filter${foreign.length === 1 ? 's' : ''} ${kind === 'traces' ? 'evaluations' : 'traces'}, not ${kind}.`);
  }

  // The flags as the endpoint's query: the same schema refuses the same values with the same sentences.
  const query: Record<string, string> = {};
  for (const flag of ['format', ...FILTERS[kind]]) {
    const value = (values as Record<string, string | boolean | undefined>)[flag];
    if (typeof value === 'string') query[flag.replace(/-/g, '_')] = value;
  }
  const schema = kind === 'traces' ? traceExportQuerySchema : evalExportQuerySchema;
  const checked = schema.safeParse(query);
  if (!checked.success) {
    return usage(checked.error.issues.map((i) => `--${String(i.path[0] ?? 'format').replace(/_/g, '-')}: ${i.message}`).join('; '));
  }

  const config = loadConfig({ config: values.config as string | undefined, dbPath: values['db-path'] as string | undefined });
  const storage = createStorage(config);
  await storage.initialize();
  const out: Writable = typeof values.out === 'string' ? createWriteStream(values.out) : io.stdout;
  // A reader that stops reading (`| head`) ends the export quietly, as any Unix filter does.
  let closed = false;
  out.on('error', () => {
    closed = true;
  });

  let written = 0;
  let failure: unknown;
  try {
    if (kind === 'traces') {
      const q = checked.data as z.infer<typeof traceExportQuerySchema>;
      const search = searchOf(q.q);
      const batches = storage.exportTraces(LOCAL_TENANT, {
        ...(search !== undefined ? { search } : {}),
        filter: { agent_name: q.agent_name, framework: q.framework, session_id: q.session, since: q.since, until: q.until, min_score: q.min_score, max_score: q.max_score },
        ...(q.sort_by !== undefined ? { sort_by: q.sort_by } : {}),
        sort_order: q.sort_order,
      });
      written = await writeExport(out, traceEncoder(q.format), batches, () => closed);
    } else {
      const q = checked.data as z.infer<typeof evalExportQuerySchema>;
      const batches = storage.exportEvalResults(LOCAL_TENANT, { eval_type: q.eval_type, passed: q.passed, since: q.since, until: q.until });
      written = await writeExport(out, evalEncoder(q.format), batches, () => closed);
    }
  } catch (err) {
    failure = err;
  } finally {
    await storage.close();
  }

  if (typeof values.out === 'string') {
    await new Promise<void>((resolve) => out.end(resolve));
    if (failure !== undefined || closed) {
      rmSync(values.out, { force: true });
      io.stderr.write(`${COMMAND} export: failed after ${written} ${kind}; ${values.out} was deleted. ${failure instanceof Error ? failure.message : ''}\n`);
      return 1;
    }
    io.stderr.write(`${COMMAND} export: ${written} ${kind} written to ${values.out}\n`);
    return 0;
  }
  if (failure !== undefined) {
    io.stderr.write(`${COMMAND} export: failed after ${written} ${kind}: ${failure instanceof Error ? failure.message : String(failure)}\n`);
    return 1;
  }
  return 0;
}
