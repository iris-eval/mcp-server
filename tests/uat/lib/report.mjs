/*
 * Check recorder + markdown report writer.
 *
 * A check never throws out of the recorder: a thrown assertion becomes a
 * ✗ row with the message as evidence, and the run continues. That is the
 * whole point of a UAT harness — one broken surface must not hide the
 * state of the other twenty.
 */

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function oneLine(s, max = 400) {
  const flat = String(s).replace(/[\r\n]+/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function createRecorder() {
  /** @type {{suite:string,id:string,name:string,ok:boolean,evidence:string,ms:number}[]} */
  const rows = [];
  const suiteTitles = new Map();
  let current = 'X';

  function record(suite, id, name, ok, evidence, ms) {
    rows.push({ suite, id, name, ok, evidence: oneLine(evidence), ms });
    const mark = ok ? '✓' : '✗';
    const tail = evidence ? ` :: ${oneLine(evidence, 200)}` : '';
    process.stdout.write(`  ${mark} ${id}  ${name}${tail}\n`);
  }

  return {
    rows,
    suiteTitles,
    beginSuite(id, title) {
      current = id;
      suiteTitles.set(id, title);
      process.stdout.write(`\n=== Suite ${id} — ${title} ===\n`);
    },
    /**
     * Run one check. `fn` may return a string, which becomes the
     * evidence shown next to a ✓ (useful for measured values).
     */
    async check(id, name, fn) {
      const t0 = Date.now();
      try {
        const ev = await fn();
        record(current, id, name, true, typeof ev === 'string' ? ev : '', Date.now() - t0);
      } catch (err) {
        record(current, id, name, false, err && err.message ? err.message : String(err), Date.now() - t0);
      }
    },
    /** Record a failure directly (e.g. a whole suite could not start). */
    fail(id, name, evidence) {
      record(current, id, name, false, evidence, 0);
    },
    /** Record a pass directly. */
    pass(id, name, evidence = '') {
      record(current, id, name, true, evidence, 0);
    },
    counts() {
      const bySuite = new Map();
      for (const r of rows) {
        const c = bySuite.get(r.suite) ?? { pass: 0, fail: 0 };
        if (r.ok) c.pass += 1;
        else c.fail += 1;
        bySuite.set(r.suite, c);
      }
      const pass = rows.filter((r) => r.ok).length;
      return { bySuite, pass, fail: rows.length - pass, total: rows.length };
    },
  };
}

export function renderReport(recorder, meta) {
  const { bySuite, pass, fail, total } = recorder.counts();
  const lines = [];
  const verdict = fail === 0 ? 'PASS' : 'FAIL';

  lines.push('# Iris UAT Report');
  lines.push('');
  lines.push(`**Result: ${verdict} — ${pass} passed / ${fail} failed / ${total} checks**`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Run started | ${meta.startedAt} |`);
  lines.push(`| Duration | ${(meta.durationMs / 1000).toFixed(1)}s |`);
  lines.push(`| Repo | \`${meta.repo}\` |`);
  lines.push(`| Branch | \`${meta.branch}\` |`);
  lines.push(`| Commit | \`${meta.commit}\` |`);
  lines.push(`| Working tree | ${meta.dirty ? `DIRTY (${meta.dirtyCount} file(s))` : 'clean'} |`);
  lines.push(`| Package version | ${meta.pkgVersion} |`);
  lines.push(`| Node | ${meta.node} |`);
  lines.push(`| Platform | ${meta.platform} |`);
  lines.push(`| Real ~/.iris guard | ${meta.guardVerdict} |`);
  lines.push('');

  if (meta.buildNotes && meta.buildNotes.length > 0) {
    lines.push('Artifacts rebuilt before the run (both write only into `dist/`):');
    lines.push('');
    for (const n of meta.buildNotes) lines.push(`- ${n}`);
    lines.push('');
  }

  lines.push('## Per-suite totals');
  lines.push('');
  lines.push('| Suite | Surface | Pass | Fail |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const [id, title] of recorder.suiteTitles) {
    const c = bySuite.get(id) ?? { pass: 0, fail: 0 };
    lines.push(`| ${id} | ${title} | ${c.pass} | ${c.fail} |`);
  }
  lines.push(`| **All** | | **${pass}** | **${fail}** |`);
  lines.push('');

  const failures = recorder.rows.filter((r) => !r.ok);
  if (failures.length > 0) {
    lines.push('## Findings (failed checks)');
    lines.push('');
    for (const r of failures) {
      lines.push(`- ✗ **${r.id} — ${r.name}**`);
      lines.push(`  - ${r.evidence || '(no evidence captured)'}`);
    }
    lines.push('');
  }

  lines.push('## All checks');
  lines.push('');
  for (const [id, title] of recorder.suiteTitles) {
    lines.push(`### Suite ${id} — ${title}`);
    lines.push('');
    for (const r of recorder.rows.filter((x) => x.suite === id)) {
      const mark = r.ok ? '✓' : '✗';
      const ev = r.evidence ? ` — ${r.evidence}` : '';
      lines.push(`- ${mark} \`${r.id}\` ${r.name}${ev}`);
    }
    lines.push('');
  }

  if (meta.guardDetail && meta.guardDetail.length > 0) {
    lines.push('## Real ~/.iris integrity');
    lines.push('');
    for (const line of meta.guardDetail) lines.push(`- ${line}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Re-run with:');
  lines.push('');
  lines.push('```bash');
  lines.push(`node "${meta.runCommandPath}"`);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}
