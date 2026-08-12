/*
 * Real-home integrity guard.
 *
 * Every iris process the harness spawns gets an IRIS_HOME under the
 * scratch dir. That intent is worth nothing unless it is MEASURED, so
 * the founder's real ~/.iris is content-hashed before and after the run.
 * Any change to a guarded file fails the harness outright — a UAT run
 * that quietly ate the user's live trace database would be worse than no
 * UAT run at all (that exact class of bug is why tests/setup/iris-home.ts
 * exists in the repo).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GUARDED_FILES, REAL_IRIS_HOME } from './env.mjs';

const ABSENT = 'ABSENT';

export function snapshotRealHome() {
  const snap = {};
  for (const name of GUARDED_FILES) {
    const p = join(REAL_IRIS_HOME, name);
    if (!existsSync(p)) {
      snap[name] = ABSENT;
      continue;
    }
    try {
      const buf = readFileSync(p);
      const st = statSync(p);
      snap[name] = `${createHash('sha256').update(buf).digest('hex')}:${st.size}`;
    } catch (err) {
      snap[name] = `UNREADABLE:${err.code ?? err.message}`;
    }
  }
  return snap;
}

/** @returns {{changed:string[], detail:string[]}} */
export function diffSnapshots(before, after) {
  const changed = [];
  const detail = [];
  for (const name of GUARDED_FILES) {
    const b = before[name];
    const a = after[name];
    if (b === a) {
      detail.push(`unchanged \`${name}\` — ${b === ABSENT ? 'absent before and after' : `sha256 ${b.slice(0, 16)}…`}`);
    } else {
      changed.push(name);
      detail.push(`**CHANGED** \`${name}\` — before \`${b}\` / after \`${a}\``);
    }
  }
  return { changed, detail };
}
