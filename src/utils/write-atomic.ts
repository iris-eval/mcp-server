import { mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/*
 * Atomic file write: write a temp file, then rename it over the target.
 *
 * This lives in one place because it was duplicated verbatim in
 * preferences.ts and custom-rule-store.ts, and both copies carried the same
 * two Windows bugs.
 *
 * 1. The temp path was `${targetPath}.tmp.${process.pid}` — keyed on the
 *    PROCESS, not the call. Two concurrent writes to the same target inside
 *    one process (which is exactly what a vitest file does) therefore raced
 *    on a single temp path: one call renamed it away while the other was
 *    still writing, and the loser got
 *      EPERM: operation not permitted, rename '...preferences.json.tmp.38468'
 *    Observed twice in one session, on different suites. A random suffix
 *    makes each call's temp file its own.
 *
 * 2. Even with unique names, Windows can briefly deny a rename while a
 *    virus scanner or indexer holds the file. POSIX rename() has no such
 *    behaviour, so this never reproduces on CI. A few short retries turn a
 *    transient lock into a small delay instead of a lost write.
 *
 * The retry is deliberately narrow: only the error codes Windows raises for
 * transient sharing violations. Anything else (ENOSPC, EROFS, a bad path)
 * still throws immediately rather than being retried into a slow failure.
 */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_ATTEMPTS = 5;

/*
 * Owner-only (0600). These files hold agent inputs and outputs verbatim —
 * and a tool whose job is detecting PII necessarily stores the PII it found.
 * Node's default is 0666 before umask, so a typical umask leaves them 0644:
 * world-readable to every local account on a shared POSIX host. The mode is
 * a no-op on Windows (ACL inheritance governs there), which is exactly why
 * local testing never surfaces it.
 *
 * Set at creation on the temp file, so the bytes are never briefly readable
 * between write and chmod; rename preserves the mode.
 */
export const OWNER_ONLY_FILE_MODE = 0o600;

/*
 * Narrow an EXISTING file to owner-only. Two cases need this, because a mode
 * passed at write time only applies when the write creates the file:
 *   - files written before this change (every install that predates it),
 *   - files a library creates for us (better-sqlite3 opens iris.db, and WAL
 *     mode adds iris.db-wal / iris.db-shm on first write).
 * Best-effort by design: a missing file, a read-only mount, or a
 * non-POSIX filesystem must never take the server down over permissions.
 */
export function ensureOwnerOnly(...paths: string[]): void {
  for (const p of paths) {
    try {
      if (existsSync(p)) chmodSync(p, OWNER_ONLY_FILE_MODE);
    } catch {
      // Best effort — see above.
    }
  }
}

function sleepSync(ms: number): void {
  // Synchronous by necessity — writeAtomic is sync, and making it async
  // would ripple through every caller for a Windows-only edge case.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeAtomic(targetPath: string, contents: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, contents, { encoding: 'utf-8', mode: OWNER_ONLY_FILE_MODE });

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      renameSync(tmp, targetPath);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_RENAME_ERRORS.has(code)) break;
      sleepSync(10 * (attempt + 1));
    }
  }

  // Don't leave the temp file behind on a genuine failure — a stray
  // `preferences.json.tmp.1234.ab12cd` next to the real file is confusing
  // and never cleaned up otherwise.
  try {
    unlinkSync(tmp);
  } catch {
    // Best effort; the original error is the one worth reporting.
  }
  throw lastError;
}
