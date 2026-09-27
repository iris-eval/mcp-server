// What a vitest JSON report says, read for the truthbase capture
// (capture-tests.mjs), with no I/O so each rule can be tested on a report.
//
// Two things refuse a capture rather than record it:
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

/** Refuse a report that must not become counts. Returns the summary when it may. */
export function checkReport(report, { scope = 'root', root = '' } = {}) {
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
  // A run that failed with every counted test passing and no file to name: an error vitest reports only as the outcome.
  if (report && report.success === false && summary.failed === 0) {
    throw new CaptureRefused(
      `[claims:capture-tests] the vitest run for scope "${scope}" failed (success: false) with no failing test and no failing file ` +
        `(an unhandled error outside the tests); its counts are not captured.`,
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
