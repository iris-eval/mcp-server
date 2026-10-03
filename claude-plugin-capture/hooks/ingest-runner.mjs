// The ingest runner — what the hooks detach in their place.
//
// 0.13.0's Stop hook spawned `npx … ingest` itself, detached, with the trace
// on a stdin pipe and stderr on another pipe, and exited a millisecond later.
// The stranger's capture run on the published package found the result:
// the ingest died with the hook's pipes and no trace ever landed, while the
// same command with the hook waiting (IRIS_CAPTURE_WAIT=1) stored and
// evaluated the turn. A detached child must own nothing of its parent's.
//
// So a hook writes each part to a file and detaches THIS script with every
// stdio ignored (a shape measured to survive the host's hook exit), naming
// the new file and any older ones whose ingest failed, to retry. For each
// file this script takes it (renames it, so two runners never ingest one part
// twice), runs each ingest candidate synchronously with `--file`, treats exit
// 0 alone as success (ingest exits 0 when stored, 2 on usage or nothing
// stored; 1 is reserved for --fail-on, which is never passed), logs the
// outcome to capture.log, and removes the file on success. A part that could
// not be ingested goes back under its own name, to be retried by a later Stop
// until it is older than the pending limit. A part whose name ends
// `.noeval.json` is stored without being judged.
//
// Before a part is ingested it is fitted to the release that will read it
// (fitToServer): a field that release does not know would make its strict
// ingest schema refuse the whole part, so the field is left out instead.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { log, pinnedVersion } from './common.mjs';

/**
 * The first release whose ingest reads a trace's `capture` (the declaration of
 * who recorded the turn and what it holds in full). An earlier release refuses
 * any key it does not know, so a part sent to one leaves `capture` out: the
 * turn is stored and judged, without the declaration.
 */
export const CAPTURE_SINCE = '0.20.0';

/** Whether `version` (a pinned release, a pre-release included) reads `capture`. An unknown pin is treated as one that does not. */
export function readsCapture(version) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')?.slice(1, 4).map(Number);
  const have = parse(version);
  const since = parse(CAPTURE_SINCE);
  if (!have) return false;
  for (let i = 0; i < 3; i += 1) if (have[i] !== since[i]) return have[i] > since[i];
  return true;
}

/**
 * Fit a part to the release that will ingest it. Parts written before this
 * runner knew to fit them, and kept for retry, are fitted the same way when
 * they are retried. The repository's own entry point (IRIS_CAPTURE_INGEST_ARGV,
 * in tests) reads every field this plugin writes, so its parts are sent whole.
 */
export function fitToServer(file, version = pinnedVersion()) {
  if (process.env.IRIS_CAPTURE_INGEST_ARGV || readsCapture(version)) return;
  try {
    const trace = JSON.parse(readFileSync(file, 'utf8'));
    if (trace === null || typeof trace !== 'object' || !('capture' in trace)) return;
    delete trace.capture;
    writeFileSync(file, JSON.stringify(trace));
  } catch {
    /* an unreadable part fails at ingest and is kept for retry, as before */
  }
}

export const INGEST_ARGS = ['ingest', '--redact', 'critical_spans', '--source', 'hook'];

/** The commands to try, in order; the first to exit 0 wins. */
export function candidates(file, evaluate = true) {
  const args = [...INGEST_ARGS, ...(evaluate ? ['--evaluate'] : [])];
  // Tests point this at the repo's own entry point (a JSON argv, so a path
  // with a space survives); users get the published package.
  const override = process.env.IRIS_CAPTURE_INGEST_ARGV;
  if (override) {
    const parts = JSON.parse(override);
    return [{ cmd: parts[0], args: [...parts.slice(1), ...args, '--file', file], shell: false }];
  }
  const version = pinnedVersion();
  // On Windows npx is a .cmd shim, which Node refuses to spawn without a
  // shell; the file path is quoted for it. Every other argument is our own
  // literal or the pinned version.
  const shell = process.platform === 'win32';
  const quoted = shell ? `"${file}"` : file;
  // Both candidates name the pinned version: the first takes it from npx's
  // cache without installing, the second installs it. An unpinned first
  // candidate ran whatever version happened to be cached, older or newer
  // than the plugin that recorded the turn.
  const pkg = version ? `@iris-eval/mcp-server@${version}` : '@iris-eval/mcp-server';
  return [
    { cmd: 'npx', args: ['--no-install', pkg, ...args, '--file', quoted], shell },
    { cmd: 'npx', args: ['-y', pkg, ...args, '--file', quoted], shell },
  ];
}

export function ingestFile(file, evaluate = true) {
  let last = null;
  for (const c of candidates(file, evaluate)) {
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
  const files = process.argv.slice(2);
  if (files.length === 0) {
    log('ingest runner: no payload named');
    process.exit(2);
  }
  let failed = 0;
  for (const file of files) {
    const taken = `${file}.${process.pid}.taking`;
    try {
      renameSync(file, taken);
    } catch {
      // Another runner has it, or it is gone: not this runner's to ingest.
      if (!existsSync(file)) continue;
      log(`ingest runner: could not take ${basename(file)}`);
      failed += 1;
      continue;
    }
    fitToServer(taken);
    const result = ingestFile(taken, !file.endsWith('.noeval.json'));
    if (result?.ok) {
      try {
        unlinkSync(taken);
      } catch {
        /* the evidence of a stored part is the trace itself */
      }
      log(`ingest: stored ${basename(file)} via ${result.cmd}`);
      continue;
    }
    failed += 1;
    try {
      renameSync(taken, file);
    } catch {
      /* left under its taken name; the pending limit removes it */
    }
    log(`ingest failed — ${result?.cmd ?? 'no candidate'} exit ${result?.status ?? '?'}: ${result?.why ?? 'unknown'}; payload kept at ${file}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}
