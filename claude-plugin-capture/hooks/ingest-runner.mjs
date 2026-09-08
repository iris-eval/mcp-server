// The ingest runner — what the Stop hook detaches in its place.
//
// 0.13.0's Stop hook spawned `npx … ingest` itself, detached, with the trace
// on a stdin pipe and stderr on another pipe, and exited a millisecond later.
// The stranger's capture run on the published package found the result:
// the ingest died with the hook's pipes and no trace ever landed, while the
// same command with the hook waiting (IRIS_CAPTURE_WAIT=1) stored and
// evaluated the turn. A detached child must own nothing of its parent's.
//
// So the hook writes the trace to a file and detaches THIS script with every
// stdio ignored (a shape measured to survive the host's hook exit). This
// script then runs each ingest candidate synchronously with `--file`, treats
// exit 0 alone as success (ingest exits 0 when stored, 2 on usage or nothing
// stored; 1 is reserved for --fail-on, which the hook never passes), logs
// the outcome to capture.log, and removes the file on success. A payload
// that could not be ingested stays under pending/ as the evidence.
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { log, pinnedVersion } from './common.mjs';

const INGEST_ARGS = ['ingest', '--evaluate', '--redact', 'critical_spans', '--source', 'hook'];

/** The commands to try, in order; the first to exit 0 wins. */
export function candidates(file) {
  // Tests point this at the repo's own entry point (a JSON argv, so a path
  // with a space survives); users get the published package.
  const override = process.env.IRIS_CAPTURE_INGEST_ARGV;
  if (override) {
    const parts = JSON.parse(override);
    return [{ cmd: parts[0], args: [...parts.slice(1), ...INGEST_ARGS, '--file', file], shell: false }];
  }
  const version = pinnedVersion();
  // On Windows npx is a .cmd shim, which Node refuses to spawn without a
  // shell; the file path is quoted for it. Every other argument is our own
  // literal or the pinned version.
  const shell = process.platform === 'win32';
  const quoted = shell ? `"${file}"` : file;
  return [
    { cmd: 'npx', args: ['--no-install', '@iris-eval/mcp-server', ...INGEST_ARGS, '--file', quoted], shell },
    { cmd: 'npx', args: ['-y', version ? `@iris-eval/mcp-server@${version}` : '@iris-eval/mcp-server', ...INGEST_ARGS, '--file', quoted], shell },
  ];
}

export function ingestFile(file) {
  let last = null;
  for (const c of candidates(file)) {
    const r = spawnSync(c.cmd, c.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: c.shell,
      encoding: 'utf8',
      timeout: 180_000,
    });
    last = { cmd: `${c.cmd} ${c.args[0]}`, ok: r.status === 0, status: r.status, why: (r.error?.message ?? r.stderr ?? '').trim().slice(-300) };
    if (last.ok) break;
  }
  return last;
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname.endsWith(basename(process.argv[1]));
if (invokedDirectly) {
  const file = process.argv[2];
  if (!file || !existsSync(file)) {
    log(`ingest runner: no payload at ${file ?? '(none)'}`);
    process.exit(2);
  }
  const result = ingestFile(file);
  if (result?.ok) {
    try {
      unlinkSync(file);
    } catch {
      /* the evidence of a stored turn is the trace itself */
    }
    log(`ingest: stored ${basename(file)} via ${result.cmd}`);
    process.exit(0);
  }
  log(`ingest failed — ${result?.cmd ?? 'no candidate'} exit ${result?.status ?? '?'}: ${result?.why ?? 'unknown'}; payload kept at ${file}`);
  process.exit(1);
}
