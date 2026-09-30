// What a vitest JSON report says, read for the truthbase capture
// (capture-tests.mjs), with no I/O so each rule can be tested on a report.
//
// These refuse a capture rather than record it:
//
//   - A failing test. The truthbase publishes counts from a green suite
//     only (every committed .claims.json says failed: 0), so a run with a
//     failure has no counts to record. Until 0.20.0 it was recorded, and
//     the CI truthbase job then reported "claims.json drifted from
//     generator output" and told the reader to regenerate: on main at
//     969719e one test failed during the capture (3,729 of 3,730), the
//     tree was byte-identical to a pull-request head that had passed, and
//     nothing in the log named the test. Now the refusal names each
//     failing test, its file and the first line of its failure.
//
//   - A test file that failed to load or errored at the file level: a parse
//     error, a throw at import, a failing hook outside any test. vitest's
//     JSON report lists such a file with status "failed" and no failed
//     assertion (usually none at all), and counts none of its tests: the
//     total simply drops and `numFailedTests` stays 0. A capture that read
//     only the counts once recorded a green 3,533/3,533 for a branch whose
//     otlp.test.ts no longer parsed, eleven tests short, with nothing failed.
//   - A skipped test: the counts would depend on where the capture ran
//     (.claims.json is re-derived in CI on Linux and compared).
//
// Both throw CaptureRefused, which capture-tests.mjs never swallows into a
// fallback to the committed counts.

export class CaptureRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaptureRefused';
  }
}

export function summarizeFromReport(report) {
  if (!report || typeof report !== 'object') return { total: null, passed: null, failed: null };
  return {
    total: typeof report.numTotalTests === 'number' ? report.numTotalTests : null,
    passed: typeof report.numPassedTests === 'number' ? report.numPassedTests : null,
    failed: typeof report.numFailedTests === 'number' ? report.numFailedTests : null,
  };
}

/** A report's own ANSI colouring stripped, and cut to its first line: the reason, not the code frame. */
function firstLine(message) {
  const plain = String(message ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  const line = plain.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The test files that failed without a failing test: [{ file, reason }]. A
 * file whose failure is an ordinary failed assertion is a counted failure,
 * not a load error, and is not listed.
 */
export function fileLevelFailures(report, root = '') {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  const out = [];
  for (const r of results) {
    if (r?.status !== 'failed') continue;
    const assertions = Array.isArray(r.assertionResults) ? r.assertionResults : [];
    if (assertions.some((a) => a?.status === 'failed')) continue;
    const name = String(r.name ?? '(unnamed file)');
    const file = root && name.toLowerCase().startsWith(root.toLowerCase()) ? name.slice(root.length).replace(/^[\\/]+/, '') : name;
    out.push({ file: file.split('\\').join('/'), reason: firstLine(r.message) || 'failed with no test failing' });
  }
  return out;
}

/** The tests that failed: [{ file, test, reason }], in report order. */
export function failedTests(report, root = '') {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  const out = [];
  for (const r of results) {
    const name = String(r?.name ?? '(unnamed file)');
    const file = (root && name.toLowerCase().startsWith(root.toLowerCase()) ? name.slice(root.length).replace(/^[\\/]+/, '') : name).split('\\').join('/');
    for (const a of Array.isArray(r?.assertionResults) ? r.assertionResults : []) {
      if (a?.status !== 'failed') continue;
      out.push({ file, test: String(a.fullName ?? a.title ?? '(unnamed test)'), reason: firstLine((a.failureMessages ?? [])[0]) || 'failed' });
    }
  }
  return out;
}

/**
 * Refuse a report that must not become counts. Returns the summary when it may.
 * @param {object | null} report
 * @param {{ scope?: string, root?: string, exitCode?: number }} [options] `exitCode`: the vitest run's, when this capture ran it.
 */
export function checkReport(report, { scope = 'root', root = '', exitCode } = {}) {
  const broken = fileLevelFailures(report, root);
  if (broken.length > 0) {
    throw new CaptureRefused(
      `[claims:capture-tests] ${broken.length} test file(s) in scope "${scope}" failed to load or errored outside any test, ` +
        `so their tests are missing from the count rather than failed:\n` +
        broken.map((b) => `  ${b.file}: ${b.reason}`).join('\n') +
        `\nFix the file and capture again.`,
    );
  }
  const summary = summarizeFromReport(report);
  const failing = failedTests(report, root);
  if (failing.length > 0 || (summary.failed ?? 0) > 0) {
    const count = Math.max(failing.length, summary.failed ?? 0);
    throw new CaptureRefused(
      `[claims:capture-tests] ${count} test(s) failed in scope "${scope}", so this run has no counts to record ` +
        `(the truthbase records a green suite only):\n` +
        failing.map((f) => `  ${f.file} > ${f.test}\n      ${f.reason}`).join('\n') +
        `\nFix the test, or re-run it if it is flaky and then fix the flake, and capture again.`,
    );
  }
  // A run that failed with every counted test passing and no file to name: an error vitest reports only as the outcome.
  if (report && report.success === false && summary.failed === 0) {
    throw new CaptureRefused(
      `[claims:capture-tests] the vitest run for scope "${scope}" failed (success: false) with no failing test and no failing file ` +
        `(an unhandled error outside the tests); its counts are not captured.`,
    );
  }
  /*
   * The same run as vitest really reports it: an unhandled error leaves the
   * JSON report at `success: true` with every test passed, and only the
   * process's exit code says the run failed (a capture recorded 4,016 of
   * 4,016 while CI failed on the unhandled error). A report read from a file
   * (--report) has no exit code, and this does not apply to it. vitest's JSON
   * reporter writes the error to neither the report nor its output, so the
   * refusal says where to see it.
   * A run that wrote no report is not this case: capture-tests.mjs warns and
   * keeps the committed counts for it (the CI job that cannot install the
   * dashboard relies on that).
   */
  if (typeof exitCode === 'number' && exitCode !== 0 && summary.total !== null && (summary.failed ?? 0) === 0) {
    throw new CaptureRefused(
      `[claims:capture-tests] vitest exited ${exitCode} with every counted test passing in scope "${scope}" ` +
        `(an unhandled error, or an error outside any test); its counts are not captured. ` +
        `The JSON report and its output do not carry that error: run \`npx vitest run\` in the scope to see it.`,
    );
  }
  if (summary.total !== null && summary.passed !== null && summary.failed === 0) {
    const skipped = summary.total - summary.passed;
    if (skipped > 0) {
      throw new CaptureRefused(
        `[claims:capture-tests] ${skipped} test(s) skipped in scope "${scope}" ` +
          `(${summary.passed} passed of ${summary.total}). Captured counts must be ` +
          `platform-invariant — .claims.json is re-derived in CI on Linux and compared. ` +
          `Make the test run everywhere and branch its assertions instead of skipping it.`,
      );
    }
  }
  return summary;
}
